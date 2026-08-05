//! End-to-end smoke for the daemon binary. Spawns the daemon, connects over
//! the Windows named pipe, runs the handshake + a `health` RPC, then verifies
//! the `shutdown_daemon` RPC makes the daemon exit on its own (Phase 6 Task 6).
//!
//! Only runs on Windows in Phase 1; the Unix transport isn't shipped yet.
//!
//! NOTE: a single daemon-spawning test per file - the daemon is a singleton
//! (fixed pipe + lockfile), so two such tests in one bin would race the lock
//! when cargo runs them in parallel (see ai_todo 71).

#![cfg(windows)]

use claude_conductor_lib::daemon::frame::{read_frame, write_frame};
use claude_conductor_lib::daemon::health::PROTOCOL_VERSION;
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::net::windows::named_pipe::ClientOptions;

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
async fn handshake_health_and_graceful_shutdown() {
    // Build the daemon first; cargo doesn't auto-build sibling [[bin]]s for
    // integration tests of the lib crate.
    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-conductor-daemon"])
        .current_dir(std::env::current_dir().unwrap())
        .status()
        .expect("cargo build");
    assert!(build.success(), "cargo build failed");

    let exe = daemon_exe();
    assert!(exe.exists(), "daemon exe missing: {}", exe.display());

    // Isolated test instance: distinct pipe/lockfile/hook-port so this never
    // touches a real daemon the user has running (ai_todo 71). Unique per test
    // bin since cargo runs test binaries in parallel.
    const INSTANCE: &str = "test-smoke";

    // Clear any stale lockfile from a previous failed run; a zombie PID in
    // the lockfile would block the new daemon from acquiring the lock.
    if let Some(app_data) = dirs::data_dir() {
        let lock = app_data.join("claude-conductor").join(format!("daemon-{INSTANCE}.lock"));
        let _ = std::fs::remove_file(&lock);
    }

    // Spawn daemon. stdio piped so we can kill cleanly on failure.
    let mut child = Command::new(&exe)
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");

    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");

    // Retry-connect with a short backoff until the daemon has bound the pipe.
    let mut pipe = None;
    for _ in 0..50 {
        match ClientOptions::new().open(&pipe_name) {
            Ok(p) => { pipe = Some(p); break; }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    let mut pipe = match pipe {
        Some(p) => p,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("connect to daemon pipe within 2.5s");
        }
    };

    // Handshake.
    write_frame(&mut pipe, &json!({"protocol_version": PROTOCOL_VERSION})).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["handshake"], json!("ok"));
    assert_eq!(resp["protocol_version"], json!(PROTOCOL_VERSION));

    // Health RPC.
    write_frame(&mut pipe, &json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "health",
        "params": null
    })).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["jsonrpc"], json!("2.0"));
    assert_eq!(resp["id"], json!(1));
    assert!(resp["result"]["daemon_version"].is_string());
    assert_eq!(resp["result"]["protocol_version"], json!(PROTOCOL_VERSION));

    // Graceful shutdown via RPC: the daemon must exit on its OWN (Phase 6
    // Task 6 - the run_daemon_main select arm), not be killed by us.
    write_frame(&mut pipe, &json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "shutdown_daemon",
        "params": null
    })).await.unwrap();
    let resp = read_frame(&mut pipe).await.unwrap();
    assert_eq!(resp["result"], json!({"ok": true}));
    drop(pipe);

    let mut exited = false;
    for _ in 0..60 {
        match child.try_wait() {
            Ok(Some(_status)) => { exited = true; break; }
            Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
            Err(e) => panic!("try_wait failed: {e}"),
        }
    }
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
        panic!("daemon did not exit within 6s after shutdown_daemon RPC");
    }
}
