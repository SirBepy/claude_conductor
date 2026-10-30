use super::super::{ClientError, PersistentClient};
use super::bad_shape;
use crate::ipc::chat::attachments::AttachmentData;
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

    /// Preview history metadata (no html), newest-first. A `session_id` of a
    /// chat mirrored from a paired machine makes the daemon read that
    /// machine's store; any session id also narrows the list to that chat.
    pub async fn list_previews(&self, session_id: Option<&str>) -> Result<Value, ClientError> {
        self.call("list_previews", list_previews_params(session_id)).await
    }

    /// Full preview snapshot (html included) by id. `session_id` is the chat
    /// the panel is showing: it routes the call to the host for a mirrored chat.
    /// `version` picks an archived page; `None` is the latest.
    pub async fn get_preview(&self, id: &str, session_id: Option<&str>, version: Option<u32>) -> Result<Value, ClientError> {
        self.call("get_preview", get_preview_params(id, session_id, version)).await
    }

    /// One raster image off the HOST's disk for a chat mirrored from a paired
    /// machine (option-preview pictures, agent-surfaced images). The host
    /// confines the path; see `daemon/methods/registry/image_read.rs`.
    pub async fn read_image_file(&self, path: &str, session_id: &str) -> Result<AttachmentData, ClientError> {
        let res = self.call("read_image_file", json!({"path": path, "session_id": session_id})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("read_image_file", e))
    }
}

fn list_previews_params(session_id: Option<&str>) -> Value {
    match session_id {
        Some(sid) => json!({"session_id": sid}),
        None => Value::Null,
    }
}

fn get_preview_params(id: &str, session_id: Option<&str>, version: Option<u32>) -> Value {
    let mut params = json!({"id": id});
    if let Some(sid) = session_id {
        params["session_id"] = json!(sid);
    }
    if let Some(v) = version {
        params["version"] = json!(v);
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_params_carry_the_session_id_the_daemon_routes_on() {
        assert_eq!(list_previews_params(Some("s1")), json!({"session_id": "s1"}));
        assert_eq!(list_previews_params(None), Value::Null);
        assert_eq!(get_preview_params("p1", Some("s1"), None), json!({"id": "p1", "session_id": "s1"}));
        assert_eq!(get_preview_params("p1", None, None), json!({"id": "p1"}));
        assert_eq!(get_preview_params("p1", Some("s1"), Some(3)), json!({"id": "p1", "session_id": "s1", "version": 3}));
    }
}
