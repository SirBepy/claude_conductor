//! Chat-attachment RPCs: read (phone render) and paste (phone upload).

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_attachments(router: &mut Router, _state: Arc<DaemonState>) {
    // Mirrors `read_attachment` (params: path) -> { mime, base64 }. Lets the
    // phone render pasted chat-image attachments. The underlying fn canonicalizes
    // the path and rejects anything outside <app-data>/chat-attachments/, so this
    // is NOT an arbitrary-file-read primitive despite taking a path. (Distinct
    // from `read_image_file`, deliberately NOT exposed: it reads arbitrary paths.)
    router.register("read_attachment", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { path: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let data = crate::ipc::chat::attachments::read_attachment(p.path)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(data))
        }
    });
    // Mirrors `paste_attachment` (params: session_id, base64_data, mime) -> path
    // string. Lets the phone PWA's composer paperclip upload an image/file: the
    // bytes are written into <app-data>/chat-attachments/<session>/ on the PC and
    // the returned path becomes a <file:...> mention claude reads via its Read
    // tool. write_attachment validates the session_id (rejects path traversal),
    // so this is not an arbitrary-write primitive despite taking a session id.
    router.register("paste_attachment", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { session_id: String, base64_data: String, mime: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let root = crate::settings::paths::data_dir()
                .map_err(|e| RpcError::internal(e.to_string()))?;
            let path = crate::ipc::chat::attachments::write_attachment(
                &root, &p.session_id, &p.base64_data, &p.mime,
            )
            .map_err(RpcError::internal)?;
            Ok(json!(path.to_string_lossy().to_string()))
        }
    });
}
