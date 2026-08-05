//! End-to-end integration tests for the daemon chat path (ai_todo 67).
//!
//! Manual run only:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_chat_e2e -- --ignored --nocapture
//!
//! These tests SPAWN A REAL DAEMON and bind the fixed hook port (27182), so
//! they are `#[ignore]` to stay out of the default `cargo test` run (which
//! would otherwise kill a running daemon / collide on the port).
//!
//! `interactive_survives_session_end_hook` is FREE (no `claude` process): it
//! exercises only the registry + hook server. `end_to_end_no_duplicate_events`
//! spawns a real `claude` turn and burns a tiny slice of subscription quota.

#![cfg(windows)]

use claude_conductor_lib::daemon_client::PersistentClient;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;

fn daemon_exe() -> std::path::PathBuf {
    // Derive from this test binary (<target-dir>/debug/deps/x.exe) rather than
    // assuming ./target: .cargo/config.toml redirects target-dir off the repo.
    let mut p = std::env::current_exe().unwrap();
    p.pop();
    p.pop();
    p.push("cc-conductor-daemon.exe");
    p
}

/// Kill any prior daemon and clear the lockfile, then build + spawn a fresh one
/// and connect a client. Returns the child handle and the connected client.
async fn spawn_daemon_and_connect() -> (std::process::Child, PersistentClient, String) {
    // Isolated test instance (ai_todo 71): distinct pipe/lock + ephemeral hook
    // port (discovered from the suffixed port file). NO `Stop-Process
    // cc-conductor-daemon` - that used to kill the user's real daemon.
    const INSTANCE: &str = "test-chat";
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");
    let app_data = dirs::data_dir().unwrap().join("claude-conductor");
    let _ = std::fs::remove_file(app_data.join(format!("daemon-{INSTANCE}.lock")));
    let port_file = app_data.join(format!("hooks_port-{INSTANCE}.txt"));
    let _ = std::fs::remove_file(&port_file);

    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-conductor-daemon"])
        .status()
        .expect("cargo build");
    assert!(build.success());

    let child = Command::new(daemon_exe())
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        // Surface the daemon's debug log (publishes + lag drops) on the test's
        // own stderr so `--nocapture` runs show exactly what was published vs
        // delivered.
        .env("RUST_LOG", "info,claude_conductor_lib=debug")
        // Don't let the test daemon launch real automation channels (each spawn
        // registers a fresh Claude desktop bridge - they pile up across runs).
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn daemon");

    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut hook_port = String::new();
    for _ in 0..30 {
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if !p.trim().is_empty() { hook_port = p.trim().to_string(); break; }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!hook_port.is_empty(), "daemon did not write its hook port file");

    let client = PersistentClient::connect(&pipe_name)
        .await
        .expect("connect");
    (child, client, hook_port)
}

fn find_instance<'a>(instances: &'a Value, session_id: &str) -> Option<&'a Value> {
    instances
        .as_array()?
        .iter()
        .find(|i| i.get("session_id").and_then(Value::as_str) == Some(session_id))
}

/// Regression test for the per-turn SessionEnd auto-close bug (observed
/// 2026-05-21): in Path C every user turn spawns a short-lived `claude -p`
/// process that fires the SessionEnd hook when the turn completes. That hook
/// must NOT close the daemon-owned Interactive session - its lifecycle is the
/// chat IPC layer's, exactly like the detector already exempts Interactive
/// sessions from pid-based ending (sessions/detector.rs).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn interactive_survives_session_end_hook() {
    let (mut child, client, hook_port) = spawn_daemon_and_connect().await;

    let session_id = format!("test-autoclose-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    // Register an Interactive session in the registry without spawning claude.
    client
        .call(
            "register_historical",
            json!({ "session_id": session_id, "cwd": cwd }),
        )
        .await
        .expect("register_historical");

    // Sanity: it exists and is a live Interactive entry.
    let before = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&before, &session_id).expect("session registered");
    assert_eq!(inst.get("kind").and_then(Value::as_str), Some("interactive"));
    assert!(inst.get("ended_at").map(Value::is_null).unwrap_or(true), "should start alive");

    // Fire the per-turn SessionEnd hook the way a completing `claude -p` would.
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("http://127.0.0.1:{hook_port}/hooks/session-end"))
        .json(&json!({ "session_id": session_id, "reason": "other" }))
        .send()
        .await
        .expect("POST /hooks/session-end");
    assert!(resp.status().is_success(), "hook POST status: {}", resp.status());

    // Give the daemon a beat to process.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id)
        .expect("Interactive session must NOT be removed by a per-turn SessionEnd hook");
    let ended_at = inst.get("ended_at").cloned().unwrap_or(Value::Null);

    // Cleanup before asserting so a failure doesn't leak the daemon.
    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    assert!(
        ended_at.is_null(),
        "Interactive session was auto-closed by a per-turn SessionEnd hook (ended_at={ended_at}). \
         The daemon owns Interactive lifecycle; hook SessionEnd must be ignored for kind=interactive."
    );
}

