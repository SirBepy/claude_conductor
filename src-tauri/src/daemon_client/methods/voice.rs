use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// Runs the dictation cleanup pass on one raw transcript. Blocks for the
    /// sidecar's whole run (a few seconds), same shape as `ask_send`.
    pub async fn voice_clean_transcript(&self, text: &str) -> Result<Value, ClientError> {
        self.call("voice_clean_transcript", json!({"text": text})).await
    }
}
