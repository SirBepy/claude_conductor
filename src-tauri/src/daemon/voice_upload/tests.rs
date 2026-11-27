use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::rpc::reply;
use super::store::*;
use super::register_voice_upload;
use crate::daemon::rpc::{ConnectionContext, Request, Router};

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn audio(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 251) as u8).collect()
}

fn declared(bytes: &[u8]) -> Declared {
    Declared { size_bytes: bytes.len() as u64, recorded_at_ms: 1_700_000_000_000, duration_ms: 60_000 }
}

fn key(device: &str, rec: &str, bytes: &[u8]) -> UploadKey {
    UploadKey::parse(device, rec, &sha(bytes)).unwrap()
}

fn store_with_log(root: &std::path::Path) -> (UploadStore, Arc<Mutex<Vec<Received>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (UploadStore::new(root.to_path_buf()).with_hook(move |r| sink.lock().unwrap().push(r.clone())), seen)
}

/// Sends `bytes` in `step`-sized chunks from `from`, returning the last outcome.
fn send(store: &UploadStore, k: &UploadKey, bytes: &[u8], from: usize, step: usize) -> Outcome {
    let mut last = Outcome::Partial { offset: from as u64 };
    let mut at = from;
    while at < bytes.len() {
        let end = (at + step).min(bytes.len());
        last = store.chunk(k, at as u64, &bytes[at..end]).unwrap();
        at = end;
    }
    last
}

#[test]
fn a_whole_upload_is_verified_published_and_handed_to_transcription_once() {
    let dir = tempfile::tempdir().unwrap();
    let (store, seen) = store_with_log(dir.path());
    let bytes = audio(10_000);
    let k = key("dev1", "rec1", &bytes);
    assert_eq!(store.begin(&k, &declared(&bytes)).unwrap(), Outcome::Partial { offset: 0 });
    assert_eq!(send(&store, &k, &bytes, 0, 3_000), Outcome::Complete);
    let published = dir.path().join("dev1").join(format!("rec1-{}.opus", &sha(&bytes)[..16]));
    assert_eq!(std::fs::read(&published).unwrap(), bytes);
    let got = seen.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "the hook fires once per verified recording");
    assert_eq!(got[0].device_id, "dev1");
    assert_eq!(got[0].audio, published);
    assert_eq!(store.pending_transcriptions().len(), 1);
}

