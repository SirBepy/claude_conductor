use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// Uploads preview `id` to claude.ai and returns `{published}`. Blocks
    /// for the sidecar's whole run.
    pub async fn publish_to_claude_ai(&self, id: &str) -> Result<Value, ClientError> {
        self.call("publish_to_claude_ai", json!({ "id": id })).await
    }
}
