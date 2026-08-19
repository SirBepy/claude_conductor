use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// This project's cards plus this chat's saved column visibility, in one
    /// round-trip. `session_id` is both the reader's identity (it resolves the
    /// project) and the frame of reference the panel derives card scope from.
    pub async fn list_user_todos(&self, session_id: &str) -> Result<Value, ClientError> {
        self.call("list_user_todos", json!({"session_id": session_id})).await
    }

    /// Joe's own tick/untick. Clears `seen_by_origin` daemon-side, which is
    /// what raises the notify CTA.
    pub async fn set_user_todo_state(&self, session_id: &str, id: &str, state: &str) -> Result<Value, ClientError> {
        self.call("set_user_todo_state", json!({"session_id": session_id, "id": id, "state": state})).await
    }

    /// The `Notify` button's explicit push. The injection hook does the same
    /// flip on its own when a turn reads the cards.
    pub async fn mark_todos_seen(&self, session_id: &str, origin_session_id: &str) -> Result<Value, ClientError> {
        self.call(
            "mark_todos_seen",
            json!({"session_id": session_id, "origin_session_id": origin_session_id}),
        )
        .await
    }

    pub async fn set_todo_columns(&self, session_id: &str, columns: Vec<String>) -> Result<Value, ClientError> {
        self.call("set_todo_columns", json!({"session_id": session_id, "columns": columns})).await
    }

    pub async fn clear_archived_todos(&self, session_id: &str) -> Result<Value, ClientError> {
        self.call("clear_archived_todos", json!({"session_id": session_id})).await
    }
}
