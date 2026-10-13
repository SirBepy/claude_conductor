use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// `{"on", "paused_sessions", "stopped_procs", "stopped_containers",
    /// "docker_desktop_stopped"}` - current gaming-mode state plus a short
    /// summary of the last transition (see `daemon::gaming_mode::GamingModeSummary`).
    pub async fn get_gaming_mode(&self) -> Result<Value, ClientError> {
        self.call("get_gaming_mode", json!({})).await
    }

    /// Toggles gaming mode; answers with the same shape as `get_gaming_mode`.
    pub async fn set_gaming_mode(&self, on: bool) -> Result<Value, ClientError> {
        self.call("set_gaming_mode", json!({"on": on})).await
    }
}
