//! Resumable chunked upload of voice notes from a paired phone (todo pc-1852,
//! round R4). The phone's native uploader (`android/src-tauri/src/voice_upload/`)
//! calls two RPC methods over the iroh tunnel's `POST /api/rpc`:
//!
//! - `voice_upload_begin {recording_id, sha256, size_bytes, recorded_at_ms,
//!   duration_ms}` answers where the PC's copy stands, so a dropped tunnel
//!   resumes instead of restarting and a recording the PC already holds is
//!   `complete` at once.
//! - `voice_upload_chunk {recording_id, sha256, offset, data_b64}` appends one
//!   chunk when `offset` is exactly the PC's length; the last one verifies the
//!   sha256 and publishes the file.
//!
//! Idempotent by (device id, recording id, sha256): the device id is the
//! authenticated connection's (`ConnectionContext::device_id`, taken from the
//! bearer token by `remote_server::auth_mw`), never a param. Both methods are
//! phone-only rows in `remote_transport_table.rs`. Audio lands in
//! `<app data>/voice-notes/audio/<device id>/`; `store::set_transcription_hook`
//! is where R5 takes each verified recording.

mod rpc;
pub mod store;
#[cfg(test)]
mod tests;

pub use rpc::register_voice_upload;
