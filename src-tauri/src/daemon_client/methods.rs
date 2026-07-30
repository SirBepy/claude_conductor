//! Typed one-line RPC wrapper methods on `PersistentClient`. Split out of
//! `mod.rs` (which keeps the transport/connection plumbing: `connect`,
//! `call`, subscription bookkeeping, address construction, `ensure_daemon`)
//! purely to keep file size manageable - ai_todo 265. Pure code motion, no
//! behavior change.

use super::{ClientError, PersistentClient};
use serde_json::{json, Value};

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

    pub async fn respond_permission(
        &self,
        request_id: &str,
        allow: bool,
        updated_input: Option<serde_json::Value>,
        message: Option<String>,
    ) -> Result<(), ClientError> {
        let params = serde_json::json!({
            "request_id": request_id,
            "allow": allow,
            "updated_input": updated_input,
            "message": message,
        });
        self.call("respond_permission", params).await?;
        Ok(())
    }

    pub async fn respond_question(
        &self,
        request_id: &str,
        answers: serde_json::Value,
    ) -> Result<(), ClientError> {
        let params = serde_json::json!({
            "request_id": request_id,
            "answers": answers,
        });
        self.call("respond_question", params).await?;
        Ok(())
    }

    /// Open prompts the app must surface (question cards), fetched over the
    /// reliable RPC channel rather than the lossy notifier broadcast. Polled by
    /// the app so a dropped broadcast frame can't hang an AskUserQuestion turn.
    pub async fn list_pending_prompts(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_pending_prompts", json!({})).await
    }

    pub async fn start_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("start_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn stop_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("stop_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn restart_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("restart_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn show_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("show_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn hide_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("hide_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn list_channels(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_channels", json!({})).await
    }

    /// Snapshot of the daemon's instance registry (array of Instance JSON).
    /// Seeded into the app cache on connect so live sessions render immediately.
    pub async fn list_instances(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_instances", json!({})).await
    }

    /// Get-or-spawn the singleton Jarvis session (`daemon/methods/jarvis.rs`,
    /// todo 272). Returns its session_id - either the still-live pointer
    /// already recorded in settings, or a freshly-spawned one.
    pub async fn ensure_jarvis_session(&self) -> Result<String, ClientError> {
        let v = self.call("ensure_jarvis_session", Value::Null).await?;
        v.get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ClientError::Rpc {
                code: -32000,
                message: "ensure_jarvis_session: response missing session_id".into(),
            })
    }

    /// Start (or resume) a daemon-owned session. Returns the real session_id.
    pub async fn start_session(
        &self,
        cwd: &str,
        model: &str,
        effort: &str,
        resume_id: Option<&str>,
        remote: bool,
        account_id: Option<&str>,
    ) -> Result<String, ClientError> {
        let res = self
            .call("start_session", json!({
                "cwd": cwd,
                "model": model,
                "effort": effort,
                "resume_id": resume_id,
                "remote": remote,
                "account_id": account_id,
            }))
            .await?;
        res.get("session_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "start_session: no session_id in result".into() })
    }

    pub async fn send_message(&self, session_id: &str, text: &str) -> Result<(), ClientError> {
        self.call("send_message", json!({"session_id": session_id, "text": text})).await?;
        Ok(())
    }

    pub async fn cancel_turn(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("cancel_turn", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn end_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("end_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    /// Debug builds only: inject a synthetic rate-limit rejection into
    /// `session_id`, driving the real blocked-state + scheduled-resume path.
    /// The daemon rejects this method in release builds.
    pub async fn simulate_rate_limit(
        &self,
        session_id: &str,
        resets_in_secs: i64,
        kind: &str,
    ) -> Result<(), ClientError> {
        self.call("simulate_rate_limit", json!({
            "session_id": session_id,
            "resets_in_secs": resets_in_secs,
            "kind": kind,
        }))
        .await?;
        Ok(())
    }

    /// Fork `session_id`'s transcript onto `target_account_id`: spawns a new
    /// session id resumed from the old one on the new account, replays the
    /// pending rate-limit resume prompt (if any) into it, then retires the
    /// old session. Returns the new session_id.
    pub async fn move_session_to_account(
        &self,
        session_id: &str,
        target_account_id: &str,
    ) -> Result<String, ClientError> {
        let res = self
            .call("move_session_to_account", json!({
                "session_id": session_id,
                "target_account_id": target_account_id,
            }))
            .await?;
        res.get("session_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "move_session_to_account: no session_id in result".into() })
    }

    pub async fn mark_session_ended(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("mark_session_ended", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn externalize_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("externalize_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn set_session_effort(&self, session_id: &str, effort: &str) -> Result<(), ClientError> {
        self.call("set_session_effort", json!({"session_id": session_id, "effort": effort})).await?;
        Ok(())
    }

    pub async fn set_session_model(&self, session_id: &str, model: &str) -> Result<(), ClientError> {
        self.call("set_session_model", json!({"session_id": session_id, "model": model})).await?;
        Ok(())
    }

    pub async fn set_auto_accept(&self, session_id: &str, value: bool) -> Result<(), ClientError> {
        self.call("set_auto_accept", json!({"session_id": session_id, "value": value})).await?;
        Ok(())
    }

    pub async fn register_historical(&self, session_id: &str, cwd: &str, account_id: &str) -> Result<(), ClientError> {
        self.call("register_historical", json!({"session_id": session_id, "cwd": cwd, "account_id": account_id})).await?;
        Ok(())
    }

    /// Create a scheduled item (message or new-chat). `kind`/`recurrence` are
    /// pre-serialized JSON (the caller builds them from the typed
    /// `ScheduledKind`/`Recurrence` enums) so this client stays daemon-schema
    /// agnostic like the rest of the file. Returns the daemon-built
    /// `ScheduledItem` (id/created_at/status assigned there).
    pub async fn schedule_create(
        &self,
        kind: Value,
        prompt: &str,
        fire_at: &str,
        recurrence: Option<Value>,
    ) -> Result<Value, ClientError> {
        self.call("schedule_create", json!({
            "kind": kind,
            "prompt": prompt,
            "fire_at": fire_at,
            "recurrence": recurrence,
        })).await
    }

    /// Overwrite an existing scheduled item. `item` is the full, already-typed
    /// `ScheduledItem` JSON (round-tripped from `schedule_list`, edited, and
    /// sent back) - the daemon rejects an unknown id.
    pub async fn schedule_update(&self, item: Value) -> Result<(), ClientError> {
        self.call("schedule_update", item).await?;
        Ok(())
    }

    pub async fn schedule_delete(&self, id: &str) -> Result<(), ClientError> {
        self.call("schedule_delete", json!({"id": id})).await?;
        Ok(())
    }

    /// Fire a scheduled item immediately instead of waiting for the next
    /// ~30s scheduler tick.
    pub async fn schedule_fire_now(&self, id: &str) -> Result<(), ClientError> {
        self.call("schedule_fire_now", json!({"id": id})).await?;
        Ok(())
    }

    pub async fn takeover_manual(&self, manual_pid: u32, model: &str, effort: &str, account_id: &str) -> Result<String, ClientError> {
        let res = self.call("takeover_manual", json!({"manual_pid": manual_pid, "model": model, "effort": effort, "account_id": account_id})).await?;
        res.get("session_id")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "takeover_manual: no session_id".into() })
    }

    /// Push an HTML preview snapshot (ai_todo 138). Desktop-only write path
    /// (mirrors the terminal-Claude curl to `/hooks/preview`); see
    /// `daemon::methods::registry`'s `push_preview` handler doc for why this
    /// is deliberately NOT remotely callable. Returns the snapshot id.
    pub async fn push_preview(
        &self,
        title: &str,
        slug: Option<&str>,
        html: &str,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<String, ClientError> {
        let res = self.call("push_preview", json!({
            "title": title,
            "slug": slug,
            "html": html,
            "source": source,
            "session_id": session_id,
        })).await?;
        res.get("id")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "push_preview: no id".into() })
    }

    /// Preview history metadata (no html), newest-first.
    pub async fn list_previews(&self) -> Result<Value, ClientError> {
        self.call("list_previews", Value::Null).await
    }

    /// Full preview snapshot (html included) by id.
    pub async fn get_preview(&self, id: &str) -> Result<Value, ClientError> {
        self.call("get_preview", json!({"id": id})).await
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::daemon::health::PROTOCOL_VERSION;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    // Shared with the `tests/daemon_schedule_e2e.rs` integration test (ai_todo
    // 268) - one physical copy of the kill-on-drop guard instead of two
    // hand-maintained near-duplicates (`KillOnDrop` vs `ChildGuard`).
    #[path = "../../../../tests/support/mod.rs"]
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

        let mut exe = std::env::current_dir().unwrap();
        exe.push("target");
        exe.push("debug");
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
