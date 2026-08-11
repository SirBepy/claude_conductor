use super::super::{ClientError, PersistentClient};
use serde_json::json;

impl PersistentClient {
    pub async fn start_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("start_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn stop_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("stop_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn restart_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("restart_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn show_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("show_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn hide_channel(&self, project_id: &str) -> Result<(), ClientError> {
        self.call("hide_channel", json!({"project_id": project_id})).await?;
        Ok(())
    }

    pub async fn list_channels(&self) -> Result<serde_json::Value, ClientError> {
        self.call("list_channels", json!({})).await
    }
}
