//! Boot-time adoption of already-running processes. Split out of
//! `daemon/channels.rs` (which now holds only channel lifecycle). Two entry
//! points:
//!
//! - `adopt_running_channels`: called BEFORE `autostart_all`, re-tracks
//!   `claude --remote-control` bridges so the daemon doesn't spawn duplicates.
//! - `adopt_external_sessions`: called AFTER channel adoption, re-tracks
//!   already-running plain `claude` processes as External registry entries so
//!   a daemon restart doesn't drop them from the sidebar.

use std::sync::Arc;

use crate::channels::manager::ChannelSnapshot;
use crate::channels::spawn::resolve_claude_pid;
use crate::daemon::channels::emit_changed;
use crate::daemon::state::DaemonState;
use crate::types::ChannelStatus;

/// Scan the live process list for already-running `claude --remote-control`
/// bridges and adopt them into the channel manager so the daemon knows about
/// them without spawning duplicates.
///
/// Called on daemon boot BEFORE `autostart_all`. Projects that get an adopted
/// channel are then skipped by `autostart_all` via the in-session dedup guard
/// in `start_channel`.
///
/// ## Process matching (Windows-centric)
///
/// On Windows the channel is launched as `cmd.exe /C claude --remote-control
/// --remote-control-session-name-prefix <prefix> [--continue]`. So there are
/// two relevant processes per channel: the `cmd.exe` launcher and the `claude`
/// child. We scan for `--remote-control` in any process's argv to find both.
///
/// - If the matching process is a `cmd.exe` (or any non-claude process): treat
///   its pid as the launcher pid. Then run `resolve_claude_pid` to find the
///   claude child, storing it as `claude_pid`.
/// - If the matching process is `claude` (or `node`): it is likely the already-
///   resolved child. Use its parent as the launcher pid (or the pid itself if
///   no parent). Either way `claude_pid` is set to this pid.
///
/// On macOS the `claude` process itself is the launcher, so the scanned pid is
/// both launcher and claude_pid.
///
/// The prefix match is exact-string against each project's resolved prefix
/// (`auto.session_name_prefix` or the project name as fallback), the same
/// logic as `resolve_project`.
pub fn adopt_running_channels(state: Arc<DaemonState>) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let mut sys = System::new();
    // The plain `refresh_processes(All)` does NOT populate each process's argv
    // (`cmd()`), so the `--remote-control` scan below saw nothing and adopted
    // nothing - every daemon boot then spawned a fresh duplicate bridge (the
    // pile-up Joe hit). Explicitly request `cmd` so discovery actually works.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );

    let settings = state.settings.snapshot();

    // Projects whose bridge we've already adopted in this scan. A second
    // *distinct* bridge for the same project is a leftover duplicate (e.g. from
    // a prior daemon that exited without killing its channel) and gets killed,
    // so exactly one survives per project.
    let mut adopted: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Bridge claude-pids already handled this scan. A live bridge is a launcher
    // (cmd.exe) PLUS its claude child, and BOTH carry `--remote-control` in
    // argv, so both match the scan. Keying on the resolved claude pid makes the
    // pair count as one bridge instead of two (which would wrongly kill a live
    // bridge's child).
    let mut seen_bridges: std::collections::HashSet<u32> = std::collections::HashSet::new();

    for proc_ in sys.processes().values() {
        let args: Vec<String> = proc_.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();

        // Only consider processes that have --remote-control in their argv.
        if !args.iter().any(|a| a == "--remote-control") {
            continue;
        }

        // Extract the prefix from --remote-control-session-name-prefix <value>.
        let prefix_in_proc = args.windows(2).find_map(|w| {
            if w[0] == "--remote-control-session-name-prefix" {
                Some(w[1].clone())
            } else {
                None
            }
        });
        let Some(found_prefix) = prefix_in_proc else { continue };

        // Match this prefix against a known project.
        let matched_project = settings.projects.iter().find(|p| {
            let auto = match p.automation.as_ref() {
                Some(a) if a.enabled => a,
                _ => return false,
            };
            let expected = auto.session_name_prefix.clone().unwrap_or_else(|| p.name.clone());
            expected == found_prefix
        });
        let Some(project) = matched_project else {
            log::debug!("adopt_running_channels: --remote-control prefix {:?} matches no project", found_prefix);
            continue;
        };

        let proc_pid = proc_.pid().as_u32();
        let proc_name = proc_.name().to_string_lossy().to_ascii_lowercase();

        // Determine launcher vs. claude pid.
        // - If the name contains "claude" or "node": the scanned process IS
        //   the claude/node child. Try its parent as the launcher.
        // - Otherwise (e.g. cmd.exe, sh): treat it as the launcher and resolve
        //   the claude child.
        let (launcher_pid, resolved_claude_pid) = if proc_name.contains("claude") || proc_name.contains("node") {
            let launcher = proc_
                .parent()
                .map(|p: Pid| p.as_u32())
                .unwrap_or(proc_pid);
            (launcher, Some(proc_pid))
        } else {
            // launcher is the scanned process; resolve its claude child.
            let claude_child = resolve_claude_pid(proc_pid);
            (proc_pid, claude_child)
        };

        // Collapse the launcher + its claude child into one bridge: both match
        // the scan but resolve to the same claude pid.
        let bridge_key = resolved_claude_pid.unwrap_or(proc_pid);
        if !seen_bridges.insert(bridge_key) {
            continue; // already handled this bridge's other half
        }

        // One-of-each: keep the first bridge per project; kill any further
        // distinct bridge (a leftover from a prior daemon that didn't clean up).
        if !adopted.insert(project.id.clone()) {
            log::info!(
                "adopt_running_channels: killing duplicate bridge (launcher {} claude {:?}) for project {} (keeping one)",
                launcher_pid, resolved_claude_pid, project.id
            );
            crate::channels::kill::kill_tree(launcher_pid);
            if let Some(cp) = resolved_claude_pid {
                crate::channels::kill::kill_tree(cp);
            }
            continue;
        }

        // Skip projects that already have a live channel in the manager
        // (handles the case where adopt is called twice or after a start).
        if let Some(existing) = state.channels.snapshot(&project.id) {
            if matches!(existing.status, ChannelStatus::Starting | ChannelStatus::Running)
                && existing.pid.is_some()
            {
                log::debug!(
                    "adopt_running_channels: project {} already has an active channel, skipping",
                    project.id
                );
                continue;
            }
        }

        log::info!(
            "adopt_running_channels: adopting project {} (prefix {:?}) launcher_pid={} claude_pid={:?}",
            project.id, found_prefix, launcher_pid, resolved_claude_pid
        );

        state.channels.put(ChannelSnapshot {
            project_id: project.id.clone(),
            pid: Some(launcher_pid),
            claude_pid: resolved_claude_pid,
            status: ChannelStatus::Running,
            hwnd: None,
        });
        emit_changed(&state);

        // Spawn watchers for the adopted channel: retag + exit watcher.
        // These mirror what start_channel does post-spawn.
        if let Some(cp) = resolved_claude_pid {
            let state_r = state.clone();
            tokio::spawn(async move {
                let retagged = state_r.registry.retag_pid_as_automated(cp);
                log::info!("adopt_running_channels: retag_pid_as_automated({cp}) -> {retagged}");
                if retagged {
                    state_r.notifier.publish(
                        "instances_changed",
                        serde_json::json!({"instances": state_r.registry.list()}),
                    );
                }
            });
        }

        // Exit watcher: wait for the launcher to exit then clear the snapshot.
        // On non-Windows / non-macOS this is a no-op (wait_for_child_exit
        // returns immediately), leaving the snapshot as Running. Acceptable:
        // the daemon's dedup guard will still block a re-spawn until the
        // snapshot is cleared by a future call or restart.
        {
            let state_w = state.clone();
            let proj_w = project.id.clone();
            // Windows-only: we don't own the launcher's HANDLE (it's an adopted
            // process), so poll sysinfo until its pid disappears, then clear the
            // snapshot. On non-Windows the daemon isn't shipped yet (Phase 6),
            // so we don't spawn a watcher at all - leaving the adopted channel
            // Running is correct (the dedup guard prevents a respawn); marking
            // it Stopped immediately would be wrong.
            #[cfg(windows)]
            {
                let pid_for_wait = launcher_pid;
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        if !crate::util::process::pid_is_live(pid_for_wait) {
                            break;
                        }
                    }
                    state_w.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Stopped;
                        s.pid = None;
                        s.claude_pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&state_w);
                });
            }
            #[cfg(not(windows))]
            {
                let _ = (&state_w, &proj_w, launcher_pid);
            }
        }
    }
}

