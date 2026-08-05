//! End-to-end: POST a SessionStart hook to the daemon, observe the
//! `instances_changed` notification reach the persistent client.
//!
//! `#[ignore]`'d because it binds port 27182 - conflicts with any running
//! local daemon and is unsuitable for parallel CI. Run manually with:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_hooks_e2e -- --ignored --nocapture

#![cfg(windows)]

use claude_conductor_lib::daemon_client::PersistentClient;
use claude_conductor_lib::types::Settings;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::sync::mpsc::Receiver;

/// Drains notifications off the global subscription until one with the given
/// `method` arrives, panicking if the budget elapses first. A brand-new cwd
/// emits a leading `project_created` notification before `instances_changed`,
/// so the assertion can't just read the first frame.
async fn wait_for_method(rx: &mut Receiver<Value>, method: &str, budget: Duration) -> Value {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(notif)) => {
                if notif["method"] == json!(method) {
                    return notif;
                }
            }
            Ok(None) => panic!("notification channel closed while waiting for `{method}`"),
            Err(_) => panic!("no `{method}` notification arrived within {budget:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn session_start_hook_round_trips_to_client_notification() {
    // Isolated test instance: distinct pipe/lockfile + ephemeral hook port so
    // this never fights a real daemon for 27182 (ai_todo 71). The daemon writes
    // its actual hook port to a suffixed file we read below.
    const INSTANCE: &str = "test-hooks";
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");
    let app_data = dirs::data_dir().unwrap().join("claude-conductor");
    let _ = std::fs::remove_file(app_data.join(format!("daemon-{INSTANCE}.lock")));
    let port_file = app_data.join(format!("hooks_port-{INSTANCE}.txt"));
    let _ = std::fs::remove_file(&port_file);

    // Build + spawn daemon.
    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-conductor-daemon"])
        .current_dir(std::env::current_dir().unwrap())
        .status()
        .expect("cargo build");
    assert!(build.success());
    // Derive from this test binary rather than assuming ./target: .cargo/config.toml
    // redirects target-dir off the repo.
    let mut exe = std::env::current_exe().unwrap();
    exe.pop();
    exe.pop();
    exe.push("cc-conductor-daemon.exe");
    let mut child = Command::new(&exe)
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");

    // Give the daemon time to bind both the pipe AND the hook port.
    tokio::time::sleep(Duration::from_millis(700)).await;

    // Discover the ephemeral hook port the daemon wrote.
    let mut hook_port = String::new();
    for _ in 0..30 {
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if !p.trim().is_empty() { hook_port = p.trim().to_string(); break; }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!hook_port.is_empty(), "daemon did not write its hook port file");

    let client = PersistentClient::connect(&pipe_name).await.expect("client connect");
    client.push_settings(&Settings::default()).await.expect("push_settings");
    let mut rx = client.subscribe_global().await.expect("subscribe_global");

    // POST a synthetic SessionStart.
    let body = json!({
        "session_id": "test-sess-abc",
        "cwd": "C:\\tmp\\daemon-e2e",
        "pid": 99999,
        "transcript_path": null,
        "source": "startup"
    });
    let http = reqwest::Client::new();
    let resp = http.post(format!("http://127.0.0.1:{hook_port}/hooks/session-start"))
        .json(&body)
        .send().await.expect("POST");
    assert!(resp.status().is_success());

    // A brand-new cwd emits `project_created` first; skip past it to the
    // `instances_changed` we care about.
    let notif = wait_for_method(&mut rx, "instances_changed", Duration::from_secs(2)).await;
    let instances = notif["params"]["instances"].as_array().expect("instances array");
    assert!(instances.iter().any(|i| i["session_id"] == json!("test-sess-abc")));

    // Mark ended.
    let resp = http.post(format!("http://127.0.0.1:{hook_port}/hooks/session-end"))
        .json(&json!({"session_id": "test-sess-abc", "reason": "test-cleanup"}))
        .send().await.expect("POST end");
    assert!(resp.status().is_success());

    let notif = wait_for_method(&mut rx, "instances_changed", Duration::from_secs(2)).await;
    assert_eq!(notif["method"], json!("instances_changed"));

    // Cleanup.
    drop(client);
    let _ = child.kill();
    let _ = child.wait();
}
