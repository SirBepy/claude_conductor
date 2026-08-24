use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// Every Ask thread for one chat, newest first.
    pub async fn ask_list_threads(&self, session_id: &str) -> Result<Value, ClientError> {
        self.call("ask_list_threads", json!({"session_id": session_id})).await
    }

    /// Asks one question and returns the updated thread. `thread_id` `None`
    /// starts a new thread. Blocks for the sidecar's whole run.
    pub async fn ask_send(
        &self,
        session_id: &str,
        thread_id: Option<&str>,
        question: &str,
        cwd: Option<&str>,
    ) -> Result<Value, ClientError> {
        self.call(
            "ask_send",
            json!({"session_id": session_id, "thread_id": thread_id, "question": question, "cwd": cwd}),
        )
        .await
    }

    /// Returns the remaining threads, so the index can repaint from one call.
    pub async fn ask_delete_thread(&self, session_id: &str, thread_id: &str) -> Result<Value, ClientError> {
        self.call("ask_delete_thread", json!({"session_id": session_id, "thread_id": thread_id})).await
    }
}