/// Phase 5b flow 5 (takeover) over the daemon RPC path. Free + deterministic:
/// register an External session via the session-start hook with a safe fake pid
/// (999999, so the real kill_tree is a no-op and no live process is touched),
/// then drive `takeover_manual` and assert the entry promotes to Interactive.
/// The takeover *logic* is unit-tested in chat/takeover.rs; this covers the
/// daemon RPC wiring (hook -> registry -> takeover_manual -> notification).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn takeover_manual_promotes_external_to_interactive() {
    let (mut child, client, hook_port) = spawn_daemon_and_connect().await;

    let session_id = format!("test-takeover-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let fake_pid = 999_999u32; // not a live process -> kill_tree is a safe no-op

    // Register as External via the session-start hook (non-channel pid).
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("http://127.0.0.1:{hook_port}/hooks/session-start"))
        .json(&json!({ "session_id": session_id, "cwd": cwd, "pid": fake_pid }))
        .send()
        .await
        .expect("POST /hooks/session-start");
    assert!(resp.status().is_success());
    tokio::time::sleep(Duration::from_millis(300)).await;

    let before = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&before, &session_id).expect("external session registered");
    assert_eq!(inst.get("kind").and_then(Value::as_str), Some("external"));

    // Takeover over RPC.
    client
        .call(
            "takeover_manual",
            json!({ "manual_pid": fake_pid, "model": "haiku", "effort": "low", "account_id": "test-acct" }),
        )
        .await
        .expect("takeover_manual");

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    let inst = inst.expect("session still present after takeover");
    assert_eq!(
        inst.get("kind").and_then(Value::as_str),
        Some("interactive"),
        "takeover_manual must promote the External session to Interactive"
    );
}

/// Phase 5b flow 1 (clear_session -> mark_session_ended) over the daemon RPC
/// path. Free + deterministic: register an Interactive session, mark it ended,
/// assert `ended_at` is populated in the snapshot. Closing a chat in the app
/// forwards to this RPC.
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn mark_session_ended_sets_ended_at() {
    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;

    let session_id = format!("test-markended-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    client
        .call("register_historical", json!({ "session_id": session_id, "cwd": cwd }))
        .await
        .expect("register_historical");

    let before = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&before, &session_id).expect("session registered");
    assert!(inst.get("ended_at").map(Value::is_null).unwrap_or(true), "should start alive");

    client
        .call("mark_session_ended", json!({ "session_id": session_id }))
        .await
        .expect("mark_session_ended");

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    let inst = inst.expect("session still present after mark_ended");
    let ended_at = inst.get("ended_at").cloned().unwrap_or(Value::Null);
    assert!(
        ended_at.is_string(),
        "mark_session_ended must populate ended_at (got {ended_at})"
    );
}

/// Phase 5b flow 2 (open_session_in_terminal -> externalize_session) over the
/// daemon RPC path. Free + deterministic: register an Interactive session,
/// externalize it, assert the kind flips to External (read-only). The app's
/// "Open in Terminal" action forwards to this RPC (the real terminal spawn is
/// a separate concern not exercised here).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn externalize_session_flips_interactive_to_external() {
    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;

    let session_id = format!("test-externalize-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    client
        .call("register_historical", json!({ "session_id": session_id, "cwd": cwd }))
        .await
        .expect("register_historical");

    let before = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&before, &session_id).expect("session registered");
    assert_eq!(inst.get("kind").and_then(Value::as_str), Some("interactive"));

    client
        .call("externalize_session", json!({ "session_id": session_id }))
        .await
        .expect("externalize_session");

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    let inst = inst.expect("session still present after externalize");
    assert_eq!(
        inst.get("kind").and_then(Value::as_str),
        Some("external"),
        "externalize_session must flip the Interactive session to External"
    );
}

