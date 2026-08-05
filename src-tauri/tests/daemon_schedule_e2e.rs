//! End-to-end integration tests for the scheduling fire path
//! (`daemon::schedule`'s tick loop + `schedule_fire_now`).
//!
//! Manual run only:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_schedule_e2e -- --ignored --nocapture
//!
//! These tests SPAWN A REAL CLAUDE PROCESS (haiku/low, ~5-token prompts) and
//! burn the user's subscription quota. Each test spawns its own isolated
//! daemon instance (distinct named pipe + lockfile via `CC_DAEMON_INSTANCE`)
//! exactly like `daemon_session_e2e.rs` - never the user's real daemon.
//!
//! The scheduled-items store is instance-scoped like the daemon's lockfile
//! and pipe: a daemon under `CC_DAEMON_INSTANCE=foo` reads and writes
//! `<app-data>/scheduled-items-foo.json`, never the user's real
//! `scheduled-items.json`. Without that scoping a test daemon and the user's
//! live daemon race over one whole-file read-modify-write, and the live
//! daemon can claim a test item and fire its prompt into a real chat. This
//! test process has no `CC_DAEMON_INSTANCE` of its own, so it addresses each
//! daemon's store explicitly via `scheduled_items::config_path_for`. Items
//! are still removed by a `Drop`-guard (`ScheduledItemGuard`) so cleanup runs
//! even if an assertion panics partway through.

#![cfg(windows)]

use claude_conductor_lib::daemon_client::PersistentClient;
use claude_conductor_lib::sessions::scheduled_items::{self, ScheduledStatus};
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;

#[path = "support/mod.rs"]
mod support;
use support::ChildGuard;

fn daemon_exe() -> std::path::PathBuf {
    // Derived from this test binary's own path, so a `CARGO_TARGET_DIR`
    // override (e.g. to dodge a running daemon's lock) is honored for free.
    let mut p = std::env::current_exe().unwrap();
    p.pop();
    p.pop();
    p.push("cc-conductor-daemon.exe");
    p
}

/// Deletes a `scheduled-items.json` entry by id on drop, even if the test
/// panics on an assertion partway through. Uses the sync store helper
/// directly (not an RPC round trip) so cleanup still works even if the
/// daemon connection itself is what broke.
struct ScheduledItemGuard {
    id: String,
    store: std::path::PathBuf,
}

impl Drop for ScheduledItemGuard {
    fn drop(&mut self) {
        if self.id.is_empty() {
            return;
        }
        let existed = scheduled_items::delete_at(&self.store, &self.id);
        eprintln!("cleanup: schedule_delete({}) existed={existed}", self.id);
    }
}

/// The instance-scoped `scheduled-items-<instance>.json` the daemon spawned
/// under `instance` reads and writes.
fn store_path(instance: &str) -> std::path::PathBuf {
    scheduled_items::config_path_for(&format!("-{instance}")).expect("scheduled-items path")
}

/// Builds and spawns an isolated test daemon under `instance`, and returns a
/// guard (kills the child on drop) plus the pipe address to connect to.
async fn spawn_test_daemon(instance: &str) -> (ChildGuard, String) {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{instance}");
    if let Some(app_data) = dirs::data_dir() {
        let lock = app_data.join("claude-conductor").join(format!("daemon-{instance}.lock"));
        let _ = std::fs::remove_file(&lock);
    }
    // A previous aborted run can leave items behind; the daemon sweeps stale
    // `Firing` entries to `Failed` at startup, which would pollute this run.
    let _ = std::fs::remove_file(store_path(instance));

    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-conductor-daemon"])
        .status()
        .expect("cargo build");
    assert!(build.success());

    let exe = daemon_exe();
    let child = Command::new(&exe)
        .env("CC_DAEMON_INSTANCE", instance)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");

    tokio::time::sleep(Duration::from_millis(800)).await;
    (ChildGuard::new(child), pipe_name)
}

