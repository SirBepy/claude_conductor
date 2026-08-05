//! End-to-end: the APP binary launched with `--daemon` runs the daemon (Phase 6
//! Task 2) - same flow `ensure_daemon` uses in production to spawn the daemon.
//! Mirrors daemon_smoke but spawns `claude-conductor.exe --daemon` instead of
//! the standalone bin, proving the arg branch routes to `run_daemon_main`.
//!
//! `#[ignore]`'d: building the full app bin is heavy and dist-sensitive, and
//! daemon_smoke already covers `run_daemon_main`. Run manually:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test app_daemon_mode_e2e -- --ignored --nocapture

#![cfg(windows)]

use claude_conductor_lib::daemon::frame::{read_frame, write_frame};
use claude_conductor_lib::daemon::health::PROTOCOL_VERSION;
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::net::windows::named_pipe::ClientOptions;

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn app_binary_daemon_mode_serves_and_shuts_down() {
    // Isolated test instance (ai_todo 71): distinct pipe/lockfile/hook-port.
    const INSTANCE: &str = "test-appdaemon";

    let build = Command::new("cargo")
        .args(["build", "--bin", "claude-conductor"])
        .current_dir(std::env::current_dir().unwrap())
        .status()
        .expect("cargo build");
    assert!(build.success(), "cargo build --bin claude-conductor failed");

    // Derive from this test binary rather than assuming ./target: .cargo/config.toml
    // redirects target-dir off the repo.
    let mut exe = std::env::current_exe().unwrap();
    exe.pop();
    exe.pop();
    exe.push("claude-conductor.exe");
    assert!(exe.exists(), "app exe missing: {}", exe.display());

    if let Some(app_data) = dirs::data_dir() {
        let lock = app_data.join("claude-conductor").join(format!("daemon-{INSTANCE}.lock"));
        let _ = std::fs::remove_file(&lock);
    }

    // Spawn the APP binary in --daemon mode. This is exactly what the app does
    // via spawn_self::spawn_detached_daemon in production.
    let mut child = Command::new(&exe)
        .arg("--daemon")
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn app --daemon");

    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");

    let mut pipe = None;
    for _ in 0..60 {
        match ClientOptions::new().open(&pipe_name) {
            Ok(p) => { pipe = Some(p); break; }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let mut pipe = match pipe {
        Some(p) => p,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("app --daemon did not bind the pipe within 6s");
        }
    };

    // Handshake + health.
    write_frame(&mut pipe, &json!({"protocol_version": PROTOCOL_VERSION})).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["handshake"], json!("ok"));

    write_frame(&mut pipe, &json!({
        "jsonrpc": "2.0", "id": 1, "method": "health", "params": null
    })).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert!(resp["result"]["daemon_version"].is_string());

    // Graceful shutdown via RPC; the app-daemon process must exit on its own.
    write_frame(&mut pipe, &json!({
        "jsonrpc": "2.0", "id": 2, "method": "shutdown_daemon", "params": null
    })).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["result"], json!({"ok": true}));
    drop(pipe);

    let mut exited = false;
    for _ in 0..60 {
        match child.try_wait() {
            Ok(Some(_)) => { exited = true; break; }
            Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
            Err(e) => panic!("try_wait failed: {e}"),
        }
    }
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
        panic!("app --daemon did not exit within 6s after shutdown_daemon RPC");
    }
}