/// Phase 5b flow 3 (set_session_effort) over the daemon RPC path. Free +
/// deterministic: register a session (effort starts empty), set effort to
/// "high", assert it persists in the snapshot.
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn set_session_effort_persists() {
    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;

    let session_id = format!("test-effort-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    client
        .call("register_historical", json!({ "session_id": session_id, "cwd": cwd }))
        .await
        .expect("register_historical");

    client
        .call("set_session_effort", json!({ "session_id": session_id, "effort": "high" }))
        .await
        .expect("set_session_effort");

    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();

    let inst = inst.expect("session still present after set_effort");
    assert_eq!(
        inst.get("effort").and_then(Value::as_str),
        Some("high"),
        "set_session_effort must persist the new effort in the snapshot"
    );
}

/// Duplication guard (ai_todo 67): a single turn must produce no duplicate
/// stream events. Spawns a real `claude` turn (subscription-billed, tiny).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn end_to_end_no_duplicate_events() {
    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;

    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let start = client
        .call(
            "start_session",
            json!({ "cwd": cwd, "model": "haiku", "effort": "low", "resume_id": null }),
        )
        .await
        .expect("start_session");
    let session_id = start["session_id"].as_str().expect("session_id").to_string();

    let mut rx = client.attach_session(&session_id).await.expect("attach");
    client
        .call(
            "send_message",
            json!({ "session_id": session_id, "text": "reply with the literal word OK and stop." }),
        )
        .await
        .expect("send_message");

    // Collect the FULL event stream for the turn. Do not break on the first
    // turn_usage - keep draining a short tail so we can see every delivered
    // variant (and catch duplicates / missing assistant text).
    let mut assistant_msgs = 0;
    let mut finalized_assistant = 0;
    let mut turn_usages = 0;
    let mut delivered: Vec<String> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut saw_turn_usage = false;
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(notif)) => {
                let variant = notif
                    .pointer("/params/event")
                    .and_then(Value::as_object)
                    .and_then(|o| o.get("type"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                eprintln!("delivered chat_event: {variant:?}");
                if let Some(v) = variant.clone() {
                    delivered.push(v);
                }
                match variant.as_deref() {
                    Some("assistant_message") => {
                        assistant_msgs += 1;
                        let streaming = notif
                            .pointer("/params/event/streaming")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if !streaming {
                            finalized_assistant += 1;
                        }
                    }
                    Some("turn_usage") => {
                        turn_usages += 1;
                        saw_turn_usage = true;
                    }
                    _ => {}
                }
            }
            Ok(None) => break,
            // After the turn completed, give a brief grace window for any
            // trailing events, then stop.
            Err(_) => {
                if saw_turn_usage {
                    break;
                }
            }
        }
    }
    eprintln!("delivered variants in order: {delivered:?}");

    let _ = client.call("end_session", json!({ "session_id": session_id })).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = child.kill();
    let _ = child.wait();

    eprintln!(
        "assistant_msgs={assistant_msgs} finalized_assistant={finalized_assistant} turn_usages={turn_usages}"
    );
    assert_eq!(
        turn_usages, 1,
        "exactly one turn_usage expected per turn (got {turn_usages})"
    );
    assert_eq!(
        finalized_assistant, 1,
        "exactly one finalized (non-streaming) assistant_message expected per turn (got {finalized_assistant})"
    );
    assert!(
        assistant_msgs >= 1,
        "expected at least one assistant_message (got {assistant_msgs})"
    );
}

/// Reassemble delta frames the way the frontend store does (event-store.ts
/// `applyDelta`): snapshot frames replace unless already covered; a new block
/// or `seq == 1` restarts; `seq` at or below the accumulator is dropped.
fn assemble_deltas(chunks: &[(u64, u64, bool, String)]) -> String {
    let mut block = 0u64;
    let mut seq = 0u64;
    let mut text = String::new();
    for (b, s, snapshot, t) in chunks {
        if *snapshot {
            if !(*b == block && *s <= seq) {
                block = *b;
                seq = *s;
                text = t.clone();
            }
        } else if *b != block || *s == 1 {
            block = *b;
            seq = *s;
            text = t.clone();
        } else if *s <= seq {
            continue;
        } else {
            seq = *s;
            text.push_str(t);
        }
    }
    text
}

