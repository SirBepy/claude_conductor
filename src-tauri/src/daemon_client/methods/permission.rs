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

    /// Tells `on_question_request` a client committed to this question's fate,
    /// so its ack means "reached a client" (todo 735). Fires on a rendered card
    /// AND on a parked one; `respond_question` above resolves only on a real
    /// answer, so the two are not interchangeable.
    pub async fn confirm_question_rendered(&self, id: &str) -> Result<(), ClientError> {
        self.call("confirm_question_rendered", serde_json::json!({ "id": id }))
            .await?;
        Ok(())
    }

    /// Open prompts the app must surface (question cards), fetched over the
    /// reliable RPC channel rather than the lossy notifier broadcast. Polled by
    /// the app so a dropped broadcast frame can't hang an AskUserQuestion turn.
    pub async fn list_pending_prompts(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_pending_prompts", json!({})).await
    }

    /// Durable Skip marks for `session_id` (todo 661) - a non-paginated point
    /// query, folded in client-side rather than spliced into `history_page.rs`'s
    /// cursor-based stream. A malformed reply degrades to no marks, never an error.
    pub async fn get_skipped_question_marks(&self, session_id: &str) -> Result<Vec<i64>, ClientError> {
        let params = json!({ "session_id": session_id });
        let result = self.call("get_skipped_question_marks", params).await?;
        Ok(result.as_array().map(|a| a.iter().filter_map(|v| v.as_i64()).collect()).unwrap_or_default())
    }
}
