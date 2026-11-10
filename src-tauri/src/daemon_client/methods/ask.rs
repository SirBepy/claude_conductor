use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// Every Ask thread for one chat, newest first.
    pub async fn ask_list_threads(&self, session_id: &str) -> Result<Value, ClientError> {
        self.call("ask_list_threads", json!({"session_id": session_id})).await
    }
}
