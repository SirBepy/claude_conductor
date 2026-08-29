use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
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
    ///
    /// `placeholder_id` is the caller's idempotency key: pass the same value on
    /// a retry and the daemon returns the session the first attempt already
    /// spawned instead of spawning a second one (`daemon::start_tokens`).
    pub async fn start_session(
        &self,
        cwd: &str,
        model: &str,
        effort: &str,
        resume_id: Option<&str>,
        remote: bool,
        account_id: Option<&str>,
        auto_accept: bool,
        placeholder_id: Option<&str>,
    ) -> Result<String, ClientError> {
        let res = self
            .call("start_session", json!({
                "cwd": cwd,
                "model": model,
                "effort": effort,
                "resume_id": resume_id,
                "remote": remote,
                "account_id": account_id,
                "auto_accept": auto_accept,
                "placeholder_id": placeholder_id,
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

    /// Force-kill the Jarvis singleton's live child (if any) and respawn it
    /// resuming the SAME session id - the kebab menu's "Restart Jarvis"
    /// action (`daemon::methods::jarvis::register_jarvis`'s
    /// `restart_jarvis_session` RPC). Returns the (unchanged) session id so
    /// the frontend can re-select the pane in place.
    pub async fn restart_jarvis_session(&self, session_id: &str) -> Result<String, ClientError> {
        let res = self
            .call("restart_jarvis_session", json!({"session_id": session_id}))
            .await?;
        res.get("session_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "restart_jarvis_session: no session_id in result".into() })
    }

    /// Force-end the Jarvis singleton's live child and respawn a genuinely
    /// fresh one - the kebab menu's "Clear context" action. Unlike
    /// `restart_jarvis_session`, the returned id is NEW; the old transcript
    /// is discarded.
    pub async fn clear_jarvis_context(&self, session_id: &str) -> Result<String, ClientError> {
        let res = self
            .call("clear_jarvis_context", json!({"session_id": session_id}))
            .await?;
        res.get("session_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "clear_jarvis_context: no session_id in result".into() })
    }

    pub async fn mark_session_ended(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("mark_session_ended", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn externalize_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("externalize_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    /// Chat menu's "Freeze chat" (`daemon::methods::registry::register_chat_registry`'s
    /// `freeze_session` RPC).
    pub async fn freeze_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("freeze_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    /// Chat menu's "Unfreeze chat" - counterpart to `freeze_session`.
    pub async fn unfreeze_session(&self, session_id: &str) -> Result<(), ClientError> {
        self.call("unfreeze_session", json!({"session_id": session_id})).await?;
        Ok(())
    }

    pub async fn set_session_effort(&self, session_id: &str, effort: &str) -> Result<(), ClientError> {
        self.call("set_session_effort", json!({"session_id": session_id, "effort": effort})).await?;
        Ok(())
    }

    /// Returns whether the daemon killed+respawned the session's live process
    /// to apply the new model immediately (false when the session wasn't live,
    /// so the change is only cached for its next natural respawn).
    pub async fn set_session_model(&self, session_id: &str, model: &str) -> Result<bool, ClientError> {
        let res = self
            .call("set_session_model", json!({"session_id": session_id, "model": model}))
            .await?;
        Ok(res.get("restarted").and_then(Value::as_bool).unwrap_or(false))
    }

    pub async fn set_auto_accept(&self, session_id: &str, value: bool) -> Result<(), ClientError> {
        self.call("set_auto_accept", json!({"session_id": session_id, "value": value})).await?;
        Ok(())
    }

    pub async fn register_historical(&self, session_id: &str, cwd: &str, account_id: &str) -> Result<(), ClientError> {
        self.call("register_historical", json!({"session_id": session_id, "cwd": cwd, "account_id": account_id})).await?;
        Ok(())
    }

    pub async fn takeover_manual(&self, manual_pid: u32, model: &str, effort: &str, account_id: &str) -> Result<String, ClientError> {
        let res = self.call("takeover_manual", json!({"manual_pid": manual_pid, "model": model, "effort": effort, "account_id": account_id})).await?;
        res.get("session_id")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "takeover_manual: no session_id".into() })
    }
}
