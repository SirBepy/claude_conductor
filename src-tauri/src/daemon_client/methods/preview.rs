use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// Push an HTML preview snapshot (ai_todo 138). Desktop-only write path
    /// (mirrors the terminal-Claude curl to `/hooks/preview`); see
    /// `daemon::methods::registry`'s `push_preview` handler doc for why this
    /// is deliberately NOT remotely callable. Returns the snapshot id.
    pub async fn push_preview(
        &self,
        title: &str,
        slug: Option<&str>,
        html: &str,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<String, ClientError> {
        let res = self.call("push_preview", json!({
            "title": title,
            "slug": slug,
            "html": html,
            "source": source,
            "session_id": session_id,
        })).await?;
        res.get("id")
            .and_then(serde_json::Value::as_str)
            .map(|s| s.to_string())
            .ok_or_else(|| ClientError::Rpc { code: -32000, message: "push_preview: no id".into() })
    }

    /// Preview history metadata (no html), newest-first.
    pub async fn list_previews(&self) -> Result<Value, ClientError> {
        self.call("list_previews", Value::Null).await
    }

    /// Full preview snapshot (html included) by id.
    pub async fn get_preview(&self, id: &str) -> Result<Value, ClientError> {
        self.call("get_preview", json!({"id": id})).await
    }
}
