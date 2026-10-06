use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// `{"sessions": [...]}` - every chat hidden into the sidebar's Hidden section.
    pub async fn get_hidden_chats(&self) -> Result<Value, ClientError> {
        self.call("get_hidden_chats", json!({})).await
    }

    /// Hide/unhide as a delta; answers with the resulting full list.
    pub async fn update_hidden_chats(&self, add: Vec<String>, remove: Vec<String>) -> Result<Value, ClientError> {
        self.call("update_hidden_chats", json!({"add": add, "remove": remove})).await
    }
}
