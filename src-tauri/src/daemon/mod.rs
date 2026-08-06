//! Daemon-side modules. The binary at `src/bin/cc_conductor_daemon.rs`
//! consumes these via the `claude_conductor_lib` library crate.

pub mod broadcast;
pub mod channel_adopt;
pub mod claude_config;
pub mod channels;
pub mod detector_task;
pub mod device_registry;
pub mod frame;
pub mod handshake;
pub mod health;
pub mod hooks_server;
pub mod idle;
pub mod instance;
pub mod iroh_tunnel;
pub mod jarvis_wake;
pub mod jsonl_tail;
pub mod lifecycle;
pub mod lockfile;
pub mod methods;
pub mod notifier;
pub mod preview;
pub mod pump;
pub mod push;
pub mod rate_limit;
mod remote_handlers;
mod remote_pairing;
mod remote_push;
pub mod remote_server;
mod remote_voice;
pub mod repo_channel_wake;
pub mod rpc;
pub mod schedule;
mod schedule_fire;
pub mod session;
pub(crate) mod session_registration;
pub mod settings_cache;
pub mod spawn_self;
pub mod state;
pub mod stt;
pub mod transport_common;

#[cfg(windows)]
pub mod transport_windows;
#[cfg(unix)]
pub mod transport_unix;

use crate::daemon::lockfile::LockGuard;
use crate::daemon::rpc::Router;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::Settings;
use std::path::PathBuf;

fn app_data_dir() -> PathBuf {
    let mut p = dirs::data_dir().expect("data_dir");
    p.push("claude-conductor");
    p
}

fn load_initial_settings() -> Settings {
    // Best-effort load. If settings.json is missing / unparseable, the daemon
    // starts with Settings::default(); the app pushes its authoritative copy on
    // connect via `set_settings`.
    let Ok(path) = crate::settings::paths::settings_file() else { return Settings::default() };
    crate::settings::load(&path)
}

/// Kill every live session's process tree. Shared by the two shutdown paths
/// that both need to reap in-flight chat children: the main loop's Ctrl-C /
/// `shutdown_daemon`-notify exit below, and the `shutdown_daemon` RPC handler
/// (`daemon/methods/lifecycle.rs`). Without this, a session with a turn still
/// in flight leaves its `claude` child (and subprocess tree) orphaned - there
/// is no pump task left to reap it once the daemon process is gone.
pub fn kill_all_sessions(state: &DaemonState) {
    for entry in state.sessions.iter() {
        crate::channels::kill::kill_tree(entry.pid);
    }
}