/// Live verify of the O(delta) stream protocol (ai_todo 186) over the real
/// wire: a real `claude` turn must stream `assistant_delta` chunks (not
/// cumulative snapshots) whose reassembly equals the finalized text, with
/// contiguous per-block `seq` numbering - and a second client attaching
/// MID-turn must be resynced via a `snapshot: true` frame and converge to
/// the same transcript. Spawns a real `claude` turn (subscription-billed,
/// tiny, haiku/low).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn delta_stream_reassembles_and_midturn_attach_resyncs() {
    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;

    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let start = client
        .call(
            "start_session",
            json!({ "cwd": cwd, "model": "haiku", "effort": "low", "resume_id": null }),
        )
        .await
        .expect("start_session");
    let session_id = start["session_id"].as_str().expect("session_id").to_string();

    let pipe_name = {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        format!(r"\\.\pipe\cc-conductor-daemon-{user}-test-chat")
    };

    let mut rx_a = client.attach_session(&session_id).await.expect("attach A");
    client
        .call(
            "send_message",
            json!({
                "session_id": session_id,
                "text": "Count from 1 to 80 as plain numbers separated by spaces. No other text."
            }),
        )
        .await
        .expect("send_message");

    // Client A: attached before the turn - must see raw (non-snapshot) deltas.
    let mut a_chunks: Vec<(u64, u64, bool, String)> = Vec::new();
    let mut a_final: Option<String> = None;
    let mut client_b: Option<PersistentClient> = None;
    let mut rx_b = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut saw_turn_usage = false;
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx_a.recv()).await {
            Ok(Some(notif)) => {
                let ev = notif.pointer("/params/event").cloned().unwrap_or(Value::Null);
                match ev.get("type").and_then(Value::as_str) {
                    Some("assistant_delta") => {
                        a_chunks.push((
                            ev["block"].as_u64().unwrap_or(0),
                            ev["seq"].as_u64().unwrap_or(0),
                            ev["snapshot"].as_bool().unwrap_or(false),
                            ev["text"].as_str().unwrap_or("").to_string(),
                        ));
                        // First streamed text: attach client B MID-turn.
                        if client_b.is_none() {
                            let b = PersistentClient::connect(&pipe_name).await.expect("connect B");
                            rx_b = Some(b.attach_session(&session_id).await.expect("attach B"));
                            client_b = Some(b);
                        }
                    }
                    Some("assistant_message") => {
                        let streaming = ev["streaming"].as_bool().unwrap_or(false);
                        if !streaming {
                            a_final = ev
                                .pointer("/content/0/text")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                        }
                    }
                    Some("turn_usage") => {
                        saw_turn_usage = true;
                    }
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(_) => {
                if saw_turn_usage {
                    break;
                }
            }
        }
    }

    // Client B attached mid-turn: drain what it buffered.
    let mut b_frames: Vec<(u64, u64, bool, String)> = Vec::new();
    let mut b_final: Option<String> = None;
    if let Some(mut rx) = rx_b {
        let b_deadline = std::time::Instant::now() + Duration::from_secs(15);
        while std::time::Instant::now() < b_deadline {
            match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
                Ok(Some(notif)) => {
                    let ev = notif.pointer("/params/event").cloned().unwrap_or(Value::Null);
                    match ev.get("type").and_then(Value::as_str) {
                        Some("assistant_delta") => b_frames.push((
                            ev["block"].as_u64().unwrap_or(0),
                            ev["seq"].as_u64().unwrap_or(0),
                            ev["snapshot"].as_bool().unwrap_or(false),
                            ev["text"].as_str().unwrap_or("").to_string(),
                        )),
                        Some("assistant_message") => {
                            if !ev["streaming"].as_bool().unwrap_or(false) {
                                b_final = ev
                                    .pointer("/content/0/text")
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                            }
                        }
                        Some("turn_usage") => break,
                        _ => {}
                    }
                }
                _ => break,
            }
        }
    }

    let _ = client.call("end_session", json!({ "session_id": session_id })).await;
    drop(client_b);
    drop(client);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = child.kill();
    let _ = child.wait();

    eprintln!("A: {} delta chunks; final={:?}", a_chunks.len(), a_final);
    eprintln!("B: {} delta frames (first snapshot={:?}); final={:?}",
        b_frames.len(), b_frames.first().map(|f| f.2), b_final);

    let a_final = a_final.expect("A must receive the finalized assistant_message");
    assert!(saw_turn_usage, "turn must complete with a turn_usage");
    assert!(
        a_chunks.len() >= 2,
        "an 80-number reply must stream in multiple coalesced delta chunks (got {})",
        a_chunks.len()
    );
    assert!(
        a_chunks.iter().all(|c| !c.2),
        "A attached before the turn: no snapshot resync frames expected"
    );
    // Contiguous per-block numbering from the pump.
    let mut expect_seq = 0u64;
    let mut cur_block = 0u64;
    for (b, s, _, _) in &a_chunks {
        if *b != cur_block {
            cur_block = *b;
            expect_seq = 0;
        }
        expect_seq += 1;
        assert_eq!(*s, expect_seq, "delta seq must be contiguous per block");
    }
    // O(delta) on the wire: every frame carries only new characters, never the
    // whole accumulated text.
    let longest = a_chunks.iter().map(|c| c.3.len()).max().unwrap_or(0);
    assert!(
        longest < a_final.len(),
        "each delta frame must be smaller than the final text (longest={longest}, final={})",
        a_final.len()
    );
    assert_eq!(
        assemble_deltas(&a_chunks).trim(),
        a_final.trim(),
        "reassembled A deltas must equal the finalized text"
    );

    // Mid-turn attach: B's first streamed frame must be the snapshot resync,
    // and its reassembly must converge to the same final text.
    let first_b = b_frames.first().expect("B must receive delta frames after mid-turn attach");
    assert!(
        first_b.2,
        "B attached mid-turn: first delta frame must be a snapshot resync (got {first_b:?})"
    );
    assert_eq!(
        assemble_deltas(&b_frames).trim(),
        a_final.trim(),
        "B's snapshot + tail deltas must reassemble to the same final text"
    );
    assert_eq!(
        b_final.as_deref().map(str::trim),
        Some(a_final.trim()),
        "B must also receive the identical finalized assistant_message"
    );
}

