//! End-to-end integration test for Phase 2 daemon session lifecycle.
//!
//! Manual run only:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_session_e2e -- --ignored --nocapture
//!
//! This test SPAWNS A REAL CLAUDE PROCESS and burns the user's subscription
//! quota. The prompt is intentionally tiny (~5 tokens).

#![cfg(windows)]

use claude_conductor_lib::daemon_client::PersistentClient;
use serde_json::json;
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

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn end_to_end_one_turn() {
    // Isolated test instance: distinct pipe/lockfile/hook-port so this never
    // touches a real daemon (ai_todo 71). No `Stop-Process cc-conductor-daemon`
    // on purpose - that used to kill the user's real daemon.
    const INSTANCE: &str = "test-session";
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");
    if let Some(app_data) = dirs::data_dir() {
        let lock = app_data.join("claude-conductor").join(format!("daemon-{INSTANCE}.lock"));
        let _ = std::fs::remove_file(&lock);
    }

    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-conductor-daemon"])
        .status()
        .expect("cargo build");
    assert!(build.success());

    let exe = daemon_exe();
    let mut child = Command::new(&exe)
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");

    tokio::time::sleep(Duration::from_millis(800)).await;

    let client = PersistentClient::connect(&pipe_name)
        .await.expect("connect");

    // Start session in a temp cwd that definitely exists.
    let cwd = std::env::temp_dir();
    let cwd_str = cwd.to_string_lossy().to_string();
    let start_resp = client.call("start_session", json!({
        "cwd": cwd_str,
        "model": "haiku",
        "effort": "low",
        "resume_id": null,
    })).await.expect("start_session");
    let session_id = start_resp["session_id"].as_str()
        .expect("session_id").to_string();
    eprintln!("started session {session_id}");

    let mut rx = client.attach_session(&session_id).await.expect("attach");

    // Send a tiny prompt.
    client.call("send_message", json!({
        "session_id": session_id,
        "text": "reply with the literal word OK and stop.",
    })).await.expect("send_message");

    // Drain notifications looking for some evidence the turn ran.
    // ChatEvent uses internally-tagged serde: {"type": "assistant_message", ...}
    // Variant type field values (snake_case): session_started, user_message,
    // assistant_message, tool_use, tool_result, notification, session_ended,
    // turn_usage.
    let mut events_seen = 0;
    let mut saw_assistant_or_result = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(notif)) => {
                events_seen += 1;
                // ChatEvent is serialized internally-tagged; the "type" field
                // holds the snake_case variant name.
                let variant = notif.pointer("/params/event")
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                eprintln!("notif #{events_seen}: variant={variant:?}");
                if let Some(k) = variant.as_deref() {
                    if k == "assistant_message" || k == "turn_usage" || k == "session_ended" {
                        saw_assistant_or_result = true;
                        if k == "turn_usage" || k == "session_ended" {
                            break;
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                eprintln!("timeout waiting for next event; events_seen={events_seen}");
                if saw_assistant_or_result {
                    break;
                }
            }
        }
    }

    eprintln!("---- E2E RESULT ----");
    eprintln!("events_seen: {events_seen}");
    eprintln!("saw assistant_message/turn_usage/session_ended: {saw_assistant_or_result}");

    // End session cleanly.
    let _ = client.call("end_session", json!({"session_id": session_id})).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = child.kill();
    let _ = child.wait();

    assert!(saw_assistant_or_result,
        "expected at least an assistant_message, turn_usage, or session_ended event for the turn (events_seen={events_seen})");
}
