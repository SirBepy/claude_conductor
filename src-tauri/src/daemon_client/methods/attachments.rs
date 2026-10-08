//! Typed wrappers for the daemon's attachment RPCs
//! (`daemon/methods/registry/attachments.rs`). Used by `ipc/chat/attachments.rs`
//! when a session is mirrored from a paired peer: this machine's disk holds
//! neither the file the remote `claude` will Read (a local paste) nor the
//! bytes a remote composer just uploaded (a local read), so both calls must
//! land on the OWNING peer's own `<app-data>/chat-attachments/` instead.

use super::super::{ClientError, PersistentClient};
use crate::ipc::chat::attachments::AttachmentData;
use serde_json::{json, Value};

/// Builds `paste_attachment`'s RPC params.
fn paste_attachment_params(session_id: &str, base64_data: &str, mime: &str) -> Value {
    json!({
        "session_id": session_id,
        "base64_data": base64_data,
        "mime": mime,
    })
}

/// Builds `read_attachment`'s RPC params. `session_id` is optional and
/// unused by the handler itself (it always validates `path` against its own
/// chat-attachments root) - it rides along purely so
/// `machines/forward.rs::extract_session_id` can route the read to the
/// owning peer for a mirrored chat.
fn read_attachment_params(path: &str, session_id: Option<&str>) -> Value {
    json!({
        "path": path,
        "session_id": session_id,
    })
}

impl PersistentClient {
    /// Writes a pasted/dropped attachment into the OWNING peer's
    /// `<app-data>/chat-attachments/<session>/` and returns its path there -
    /// the composer turns that path into a `<file:...>` mention the remote
    /// `claude` can Read. Only called once `ipc::chat::attachments` has
    /// already decided `session_id` is mirrored; a local chat keeps writing
    /// directly via `write_attachment`.
    pub async fn paste_attachment(
        &self,
        session_id: &str,
        base64_data: &str,
        mime: &str,
    ) -> Result<String, ClientError> {
        let res = self
            .call("paste_attachment", paste_attachment_params(session_id, base64_data, mime))
            .await?;
        res.as_str().map(|s| s.to_string()).ok_or_else(|| ClientError::Rpc {
            code: -32000,
            message: "paste_attachment: result was not a path string".into(),
        })
    }

    /// Reads a previously-pasted attachment off the OWNING peer's disk for a
    /// mirrored chat - the remote counterpart of `read_attachment_impl`'s
    /// local read for a chat hosted on this machine.
    pub async fn read_attachment(&self, path: &str, session_id: Option<&str>) -> Result<AttachmentData, ClientError> {
        let res = self.call("read_attachment", read_attachment_params(path, session_id)).await?;
        serde_json::from_value(res).map_err(|e| ClientError::Rpc {
            code: -32000,
            message: format!("read_attachment: bad result shape: {e}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{paste_attachment_params, read_attachment_params};

    #[test]
    fn read_attachment_params_carries_session_id_when_given() {
        let v = read_attachment_params("/path/x.png", Some("sess-a"));
        assert_eq!(v.get("session_id").and_then(|x| x.as_str()), Some("sess-a"));
        assert_eq!(v.get("path").and_then(|x| x.as_str()), Some("/path/x.png"));
    }

    #[test]
    fn read_attachment_params_session_id_absent_serializes_null() {
        let v = read_attachment_params("/path/x.png", None);
        assert!(v.get("session_id").unwrap().is_null());
    }

    #[test]
    fn paste_attachment_params_carries_session_and_mime() {
        let v = paste_attachment_params("sess-b", "QQ==", "image/png");
        assert_eq!(v.get("session_id").and_then(|x| x.as_str()), Some("sess-b"));
        assert_eq!(v.get("mime").and_then(|x| x.as_str()), Some("image/png"));
        assert_eq!(v.get("base64_data").and_then(|x| x.as_str()), Some("QQ=="));
    }
}
