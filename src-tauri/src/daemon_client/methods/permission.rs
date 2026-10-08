use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

/// Builds `respond_permission`'s RPC params. `session_id` is the prompt's
/// owning chat, not an identifying param of this call (the prompt is keyed
/// on `request_id`) - it rides along purely so `machines/forward.rs`'s
/// generic `extract_session_id` can route the answer to the peer that owns
/// a mirrored chat's prompt. `None` serializes to `null`, which the daemon's
/// local (non-forwarded) path already ignores.
fn respond_permission_params(
    request_id: &str,
    allow: bool,
    updated_input: Option<Value>,
    message: Option<String>,
    session_id: Option<&str>,
) -> Value {
    json!({
        "request_id": request_id,
        "allow": allow,
        "updated_input": updated_input,
        "message": message,
        "session_id": session_id,
    })
}

/// Builds `respond_question`'s RPC params. Same `session_id` rationale as
/// `respond_permission_params` above.
fn respond_question_params(request_id: &str, answers: Value, skipped: bool, session_id: Option<&str>) -> Value {
    json!({
        "request_id": request_id,
        "answers": answers,
        "skipped": skipped,
        "session_id": session_id,
    })
}

impl PersistentClient {
    pub async fn respond_permission(
        &self,
        request_id: &str,
        allow: bool,
        updated_input: Option<serde_json::Value>,
        message: Option<String>,
        session_id: Option<&str>,
    ) -> Result<(), ClientError> {
        let params = respond_permission_params(request_id, allow, updated_input, message, session_id);
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
        session_id: Option<&str>,
    ) -> Result<bool, ClientError> {
        let params = respond_question_params(request_id, answers, skipped, session_id);
        let result = self.call("respond_question", params).await?;
        Ok(result.get("delivered").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    /// Tells `on_question_request` a client committed to this question's fate,
    /// so its ack means "reached a client" (todo 735). Fires on a rendered card
    /// AND on a parked one; `respond_question` above resolves only on a real
    /// answer, so the two are not interchangeable.
    pub async fn confirm_question_rendered(&self, id: &str, session_id: Option<&str>) -> Result<(), ClientError> {
        self.call("confirm_question_rendered", json!({ "id": id, "session_id": session_id }))
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

#[cfg(test)]
mod tests {
    use super::{respond_permission_params, respond_question_params};
    use serde_json::json;

    #[test]
    fn respond_permission_params_carries_session_id_when_given() {
        let v = respond_permission_params("req1", true, Some(json!({"a": 1})), None, Some("sess-b"));
        assert_eq!(v.get("session_id").and_then(|x| x.as_str()), Some("sess-b"));
        assert_eq!(v.get("request_id").and_then(|x| x.as_str()), Some("req1"));
    }

    #[test]
    fn respond_permission_params_session_id_absent_serializes_null() {
        let v = respond_permission_params("req1", false, None, Some("no".into()), None);
        assert!(v.get("session_id").unwrap().is_null());
    }

    #[test]
    fn respond_question_params_carries_session_id_when_given() {
        let v = respond_question_params("req2", json!({"q1": "yes"}), false, Some("sess-c"));
        assert_eq!(v.get("session_id").and_then(|x| x.as_str()), Some("sess-c"));
        assert_eq!(v.get("skipped").and_then(|x| x.as_bool()), Some(false));
    }

    #[test]
    fn respond_question_params_session_id_absent_serializes_null() {
        let v = respond_question_params("req2", json!({}), true, None);
        assert!(v.get("session_id").unwrap().is_null());
    }
}