/// Re-track already-running external `claude` sessions into the registry on
/// daemon (re)start. Without this, a daemon restart boots with an empty
/// registry and external terminal sessions don't reappear in the sidebar until
/// each one fires a fresh SessionStart hook (which they never do for sessions
/// that were already running before the daemon restarted).
///
/// Called AFTER `adopt_running_channels` so that `--remote-control` channel
/// processes are already known; this function skips them.
///
/// Both data sources this scan reads are machine-wide, not scoped to this
/// daemon: `sessions_dir()` is the single shared `~/.claude/sessions` (see
/// its own multi-account-audit comment), and `sys.refresh_processes_specifics`
/// enumerates every process on the box. A non-default instance (a test/phone
/// daemon spun up with `CC_DAEMON_INSTANCE` + a scratch `CC_DATA_DIR`) has no
/// way to tell "my session" apart from a real terminal session belonging to
/// the production daemon or another tool, so it must not run this scan at
/// all - see `should_adopt_external`.
pub fn adopt_external_sessions(state: Arc<DaemonState>) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    if !should_adopt_external(&crate::daemon::instance::instance_suffix()) {
        log::debug!(
            "adopt_external_sessions: skipped for non-default instance (would scan machine-wide processes/sessions)"
        );
        return;
    }

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );

    // Build live_processes map (pid -> process start time in unix-epoch seconds)
    // for scan_live_sessions's pid-reuse defense.
    let live_processes: std::collections::HashMap<u32, u64> = sys
        .processes()
        .values()
        .map(|p| (p.pid().as_u32(), p.start_time()))
        .collect();

    // Pids that belong to automated channels or the daemon itself - skip them.
    let skip_pids: std::collections::HashSet<u32> = sys
        .processes()
        .values()
        .filter(|p| {
            let args: Vec<String> =
                p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            args.iter().any(|a| a == "--remote-control")
                || args.iter().any(|a| a == "--daemon")
        })
        .map(|p| p.pid().as_u32())
        .collect();

    let known_ids: std::collections::HashSet<String> =
        state.registry.known_session_ids().into_iter().collect();

    let live_sessions = crate::hooks::session_files::scan_live_sessions(&live_processes);

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let mut adopted_count = 0usize;
    for sess in live_sessions {
        if skip_pids.contains(&sess.pid) {
            continue;
        }
        if known_ids.contains(&sess.session_id) {
            continue;
        }

        let (_, _) = state.settings.upsert_project_for_cwd(&sess.cwd, &now);
        let snapshot = state.settings.snapshot();
        let shim = std::sync::Mutex::new(snapshot);

        let started_at = chrono::DateTime::from_timestamp_millis(sess.started_at_ms)
            .map(|dt: chrono::DateTime<chrono::Utc>| {
                dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            })
            .unwrap_or_else(|| now.clone());

        let input = crate::sessions::registry::RegisterInput {
            session_id: sess.session_id.clone(),
            cwd: sess.cwd.clone(),
            pid: sess.pid,
            kind: crate::sessions::kinds::InstanceKind::External,
            is_remote: false,
            transcript_path: None,
            started_at,
        };

        let (_, created) = state.registry.register(input, &shim, &now);
        if created {
            adopted_count += 1;
            if let Some(bridge) = &sess.bridge_session_id {
                state.registry.set_bridge_session_id(&sess.session_id, bridge.clone());
            }
            // Derive the sidebar title from the transcript's first user prompt,
            // same as the restore + hook-enrichment paths. Without this an
            // adopted session shows as "New chat" forever (it never goes through
            // the session-start hook that would otherwise name it).
            if let Some(name) = crate::tokens::transcript_for_session(&sess.cwd, &sess.session_id)
                .as_deref()
                .and_then(|p| crate::tokens::session_title(p, 60))
            {
                state.registry.set_name(&sess.session_id, name);
            }
            log::info!(
                "adopt_external_sessions: adopted session {} pid={} cwd={:?}",
                sess.session_id, sess.pid, sess.cwd
            );
        }
    }

    if adopted_count > 0 {
        state.notifier.publish(
            "instances_changed",
            serde_json::json!({"instances": state.registry.list()}),
        );
        log::info!("adopt_external_sessions: adopted {} session(s)", adopted_count);
    } else {
        log::debug!("adopt_external_sessions: no new external sessions found");
    }
}

/// Gate for `adopt_external_sessions`. Pure over the instance suffix (not
/// `std::env` directly) so it's testable without touching process env - see
/// `crate::daemon::instance::instance_suffix()` for what produces the value.
///
/// Only the default (production) instance may run the machine-wide scan.
/// A non-default instance (any non-empty suffix: `-dev`, `-test`, a
/// `CC_DAEMON_INSTANCE` label) shares no reliable marker with its own
/// processes - the session files it would scan carry no instance tag, so
/// there is no cheap correct way to filter candidates down to "mine" short
/// of skipping the scan outright.
pub fn should_adopt_external(instance_suffix: &str) -> bool {
    instance_suffix.is_empty()
}

#[cfg(test)]
mod gate_tests {
    use super::should_adopt_external;

    #[test]
    fn default_instance_adopts() {
        assert!(should_adopt_external(""));
    }

    #[test]
    fn suffixed_instance_does_not_adopt() {
        assert!(!should_adopt_external("-dev"));
        assert!(!should_adopt_external("-test"));
        assert!(!should_adopt_external("-phone1028"));
    }
}
