use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// This project's draft cards. `session_id` is the caller's identity, which
    /// is what resolves the project - it is never passed as an argument.
    pub async fn list_message_drafts(&self, session_id: &str) -> Result<Value, ClientError> {
        self.call("list_message_drafts", json!({"session_id": session_id})).await
    }

    /// The user's own edit. Appends a version rather than overwriting, and
    /// clears `seen_by_origin` so the next turn is told what changed.
    pub async fn set_draft_body(
        &self,
        session_id: &str,
        id: &str,
        recipient: &str,
        body: &str,
    ) -> Result<Value, ClientError> {
        self.call(
            "set_draft_body",
            json!({"session_id": session_id, "id": id, "recipient": recipient, "body": body}),
        )
        .await
    }

    /// Revert: makes an existing version current, never deleting the later ones.
    pub async fn set_draft_version(
        &self,
        session_id: &str,
        id: &str,
        recipient: &str,
        n: u32,
    ) -> Result<Value, ClientError> {
        self.call(
            "set_draft_version",
            json!({"session_id": session_id, "id": id, "recipient": recipient, "n": n}),
        )
        .await
    }

    pub async fn set_draft_state(&self, session_id: &str, id: &str, next: &str) -> Result<Value, ClientError> {
        self.call("set_draft_state", json!({"session_id": session_id, "id": id, "state": next})).await
    }

    pub async fn delete_draft(&self, session_id: &str, id: &str) -> Result<Value, ClientError> {
        self.call("delete_draft", json!({"session_id": session_id, "id": id})).await
    }
}