#[test]
fn a_dropped_tunnel_resumes_from_what_the_pc_holds() {
    let dir = tempfile::tempdir().unwrap();
    let (store, seen) = store_with_log(dir.path());
    let bytes = audio(10_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    store.chunk(&k, 0, &bytes[..4_000]).unwrap();
    // The tunnel drops here; the phone asks again and is told where to resume.
    assert_eq!(store.begin(&k, &declared(&bytes)).unwrap(), Outcome::Partial { offset: 4_000 });
    assert_eq!(send(&store, &k, &bytes, 4_000, 4_000), Outcome::Complete);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn a_resume_survives_a_daemon_restart() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = audio(6_000);
    let k = key("dev1", "rec1", &bytes);
    {
        let (store, _) = store_with_log(dir.path());
        store.begin(&k, &declared(&bytes)).unwrap();
        store.chunk(&k, 0, &bytes[..2_500]).unwrap();
    }
    let (fresh, seen) = store_with_log(dir.path());
    assert_eq!(fresh.begin(&k, &declared(&bytes)).unwrap(), Outcome::Partial { offset: 2_500 });
    assert_eq!(send(&fresh, &k, &bytes, 2_500, 2_500), Outcome::Complete);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn a_chunk_that_arrives_twice_is_written_once() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = store_with_log(dir.path());
    let bytes = audio(5_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    assert_eq!(store.chunk(&k, 0, &bytes[..2_000]).unwrap(), Outcome::Partial { offset: 2_000 });
    // The answer was lost, so the phone sends the same chunk again.
    assert_eq!(store.chunk(&k, 0, &bytes[..2_000]).unwrap(), Outcome::OffsetMismatch { offset: 2_000 });
    assert_eq!(send(&store, &k, &bytes, 2_000, 5_000), Outcome::Complete);
    let published = dir.path().join("dev1").join(format!("rec1-{}.opus", &sha(&bytes)[..16]));
    assert_eq!(std::fs::read(published).unwrap(), bytes, "no byte was written twice");
}

#[test]
fn a_chunk_ahead_of_the_pc_is_refused_with_the_real_offset() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = store_with_log(dir.path());
    let bytes = audio(5_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    assert_eq!(store.chunk(&k, 1_000, &bytes[1_000..2_000]).unwrap(), Outcome::OffsetMismatch { offset: 0 });
}

#[test]
fn a_recording_already_held_is_complete_and_never_duplicated() {
    let dir = tempfile::tempdir().unwrap();
    let (store, seen) = store_with_log(dir.path());
    let bytes = audio(4_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    assert_eq!(send(&store, &k, &bytes, 0, 4_000), Outcome::Complete);
    // The phone lost the final answer and starts the whole upload over.
    assert_eq!(store.begin(&k, &declared(&bytes)).unwrap(), Outcome::Complete);
    assert_eq!(store.chunk(&k, 0, &bytes[..1_000]).unwrap(), Outcome::Complete);
    assert_eq!(seen.lock().unwrap().len(), 1, "transcription is queued once");
    let files = std::fs::read_dir(dir.path().join("dev1")).unwrap().count();
    assert_eq!(files, 2, "one audio file and its receipt, nothing else");
}

#[test]
fn a_hash_mismatch_drops_the_partial_and_publishes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (store, seen) = store_with_log(dir.path());
    let bytes = audio(3_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    let mut corrupt = bytes.clone();
    corrupt[10] ^= 0xff;
    assert_eq!(send(&store, &k, &corrupt, 0, 1_000), Outcome::HashMismatch);
    assert!(seen.lock().unwrap().is_empty());
    assert!(!dir.path().join("dev1").join(format!("rec1-{}.opus", &sha(&bytes)[..16])).exists());
    // The partial is gone, so the next attempt starts clean and succeeds.
    assert_eq!(store.begin(&k, &declared(&bytes)).unwrap(), Outcome::Partial { offset: 0 });
    assert_eq!(send(&store, &k, &bytes, 0, 1_000), Outcome::Complete);
}

#[test]
fn a_chunk_without_a_begin_is_told_to_begin() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = store_with_log(dir.path());
    let bytes = audio(100);
    assert_eq!(store.chunk(&key("dev1", "rec1", &bytes), 0, &bytes).unwrap(), Outcome::NoUpload);
}

#[test]
fn the_same_recording_id_from_two_devices_is_filed_apart() {
    let dir = tempfile::tempdir().unwrap();
    let (store, seen) = store_with_log(dir.path());
    let bytes = audio(2_000);
    for device in ["devA", "devB"] {
        let k = key(device, "rec1", &bytes);
        store.begin(&k, &declared(&bytes)).unwrap();
        assert_eq!(send(&store, &k, &bytes, 0, 2_000), Outcome::Complete);
    }
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[test]
fn the_same_recording_id_with_other_content_is_a_separate_upload() {
    let dir = tempfile::tempdir().unwrap();
    let (store, seen) = store_with_log(dir.path());
    let first = audio(2_000);
    let second = audio(2_001);
    for bytes in [&first, &second] {
        let k = key("dev1", "rec1", bytes);
        store.begin(&k, &declared(bytes)).unwrap();
        assert_eq!(send(&store, &k, bytes, 0, 2_001), Outcome::Complete);
    }
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[test]
fn a_changed_size_declaration_starts_the_partial_over() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = store_with_log(dir.path());
    let bytes = audio(5_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    store.chunk(&k, 0, &bytes[..2_000]).unwrap();
    let other = Declared { size_bytes: 6_000, ..declared(&bytes) };
    assert_eq!(store.begin(&k, &other).unwrap(), Outcome::Partial { offset: 0 });
}

#[test]
fn a_chunk_past_the_declared_size_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = store_with_log(dir.path());
    let bytes = audio(1_000);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    assert!(store.chunk(&k, 0, &audio(1_001)).is_err());
}

#[test]
fn names_that_could_leave_the_audio_folder_are_refused() {
    let good = sha(b"x");
    for bad in ["../x", "a/b", "a\\b", "", "a.b", &"x".repeat(65), "C:x"] {
        assert!(UploadKey::parse("dev1", bad, &good).is_err(), "recording id {bad:?}");
        assert!(UploadKey::parse(bad, "rec1", &good).is_err(), "device id {bad:?}");
    }
    assert!(UploadKey::parse("dev1", "rec1", &good.to_uppercase()).is_err());
    assert!(UploadKey::parse("dev1", "rec1", "abc").is_err());
}

#[test]
fn an_oversized_or_empty_declaration_and_chunk_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = store_with_log(dir.path());
    let k = key("dev1", "rec1", b"x");
    assert!(store.begin(&k, &Declared { size_bytes: 0, recorded_at_ms: 0, duration_ms: 0 }).is_err());
    assert!(store.begin(&k, &Declared { size_bytes: MAX_RECORDING_BYTES + 1, recorded_at_ms: 0, duration_ms: 0 }).is_err());
    store.begin(&k, &Declared { size_bytes: 10, recorded_at_ms: 0, duration_ms: 0 }).unwrap();
    assert!(store.chunk(&k, 0, &[]).is_err());
    assert!(store.chunk(&k, 0, &vec![0u8; MAX_CHUNK_BYTES + 1]).is_err());
}

#[test]
fn pending_transcriptions_lists_a_recording_that_arrived_before_any_hook() {
    let dir = tempfile::tempdir().unwrap();
    let store = UploadStore::new(dir.path().to_path_buf());
    let bytes = audio(1_500);
    let k = key("dev1", "rec1", &bytes);
    store.begin(&k, &declared(&bytes)).unwrap();
    send(&store, &k, &bytes, 0, 1_500);
    let pending = store.pending_transcriptions();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].recording_id, "rec1");
    assert_eq!(pending[0].recorded_at_ms, 1_700_000_000_000);
}

