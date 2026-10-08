use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// `{"sessions": [...], "projects": [...]}` - every chat hidden into the
    /// sidebar's Hidden section, and every project cwd the rail filters out.
    pub async fn get_hidden_chats(&self) -> Result<Value, ClientError> {
        self.call("get_hidden_chats", json!({})).await
    }

    /// Hide/unhide as a delta; answers with the resulting full lists.
    pub async fn update_hidden_chats(
        &self,
        add: Vec<String>,
        remove: Vec<String>,
        add_projects: Vec<String>,
        remove_projects: Vec<String>,
    ) -> Result<Value, ClientError> {
        self.call(
            "update_hidden_chats",
            json!({"add": add, "remove": remove, "add_projects": add_projects, "remove_projects": remove_projects}),
        )
        .await
    }
}
