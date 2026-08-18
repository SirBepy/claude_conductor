use super::super::{ClientError, PersistentClient};
use serde_json::json;

impl PersistentClient {
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

    /// Returns whether a live blocking waiter was resolved (the answer already
    /// went back in-band, as the tool's own result) vs. a durable/ghost prompt
    /// with no waiter (the answer must travel separately as a chat message) -
    /// see `respond_question_inner`'s `delivered` in methods/permission.rs.
    /// `skipped` marks a real Skip - see that fn's doc comment.
    pub async fn respond_question(
        &self,
        request_id: &str,
        answers: serde_json::Value,
        skipped: bool,
    ) -> Result<bool, ClientError> {
        let params = serde_json::json!({
            "request_id": request_id,
            "answers": answers,
            "skipped": skipped,
        });
        let result = self.call("respond_question", params).await?;
        Ok(result.get("delivered").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    /// Open prompts the app must surface (question cards), fetched over the
    /// reliable RPC channel rather than the lossy notifier broadcast. Polled by
    /// the app so a dropped broadcast frame can't hang an AskUserQuestion turn.
    pub async fn list_pending_prompts(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_pending_prompts", json!({})).await
    }
}
