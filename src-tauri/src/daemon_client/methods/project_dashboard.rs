use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    pub async fn dashboard_groups_list(&self) -> Result<Value, ClientError> {
        self.call("dashboard_groups_list", json!({})).await
    }

    pub async fn dashboard_group_upsert(
        &self,
        id: Option<&str>,
        name: &str,
        repos: Vec<String>,
    ) -> Result<Value, ClientError> {
        self.call("dashboard_group_upsert", json!({"id": id, "name": name, "repos": repos})).await
    }

    pub async fn dashboard_group_delete(&self, id: &str) -> Result<Value, ClientError> {
        self.call("dashboard_group_delete", json!({"id": id})).await
    }

    pub async fn dashboard_cards_list(&self, scope: Value) -> Result<Value, ClientError> {
        self.call("dashboard_cards_list", json!({"scope": scope})).await
    }

    pub async fn dashboard_card_refresh(&self, id: &str) -> Result<Value, ClientError> {
        self.call("dashboard_card_refresh", json!({"id": id})).await
    }

    pub async fn dashboard_card_set_enabled(&self, id: &str, enabled: bool) -> Result<Value, ClientError> {
        self.call("dashboard_card_set_enabled", json!({"id": id, "enabled": enabled})).await
    }

    pub async fn dashboard_card_delete(&self, id: &str) -> Result<Value, ClientError> {
        self.call("dashboard_card_delete", json!({"id": id})).await
    }

    pub async fn dashboard_builtin_set_hidden(
        &self,
        scope: Value,
        builtin: &str,
        hidden: bool,
    ) -> Result<Value, ClientError> {
        self.call("dashboard_builtin_set_hidden", json!({"scope": scope, "builtin": builtin, "hidden": hidden}))
            .await
    }

    /// Project-keyed todo tick: the dashboard has no session to resolve a project from.
    pub async fn dashboard_todo_set_state(&self, project_id: &str, id: &str, next: &str) -> Result<Value, ClientError> {
        self.call("dashboard_todo_set_state", json!({"project_id": project_id, "id": id, "next": next})).await
    }

    pub async fn dashboard_list_targets(&self) -> Result<Value, ClientError> {
        self.call("dashboard_list_targets", json!({})).await
    }

    pub async fn dashboard_snapshot(&self, target: Value) -> Result<Value, ClientError> {
        self.call("dashboard_snapshot", json!({"target": target})).await
    }

    pub async fn dashboard_history(&self, target: Value) -> Result<Value, ClientError> {
        self.call("dashboard_history", json!({"target": target})).await
    }

    pub async fn dashboard_gallery_image(&self, id: &str) -> Result<Value, ClientError> {
        self.call("dashboard_gallery_image", json!({"id": id})).await
    }

    pub async fn dashboard_close_target(&self, target: Value) -> Result<Value, ClientError> {
        self.call("dashboard_close_target", json!({"target": target})).await
    }

    pub async fn dashboard_open_target(&self, target: Value) -> Result<Value, ClientError> {
        self.call("dashboard_open_target", json!({"target": target})).await
    }

    pub async fn dashboard_set_pinned_actions(&self, scope: Value, actions: Vec<String>) -> Result<Value, ClientError> {
        self.call("dashboard_set_pinned_actions", json!({"scope": scope, "actions": actions})).await
    }
}