/// Drains notifications on `rx` up to `timeout`, returning true as soon as an
/// `assistant_message`, `turn_usage`, or `session_ended` `ChatEvent` variant
/// is observed. Mirrors `daemon_session_e2e.rs`'s drain loop exactly (same
/// internally-tagged `/params/event/type` pointer).
async fn drain_for_reply(rx: &mut tokio::sync::mpsc::Receiver<serde_json::Value>, timeout: Duration) -> (usize, bool) {
    let mut events_seen = 0usize;
    let mut saw_reply = false;
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(notif)) => {
                events_seen += 1;
                let variant = notif
                    .pointer("/params/event")
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                eprintln!("notif #{events_seen}: variant={variant:?}");
                if let Some(k) = variant.as_deref() {
                    if k == "assistant_message" || k == "turn_usage" || k == "session_ended" {
                        saw_reply = true;
                        if k == "turn_usage" || k == "session_ended" {
                            break;
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                eprintln!("timeout waiting for next event; events_seen={events_seen}");
                if saw_reply {
                    break;
                }
            }
        }
    }
    (events_seen, saw_reply)
}

const TINY_PROMPT: &str = "reply with the literal word OK and stop.";

/// The registered account these tests spawn `claude` under. No spawn path may
/// fall back to `~/.claude`, so an explicit id is required rather than leaning
/// on whatever `default_account_id` the developer's machine happens to have
/// set. Prefers the configured default, else the first registered account.
/// `None` means an empty registry - the caller skips instead of failing, since
/// there is nothing meaningful to test.
fn test_account_id() -> Option<String> {
    let accounts_path = claude_conductor_lib::settings::paths::accounts_file().ok()?;
    let accounts = claude_conductor_lib::accounts::store::load(&accounts_path);
    let default_id = claude_conductor_lib::settings::paths::settings_file()
        .ok()
        .and_then(|p| claude_conductor_lib::settings::load(&p).default_account_id);
    let picked = default_id
        .and_then(|id| accounts.iter().find(|a| a.id == id).cloned())
        .or_else(|| accounts.first().cloned())?;
    eprintln!("spawning under account {} ({})", picked.label, picked.id);
    Some(picked.id)
}

/// Test 1: a scheduled `Message` item, due immediately, must be picked up by
/// the daemon's autonomous ~30s tick loop (NOT `fire_now`) and delivered into
/// the live session.
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn scheduled_message_fires_via_tick_loop() {
    const INSTANCE: &str = "test-schedule-msg";
    let Some(account_id) = test_account_id() else {
        eprintln!("SKIP: no accounts registered - add one before running this suite");
        return;
    };
    let (_daemon_guard, pipe_name) = spawn_test_daemon(INSTANCE).await;

    let client = PersistentClient::connect(&pipe_name).await.expect("connect");

    let cwd = std::env::temp_dir();
    let cwd_str = cwd.to_string_lossy().to_string();
    let session_id = client
        .start_session(&cwd_str, "haiku", "low", None, false, Some(&account_id), false)
        .await
        .expect("start_session");
    eprintln!("started session {session_id}");

    let mut rx = client.attach_session(&session_id).await.expect("attach");

    // Drive one warm-up turn to completion FIRST. `start_session` marks the
    // registry entry `busy = true` (daemon/methods/lifecycle.rs), and only a
    // finished turn clears it - `claude` withholds all output until its first
    // user message, so a never-messaged session stays busy indefinitely. The
    // scheduler's busy guard would then defer this item on every tick until
    // the grace window lapsed. A real session is idle by the time anyone
    // schedules into it; reproduce that state rather than the unreachable one.
    client.send_message(&session_id, TINY_PROMPT).await.expect("warm-up send");
    let (warm_events, warm_reply) = drain_for_reply(&mut rx, Duration::from_secs(120)).await;
    assert!(warm_reply, "warm-up turn never completed (events_seen={warm_events})");
    // `turn_usage` is emitted as the turn's result line is handled; the pump
    // clears `busy` around the same moment. Give it room to land.
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Due immediately (now), well within the default 3600s grace window, so
    // the tick loop claims and fires it rather than marking it Missed.
    let fire_at = chrono::Utc::now().to_rfc3339();
    let kind = json!({"type": "message", "session_id": session_id, "cwd": cwd_str});
    let created = client
        .schedule_create(kind, TINY_PROMPT, &fire_at, None)
        .await
        .expect("schedule_create");
    let item_id = created["id"].as_str().expect("created item has id").to_string();
    eprintln!("scheduled item {item_id} fire_at={fire_at}");
    let store = store_path(INSTANCE);
    let _cleanup = ScheduledItemGuard { id: item_id.clone(), store: store.clone() };

    // Do NOT call fire_now here - the point is to prove the autonomous tick
    // loop (TICK_SECS=30) delivers it on its own.
    let (events_seen, saw_reply) = drain_for_reply(&mut rx, Duration::from_secs(120)).await;
    eprintln!("---- TEST 1 RESULT ----");
    eprintln!("events_seen: {events_seen}, saw_reply: {saw_reply}");

    // finish_fire may land moments after the send goes out, so poll briefly
    // for the item to flip to Sent rather than reading it exactly once.
    let mut final_status = scheduled_items::get_at(&store, &item_id).map(|i| i.status);
    let poll_deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !matches!(final_status, Some(ScheduledStatus::Sent)) && std::time::Instant::now() < poll_deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
        final_status = scheduled_items::get_at(&store, &item_id).map(|i| i.status);
    }
    eprintln!("final scheduled item status: {final_status:?}");

    let _ = client.end_session(&session_id).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        saw_reply,
        "expected an assistant_message/turn_usage/session_ended event fired by the tick loop (events_seen={events_seen})"
    );
    assert!(
        matches!(final_status, Some(ScheduledStatus::Sent)),
        "expected the scheduled item to end in Sent status, got {final_status:?}"
    );
}

