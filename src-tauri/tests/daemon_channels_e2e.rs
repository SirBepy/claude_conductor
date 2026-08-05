//! End-to-end: a SessionStart hook for a pid that matches NO daemon channel
//! stays `External` (the safe default). The Automated true-positive requires a
//! live `claude --remote-control` process and is covered by the manual smoke
//! checklist, not here.
//!
//! `#[ignore]`'d (binds port 27182). Run manually:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_channels_e2e -- --ignored --nocapture

#![cfg(windows)]

use claude_conductor_lib::daemon_client::PersistentClient;
use claude_conductor_lib::types::Settings;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::sync::mpsc::Receiver;

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
            Ok(None) => panic!("channel closed waiting for `{method}`"),
            Err(_) => panic!("no `{method}` within {budget:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn external_session_without_matching_channel_stays_external() {
    // Isolated test instance (ai_todo 71): distinct pipe/lock + ephemeral hook
    // port discovered from the suffixed port file.
    const INSTANCE: &str = "test-channels";
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");
    let app_data = dirs::data_dir().unwrap().join("claude-conductor");
    let _ = std::fs::remove_file(app_data.join(format!("daemon-{INSTANCE}.lock")));
    let port_file = app_data.join(format!("hooks_port-{INSTANCE}.txt"));
    let _ = std::fs::remove_file(&port_file);

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

    tokio::time::sleep(Duration::from_millis(700)).await;

    let mut hook_port = String::new();
    for _ in 0..30 {
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if !p.trim().is_empty() { hook_port = p.trim().to_string(); break; }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!hook_port.is_empty(), "daemon did not write its hook port file");

    let client = PersistentClient::connect(&pipe_name).await.expect("connect");
    client.push_settings(&Settings::default()).await.expect("push_settings");
    let mut rx = client.subscribe_global().await.expect("subscribe");

    let http = reqwest::Client::new();
    let resp = http.post(format!("http://127.0.0.1:{hook_port}/hooks/session-start"))
        .json(&json!({
            "session_id": "ext-no-channel",
            "cwd": "C:\\tmp\\daemon-ch-e2e",
            "pid": 88888,
            "transcript_path": null,
            "source": "startup"
        }))
        .send().await.expect("POST");
    assert!(resp.status().is_success());

    let notif = wait_for_method(&mut rx, "instances_changed", Duration::from_secs(2)).await;
    let instances = notif["params"]["instances"].as_array().expect("instances");
    let inst = instances.iter().find(|i| i["session_id"] == json!("ext-no-channel")).expect("registered");
    // No channel has pid 88888, so kind must be External, is_remote false.
    // InstanceKind::External serializes as "external" (serde rename_all = "lowercase").
    // Instance.is_remote serializes as "is_remote" (no rename on the struct).
    assert_eq!(inst["kind"], json!("external"), "got: {inst}");
    assert_eq!(inst["is_remote"], json!(false), "got: {inst}");

    drop(client);
    let _ = child.kill();
    let _ = child.wait();
}