#[test]
fn the_reply_shapes_are_what_the_phone_reads() {
    assert_eq!(reply(&Outcome::Complete), json!({"status": "complete"}));
    assert_eq!(reply(&Outcome::Partial { offset: 5 })["offset"], json!(5));
    assert_eq!(reply(&Outcome::OffsetMismatch { offset: 9 }), json!({"status": "offset_mismatch", "offset": 9}));
    assert_eq!(reply(&Outcome::HashMismatch)["status"], json!("hash_mismatch"));
    assert_eq!(reply(&Outcome::NoUpload)["status"], json!("no_upload"));
}

// ---- Through the router, as the phone's /api/rpc call reaches it ----

async fn call(router: &Router, device: Option<&str>, method: &str, params: Value) -> Result<Value, crate::daemon::rpc::RpcError> {
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let mut ctx = ConnectionContext::new(tx);
    ctx.device_id = device.map(str::to_string);
    let resp = router
        .dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) }, ctx)
        .await;
    match resp.error {
        Some(e) => Err(e),
        None => Ok(resp.result.unwrap_or(Value::Null)),
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn the_methods_upload_a_file_in_chunks_and_resume_after_a_drop() {
    let dir = tempfile::tempdir().unwrap();
    let mut router = Router::new();
    register_voice_upload(&mut router, dir.path().to_path_buf());
    let bytes = audio(7_000);
    let hash = sha(&bytes);
    let begin = json!({"recording_id": "rec1", "sha256": hash, "size_bytes": 7_000, "recorded_at_ms": 5, "duration_ms": 9});
    let first = call(&router, Some("dev1"), "voice_upload_begin", begin.clone()).await.unwrap();
    assert_eq!(first["status"], "partial");
    assert_eq!(first["offset"], 0);
    let chunk = |offset: usize, end: usize| json!({"recording_id": "rec1", "sha256": hash, "offset": offset, "data_b64": b64(&bytes[offset..end])});
    assert_eq!(call(&router, Some("dev1"), "voice_upload_chunk", chunk(0, 3_000)).await.unwrap()["offset"], 3_000);
    // Resume.
    let again = call(&router, Some("dev1"), "voice_upload_begin", begin.clone()).await.unwrap();
    assert_eq!(again["offset"], 3_000);
    assert_eq!(call(&router, Some("dev1"), "voice_upload_chunk", chunk(3_000, 7_000)).await.unwrap()["status"], "complete");
    // A duplicate begin after completion is complete, not a second copy.
    assert_eq!(call(&router, Some("dev1"), "voice_upload_begin", begin).await.unwrap()["status"], "complete");
}

#[tokio::test]
async fn a_call_with_no_paired_device_or_bad_params_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut router = Router::new();
    register_voice_upload(&mut router, dir.path().to_path_buf());
    let begin = json!({"recording_id": "rec1", "sha256": sha(b"x"), "size_bytes": 1});
    assert_eq!(call(&router, None, "voice_upload_begin", begin.clone()).await.unwrap_err().code, -32600);
    assert_eq!(call(&router, Some("dev1"), "voice_upload_begin", json!({"recording_id": "rec1"})).await.unwrap_err().code, -32602);
    let traversal = json!({"recording_id": "../x", "sha256": sha(b"x"), "size_bytes": 1});
    assert_eq!(call(&router, Some("dev1"), "voice_upload_begin", traversal).await.unwrap_err().code, -32602);
    let junk = json!({"recording_id": "rec1", "sha256": sha(b"x"), "offset": 0, "data_b64": "!!!not base64"});
    assert_eq!(call(&router, Some("dev1"), "voice_upload_chunk", junk).await.unwrap_err().code, -32602);
}

#[tokio::test]
async fn the_device_comes_from_the_connection_never_from_params() {
    let dir = tempfile::tempdir().unwrap();
    let mut router = Router::new();
    register_voice_upload(&mut router, dir.path().to_path_buf());
    let bytes = audio(500);
    let hash = sha(&bytes);
    let begin = json!({"recording_id": "rec1", "sha256": hash, "size_bytes": 500, "device_id": "attacker"});
    call(&router, Some("dev1"), "voice_upload_begin", begin).await.unwrap();
    assert!(dir.path().join("voice-notes").join("audio").join("dev1").exists());
    assert!(!dir.path().join("voice-notes").join("audio").join("attacker").exists());
}