/// The "test-chat" instance's interactive-session snapshot file. Instance-scoped
/// (`interactive-sessions-test-chat.json`) so these tests never touch the real
/// daemon's snapshot.
fn interactive_snapshot_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap()
        .join("claude-conductor")
        .join("interactive-sessions-test-chat.json")
}

/// Regression for the "new chat vanished after daemon restart" bug: an
/// Interactive session must survive a full daemon kill+relaunch via the
/// persisted snapshot, with its effort preserved and as a resumable (pid 0)
/// entry. Free + deterministic (no `claude` process). Run serial
/// (`--test-threads=1`): shares the "test-chat" daemon instance.
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn interactive_session_survives_daemon_restart() {
    let snap = interactive_snapshot_path();
    let _ = std::fs::remove_file(&snap); // clear any leftover from a prior run

    let session_id = format!("test-persist-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    // --- First daemon: register an interactive chat + set effort, then kill. ---
    {
        let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;
        client
            .call("register_historical", json!({ "session_id": session_id, "cwd": cwd }))
            .await
            .expect("register_historical");
        client
            .call("set_session_effort", json!({ "session_id": session_id, "effort": "high" }))
            .await
            .expect("set_session_effort");
        let before = client.call("list_instances", json!({})).await.expect("list");
        assert!(
            find_instance(&before, &session_id).is_some(),
            "session should exist before the restart"
        );
        drop(client);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = child.kill();
        let _ = child.wait();
    }

    tokio::time::sleep(Duration::from_millis(500)).await;

    // --- Second daemon: must restore the chat from the snapshot on boot. ---
    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;
    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&snap);

    let inst = inst.expect(
        "interactive session must be restored from the snapshot after a daemon restart",
    );
    assert_eq!(
        inst.get("kind").and_then(Value::as_str),
        Some("interactive"),
        "restored entry must be Interactive"
    );
    assert_eq!(
        inst.get("effort").and_then(Value::as_str),
        Some("high"),
        "effort must persist across the restart"
    );
    assert_eq!(
        inst.get("pid").and_then(Value::as_u64),
        Some(0),
        "restored entry is resumable (pid 0, no live process)"
    );
}

/// A session ended (clear_session -> mark_ended) before the daemon goes down
/// must NOT be resurrected on restart - the snapshot excludes ended entries.
/// Free + deterministic. Run serial (`--test-threads=1`).
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn ended_session_not_restored_after_daemon_restart() {
    let snap = interactive_snapshot_path();
    let _ = std::fs::remove_file(&snap);

    let session_id = format!("test-evict-{}", std::process::id());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();

    {
        let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;
        client
            .call("register_historical", json!({ "session_id": session_id, "cwd": cwd }))
            .await
            .expect("register_historical");
        client
            .call("mark_session_ended", json!({ "session_id": session_id }))
            .await
            .expect("mark_session_ended");
        drop(client);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = child.kill();
        let _ = child.wait();
    }

    tokio::time::sleep(Duration::from_millis(500)).await;

    let (mut child, client, _hook_port) = spawn_daemon_and_connect().await;
    let after = client.call("list_instances", json!({})).await.expect("list");
    let inst = find_instance(&after, &session_id).cloned();

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&snap);

    assert!(
        inst.is_none(),
        "a session ended before shutdown must NOT be restored after a daemon restart"
    );
}
