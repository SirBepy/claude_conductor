use super::super::{ClientError, PersistentClient};
use serde_json::Value;

impl PersistentClient {
    pub async fn health(&self) -> Result<Value, ClientError> {
        self.call("health", Value::Null).await
    }

    /// Tell the daemon to stop (kill channels + exit the process).
    pub async fn shutdown_daemon(&self) -> Result<(), ClientError> {
        self.call("shutdown_daemon", Value::Null).await.map(|_| ())
    }

    pub async fn push_settings(&self, settings: &crate::types::Settings) -> Result<(), ClientError> {
        let v = serde_json::to_value(settings)
            .map_err(|e| ClientError::Rpc { code: -32000, message: format!("serialize settings: {e}") })?;
        self.call("set_settings", v).await?;
        Ok(())
    }

    /// Forward a freshly-polled usage snapshot to the daemon so it can fan it
    /// out over `/api/global/stream` (see `daemon/methods/usage.rs`'s
    /// `notify_usage_snapshot` handler) to non-Tauri local consumers. Pipe-side
    /// only - not in `remote_handlers::SAFE_METHODS`.
    pub async fn notify_usage_snapshot(&self, snap: &crate::types::UsageSnapshot) -> Result<(), ClientError> {
        let v = serde_json::to_value(snap)
            .map_err(|e| ClientError::Rpc { code: -32000, message: format!("serialize snapshot: {e}") })?;
        self.call("notify_usage_snapshot", v).await?;
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::daemon::health::PROTOCOL_VERSION;
    use serde_json::json;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    // Shared with the `tests/daemon_schedule_e2e.rs` integration test (ai_todo
    // 268) - one physical copy of the kill-on-drop guard instead of two
    // hand-maintained near-duplicates (`KillOnDrop` vs `ChildGuard`).
    #[path = "../../../../../tests/support/mod.rs"]
    mod test_support;
    use test_support::ChildGuard;

    #[tokio::test(flavor = "current_thread")]
    async fn persistent_client_health_against_real_daemon() {
        // Isolated test instance: distinct pipe/lockfile/hook-port so this never
        // touches a real daemon the user has running (ai_todo 71). NOTE: no
        // `Stop-Process cc-conductor-daemon` here on purpose - that used to kill
        // the user's real daemon.
        const INSTANCE: &str = "test-pclient";
        // Same shared pipe-name builder the daemon itself binds with
        // (ai_todo 267), rather than a hand-rolled copy of the string format.
        let pipe_name = crate::daemon::transport_windows::pipe_name_for_suffix(&format!("-{INSTANCE}"));

        // Clear only THIS instance's stale lockfile.
        if let Some(app_data) = dirs::data_dir() {
            let lock = app_data.join("claude-conductor").join(format!("daemon-{INSTANCE}.lock"));
            let _ = std::fs::remove_file(&lock);
        }

        // Retry the build: a just-killed prior test daemon (or a concurrently
        // rebuilding `cargo tauri dev` watcher) can hold the old
        // cc-conductor-daemon.exe's file handle open for a brief moment after
        // exit, making cargo's file-replace step fail with a transient
        // "Access is denied" (os error 5) rather than a real build error.
        let mut build_ok = false;
        for attempt in 0..3 {
            let build = Command::new("cargo")
                .args(["build", "--bin", "cc-conductor-daemon"])
                .current_dir(std::env::current_dir().unwrap())
                .status()
                .expect("cargo build");
            if build.success() {
                build_ok = true;
                break;
            }
            if attempt < 2 {
                std::thread::sleep(Duration::from_secs(2));
            }
        }
        assert!(build_ok, "cargo build --bin cc-conductor-daemon failed after retries");

        // Derive from this test binary (<target-dir>/debug/deps/x.exe) rather than
        // assuming ./target: .cargo/config.toml redirects target-dir off the repo.
        let mut exe = std::env::current_exe().unwrap();
        exe.pop();
        exe.pop();
        exe.push("cc-conductor-daemon.exe");
        let child = Command::new(&exe)
            .env("CC_DAEMON_INSTANCE", INSTANCE)
            // Don't launch real automation channels from a test daemon.
            .env("CC_DAEMON_NO_AUTOSTART", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn daemon");
        // Kills the spawned daemon on drop - including when a panic unwinds
        // out of an assertion below. Without this, a single failed run (health
        // check fails, connect times out, etc.) leaks this process forever: it
        // keeps holding cc-conductor-daemon.exe open, so EVERY subsequent run
        // of this test fails cargo's build step with "Access is denied"
        // (os error 5) until someone notices and kills it by hand (as happened
        // 2026-07-17 - a run failed hours earlier and the orphan silently
        // broke every re-run after it).
        let _child = ChildGuard::new(child);

        // Poll for the pipe to bind rather than a single fixed-delay attempt:
        // under system load (e.g. a concurrent `cargo tauri dev` rebuild) the
        // daemon can take longer than any one fixed sleep to come up, and a
        // single connect attempt afterward has no way to recover from that.
        // Mirrors `ensure_daemon`'s own post-spawn poll.
        let mut client = None;
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Ok(c) = PersistentClient::connect(&pipe_name).await {
                client = Some(c);
                break;
            }
        }
        let client = client.expect("connect (daemon never bound its pipe)");
        let result = client.health().await.expect("health call");
        assert!(result["daemon_version"].is_string());
        assert_eq!(result["protocol_version"], json!(PROTOCOL_VERSION));
    }
}