/// Test 2: `schedule_fire_now` on a `NewChat` item (scheduled far in the
/// future so the tick loop never claims it) must spawn a brand-new session
/// immediately and deliver the prompt into it.
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn fire_now_spawns_scheduled_new_chat() {
    const INSTANCE: &str = "test-schedule-newchat";
    let Some(account_id) = test_account_id() else {
        eprintln!("SKIP: no accounts registered - add one before running this suite");
        return;
    };
    let (_daemon_guard, pipe_name) = spawn_test_daemon(INSTANCE).await;

    let client = PersistentClient::connect(&pipe_name).await.expect("connect");

    let cwd = std::env::temp_dir();
    let cwd_str = cwd.to_string_lossy().to_string();

    let prior_ids: std::collections::HashSet<String> = client
        .list_instances()
        .await
        .expect("list_instances (baseline)")
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v["session_id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    // Far future (+1h): the ~30s tick loop must NOT claim this before
    // fire_now does.
    let fire_at = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    let kind = json!({
        "type": "new_chat",
        "cwd": cwd_str,
        "model": "haiku",
        "effort": "low",
        "account_id": account_id,
    });
    let created = client
        .schedule_create(kind, TINY_PROMPT, &fire_at, None)
        .await
        .expect("schedule_create");
    let item_id = created["id"].as_str().expect("created item has id").to_string();
    eprintln!("scheduled item {item_id} fire_at={fire_at} (far future)");
    let store = store_path(INSTANCE);
    let _cleanup = ScheduledItemGuard { id: item_id.clone(), store: store.clone() };

    client.schedule_fire_now(&item_id).await.expect("schedule_fire_now");

    // fire_now's RPC handler awaits the full fire chain (spawn_session +
    // registry bookkeeping + send_message) before replying, so the new
    // session is already registered by the time this call returns.
    let instances = client.list_instances().await.expect("list_instances (after fire)");
    let new_session_id = instances
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .filter_map(|v| v["session_id"].as_str())
                .find(|sid| !prior_ids.contains(*sid))
                .map(str::to_string)
        })
        .expect("a new session must appear after schedule_fire_now");
    eprintln!("new session spawned: {new_session_id}");

    // Attach as fast as possible - send_message only writes to the child's
    // stdin (fire-and-forget), so the real LLM round trip should still be
    // well ahead of us here.
    let mut rx = client.attach_session(&new_session_id).await.expect("attach");
    let (events_seen, saw_reply) = drain_for_reply(&mut rx, Duration::from_secs(120)).await;
    eprintln!("---- TEST 2 RESULT ----");
    eprintln!("events_seen: {events_seen}, saw_reply: {saw_reply}");

    let final_status = scheduled_items::get_at(&store, &item_id).map(|i| i.status);
    eprintln!("final scheduled item status: {final_status:?}");

    let _ = client.end_session(&new_session_id).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        matches!(final_status, Some(ScheduledStatus::Sent)),
        "expected the scheduled item to end in Sent status, got {final_status:?}"
    );
    assert!(
        saw_reply,
        "expected an assistant_message/turn_usage/session_ended event from the fire_now-spawned session (events_seen={events_seen})"
    );
}