/// Daemon process entry. Called by the standalone `cc-conductor-daemon` bin
/// (used by the daemon e2e tests) and by the app binary when launched with
/// `--daemon`. Assumes a Tokio multi-thread runtime is already active.
pub async fn run_daemon_main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let app_data = app_data_dir();
    std::fs::create_dir_all(&app_data)?;
    // Instance-suffixed lockfile so a test daemon (CC_DAEMON_INSTANCE set)
    // never reclaims the production daemon's lock (ai_todo 71).
    let lock_path = app_data.join(format!("daemon{}.lock", instance::instance_suffix()));
    let _lock = LockGuard::acquire(lock_path)?;
    // ai_todo 228 diagnostics: if a duplicate daemon process is momentarily
    // alive (ai_todo 151's crash-loop scenario) and both write to the same
    // log file, this pid lets the next investigation tell the lines apart.
    log::info!("daemon: started, pid={}", std::process::id());

    let initial_settings = load_initial_settings();
    let settings_cache = SettingsCache::new(initial_settings);

    // The daemon opens its OWN connection to the shared companion.db (the app
    // owns the one-time JSONL->DB migration; the daemon only writes new rows).
    // WAL + busy_timeout in storage::db::open_db let both processes coordinate.
    // Best-effort: a failure to open must not abort the daemon (hooks, chat,
    // channels all still work), so log and run without DB-backed token/skill
    // persistence rather than exiting.
    let db = match crate::settings::paths::companion_db()
        .map_err(|e| e.into())
        .and_then(|p| crate::storage::StorageManager::open(&p))
    {
        Ok(mgr) => {
            log::info!("daemon: opened companion.db for token/skill writes");
            Some(std::sync::Arc::new(std::sync::Mutex::new(mgr)))
        }
        Err(e) => {
            log::error!("daemon: failed to open companion.db (token/skill writes disabled): {e:#}");
            None
        }
    };

    let state = DaemonState::with_db(new_session_map(), settings_cache.clone(), db);

    // Web Push manager (ai_todo 119): loaded before the hook server so the
    // blocked-prompt fire path can reach it. Owns VAPID keys + phone
    // subscriptions persisted under app_data.
    state.init_push(app_data.clone());

    let mut router = Router::new();
    health::register(&mut router);
    methods::register(&mut router, state.clone());
    methods::register_notifier(&mut router, state.notifier.clone());
    methods::register_settings(&mut router, settings_cache);
    methods::register_responders(&mut router, state.clone());
    methods::register_channels(&mut router, state.clone());
    methods::register_chat_registry(&mut router, state.clone());
    methods::register_usage(&mut router, state.clone());
    methods::register_context(&mut router, state.clone());
    methods::register_history(&mut router, state.clone());
    methods::register_preview(&mut router, state.clone());
    methods::register_schedule(&mut router, state.clone());
    methods::register_jarvis(&mut router, state.clone());

    // Bind hook server BEFORE the RPC accept loop so in-flight claude
    // processes can re-discover the port the moment we're up.
    let _hook_port = match hooks_server::spawn(state.clone()).await {
        Ok(port) => Some(port),
        // Another process answers the HTTP port. This is normally a healthy
        // duplicate-spawn race (two apps calling ensure_daemon at once), but
        // ai_todo 151: the HTTP health check alone can't tell that apart from
        // a wedged old daemon whose named-pipe accept loop died while its HTTP
        // server kept answering - in that case exiting here strands every
        // future launch on a dead pipe forever (the app's ensure_daemon only
        // ever retries the pipe, never the HTTP port). Probe the pipe too
        // before trusting the "healthy" verdict.
        Err(hooks_server::HookBindError::HealthyDaemonExists(port)) => {
            let pipe_addr = crate::daemon_client::daemon_addr_for_current_user();
            let pipe_alive = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                crate::daemon_client::PersistentClient::connect(&pipe_addr),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
            if pipe_alive {
                log::info!("daemon: a healthy daemon already serves port {port}; exiting (duplicate-spawn race)");
                return Ok(());
            }
            log::warn!(
                "daemon: port {port} answers /health but the named pipe is not accepting \
                 connections (ai_todo 151) - a previous daemon is likely wedged; continuing \
                 startup without re-binding the hook HTTP port so pipe-based IPC can recover"
            );
            None
        }
        Err(e) => return Err(e.into()),
    };
    detector_task::spawn(state.clone());
    // Scheduled messages / scheduled new-chats (scheduling feature, Phase 1).
    schedule::spawn(state.clone());

    // Startup + periodic (every 24h) GC of leaked per-turn mcp-temp files
    // (`.mcp.json` / hook `.settings.json`) - see `claude_config::gc_temp_files`.
    tokio::spawn(async {
        loop {
            claude_config::gc_temp_files();
            tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        }
    });

    // Remote-access server (phone cockpit, Phase 1). Localhost-bound + token-
    // authed; opt-in remote reach via the user's `tailscale serve`. Best-effort:
    // never fails daemon startup. See daemon/remote_server.rs for the security
    // boundary.
    let stt = remote_server::spawn(state.clone(), app_data.clone(), router.clone());

    // iroh tunnel to that same server (todo 506 phase 2) - reaches the phone
    // without Tailscale. Runs alongside `tailscale serve`, not instead of it,
    // until it is verified on a real device. Same best-effort contract.
    let _iroh = iroh_tunnel::spawn(app_data.clone());

    // Idle-shutdown tick for the STT voice sidecar: every 60s, kill it if it has
    // been idle (zero active /ws/transcribe connections) past the 5-min timeout,
    // so the GPU model frees VRAM when voice mode is unused.
    {
        let stt_tick = stt.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                stt_tick.maybe_idle_shutdown().await;
            }
        });
    }

    // Restore Interactive (in-app) chats persisted before the last shutdown.
    // The registry is in-memory only; without this, every daemon restart (reboot,
    // crash, kill-orphans) drops every in-app chat from the sidebar. Must run
    // BEFORE the adopt_* scans so restored ids are already in known_session_ids()
    // and a live terminal session for the same id isn't clobbered Interactive
    // -> External (or vice versa).
    {
        let path = crate::settings::paths::interactive_sessions_file().unwrap_or_default();
        let restored = crate::sessions::persistence::populate_registry(
            &state.registry,
            crate::sessions::persistence::load_snapshot(&path),
        );
        if restored > 0 {
            log::info!("restored {restored} interactive session(s) from snapshot");
            state.notifier.publish("instances_changed", serde_json::json!({"instances": state.registry.list()}));
        }
    }

    // Adopt bridges that survived a previous daemon shutdown before spawning
    // new ones (prevents duplicate bridge trees on daemon restart).
    channel_adopt::adopt_running_channels(state.clone());

    // Re-track any external `claude` terminal sessions that were already
    // running when the daemon (re)started. Must run AFTER adopt_running_channels
    // so channel pids are already known and excluded from the external scan.
    channel_adopt::adopt_external_sessions(state.clone());

    // Autostart automated channels the daemon owns. The in-session dedup guard
    // in start_channel skips any project already adopted above.
    channels::autostart_all(state.clone());

    #[cfg(windows)]
    {
        let pipe_name = transport_windows::pipe_name_for_user();
        log::info!("daemon listening on {pipe_name}");
        let shutdown = state.shutdown.clone();
        let accept = tokio::spawn(async move {
            transport_windows::accept_loop(&pipe_name, router).await
        });
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("daemon: ctrl-c received, shutting down");
            }
            _ = shutdown.notified() => {
                log::info!("daemon: shutdown_daemon RPC received, exiting");
            }
            r = accept => {
                match r {
                    Ok(Ok(())) => log::error!("daemon: accept loop exited unexpectedly (no error)"),
                    Ok(Err(e)) => log::error!("daemon: accept loop failed: {e}"),
                    Err(e) => log::error!("daemon: accept loop task error: {e}"),
                }
            }
        }
        log::info!("daemon: main loop exiting");
    }
    #[cfg(unix)]
    {
        let socket_path = transport_unix::socket_path_for_user();
        log::info!("daemon listening on {}", socket_path.display());
        let shutdown = state.shutdown.clone();
        let accept = tokio::spawn(async move {
            transport_unix::accept_loop(&socket_path, router).await
        });
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("daemon: ctrl-c received, shutting down");
            }
            _ = shutdown.notified() => {
                log::info!("daemon: shutdown_daemon RPC received, exiting");
            }
            r = accept => {
                match r {
                    Ok(Ok(())) => log::error!("daemon: accept loop exited unexpectedly (no error)"),
                    Ok(Err(e)) => log::error!("daemon: accept loop failed: {e}"),
                    Err(e) => log::error!("daemon: accept loop task error: {e}"),
                }
            }
        }
        log::info!("daemon: main loop exiting");
    }
    // Orphan-prevention: a chat session's `claude -p --input-format
    // stream-json` process is long-lived (it survives across turns), so a
    // bare Ctrl-C would otherwise leave any in-flight session's `claude`
    // child (and its subprocess tree) running with no pump task left to
    // reap it. Kill every live session's tree before exiting.
    kill_all_sessions(&state);
    // Graceful teardown: never let the Python STT sidecar outlive the daemon.
    stt.kill().await;
    Ok(())
}
