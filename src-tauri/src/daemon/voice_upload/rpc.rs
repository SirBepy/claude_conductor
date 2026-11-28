//! The three RPC methods over `UploadStore`. Disk work runs on the blocking pool.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::store::{Declared, Outcome, UploadKey, UploadStore, MAX_CHUNK_BYTES};
use crate::daemon::rpc::{ConnectionContext, Router, RpcError};

#[derive(Deserialize)]
struct BeginParams {
    recording_id: String,
    sha256: String,
    size_bytes: u64,
    #[serde(default)]
    recorded_at_ms: u64,
    #[serde(default)]
    duration_ms: u64,
}

#[derive(Deserialize)]
struct ChunkParams {
    recording_id: String,
    sha256: String,
    offset: u64,
    data_b64: String,
}

#[derive(Deserialize)]
struct StatusParams {
    recordings: Vec<StatusItem>,
}

#[derive(Deserialize)]
struct StatusItem {
    recording_id: String,
    sha256: String,
}

/// One status call asks about every recording the phone is waiting on.
const MAX_STATUS_ITEMS: usize = 200;

/// `{"states": {<recording_id>: "pending" | "done" | "failed" | "unknown"}}`.
/// `done` means the transcript is in the vault (or the clip held no speech);
/// `unknown` means the PC holds no verified copy, so the phone should upload it
/// again. A recording that is transcribed but not yet in the vault is `pending`.
pub(super) fn status_reply(store: &UploadStore, keys: &[(String, Option<UploadKey>)]) -> Value {
    let mut states = serde_json::Map::new();
    for (id, key) in keys {
        let state = match key.as_ref().and_then(|k| store.transcription_state(k)).as_deref() {
            None => "unknown",
            Some("done") => "done",
            Some("failed") => "failed",
            Some(_) => "pending",
        };
        states.insert(id.clone(), json!(state));
    }
    json!({ "states": states })
}

pub(super) fn reply(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Complete => json!({"status": "complete"}),
        Outcome::Partial { offset } => json!({"status": "partial", "offset": offset, "max_chunk": MAX_CHUNK_BYTES}),
        Outcome::OffsetMismatch { offset } => json!({"status": "offset_mismatch", "offset": offset}),
        Outcome::HashMismatch => json!({"status": "hash_mismatch"}),
        Outcome::NoUpload => json!({"status": "no_upload"}),
    }
}

/// The paired phone that authenticated this call. A call with none (the desktop
/// pipe) is refused: an upload with no device has nowhere to be filed.
fn device_of(ctx: &ConnectionContext) -> Result<String, RpcError> {
    ctx.device_id
        .clone()
        .ok_or_else(|| RpcError { code: -32600, message: "voice upload needs a paired phone connection".into(), data: None })
}

fn params<T: for<'de> Deserialize<'de>>(p: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(p.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, RpcError> {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(RpcError::invalid_params(e)),
        Err(e) => Err(RpcError::internal(format!("upload task failed: {e}"))),
    }
}

pub fn register_voice_upload(router: &mut Router, app_data: PathBuf) {
    let store = Arc::new(UploadStore::new(app_data.join("voice-notes").join("audio")));
    let s = store.clone();
    router.register("voice_upload_begin", move |p, ctx| {
        let s = s.clone();
        async move {
            let device = device_of(&ctx)?;
            let p: BeginParams = params(p)?;
            let key = UploadKey::parse(&device, &p.recording_id, &p.sha256).map_err(RpcError::invalid_params)?;
            let declared = Declared { size_bytes: p.size_bytes, recorded_at_ms: p.recorded_at_ms, duration_ms: p.duration_ms };
            let outcome = blocking(move || s.begin(&key, &declared)).await?;
            Ok(reply(&outcome))
        }
    });
    let s = store.clone();
    router.register("voice_transcription_status", move |p, ctx| {
        let s = s.clone();
        async move {
            let device = device_of(&ctx)?;
            let p: StatusParams = params(p)?;
            if p.recordings.len() > MAX_STATUS_ITEMS {
                return Err(RpcError::invalid_params(format!("ask about at most {MAX_STATUS_ITEMS} recordings")));
            }
            // A malformed item answers `unknown` for itself: one row with a stale
            // hash must not stop the phone hearing about the others.
            let keys: Vec<_> = p
                .recordings
                .iter()
                .map(|item| (item.recording_id.clone(), UploadKey::parse(&device, &item.recording_id, &item.sha256).ok()))
                .collect();
            blocking(move || Ok(status_reply(&s, &keys))).await
        }
    });
    let s = store;
    router.register("voice_upload_chunk", move |p, ctx| {
        let s = s.clone();
        async move {
            let device = device_of(&ctx)?;
            let p: ChunkParams = params(p)?;
            let key = UploadKey::parse(&device, &p.recording_id, &p.sha256).map_err(RpcError::invalid_params)?;
            // Checked before decoding so an oversized string never becomes a big allocation.
            if p.data_b64.len() > MAX_CHUNK_BYTES / 3 * 4 + 8 {
                return Err(RpcError::invalid_params(format!("a chunk is at most {MAX_CHUNK_BYTES} bytes")));
            }
            let data = base64::engine::general_purpose::STANDARD
                .decode(p.data_b64.as_bytes())
                .map_err(|e| RpcError::invalid_params(format!("data_b64 is not base64: {e}")))?;
            let offset = p.offset;
            let outcome = blocking(move || s.chunk(&key, offset, &data)).await?;
            Ok(reply(&outcome))
        }
    });
}
