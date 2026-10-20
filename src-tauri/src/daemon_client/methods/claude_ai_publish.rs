use super::super::{ClientError, PersistentClient};
use serde_json::Value;

impl PersistentClient {
    /// Uploads a preview or draft to claude.ai and returns `{published}`.
    /// `params` is passed through as-is (its `target` tag picks which); blocks
    /// for the sidecar's whole run.
    pub async fn publish_to_claude_ai(&self, params: Value) -> Result<Value, ClientError> {
        self.call("publish_to_claude_ai", params).await
    }
}
