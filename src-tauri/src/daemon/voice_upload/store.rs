//! Disk side of the phone's voice-note upload: the partial file, the finished
//! audio and the sidecar that records what arrived. Synchronous on purpose; the
//! RPC layer runs every call on the blocking pool.
//!
//! Layout under `<root>/<device_id>/`, one stem per (recording id, sha256):
//! `<recording>-<sha[..16]>.begin.json` (what the phone declared),
//! `.part` (bytes received so far), `.opus` (verified audio) and `.json` (the
//! receipt: who sent it, the full hash, and the transcription state R5 reads).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Largest chunk one call may carry (decoded). The phone sends 1 MiB; the cap
/// only bounds what a misbehaving client can make the daemon hold at once.
pub const MAX_CHUNK_BYTES: usize = 2 * 1024 * 1024;

/// Largest recording accepted. The recorder writes about 11 MB an hour, so this
/// is a cap against a runaway declaration, not a real limit.
pub const MAX_RECORDING_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// What one call left behind; the RPC layer turns it into the phone's reply.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The PC holds the whole, verified file. Final; sending more changes nothing.
    Complete,
    /// `offset` bytes are held; send the next chunk from there.
    Partial { offset: u64 },
    /// The chunk did not start where the PC's copy ends; resend from `offset`.
    OffsetMismatch { offset: u64 },
    /// Every byte arrived but the hash differs; the partial was dropped, start over.
    HashMismatch,
    /// A chunk for an upload that was never begun (or was reset); begin again.
    NoUpload,
}

/// An upload's identity. The device comes from the authenticated connection,
/// never from request params.
#[derive(Debug, Clone, PartialEq)]
pub struct UploadKey {
    device: String,
    recording: String,
    sha256: String,
}

impl UploadKey {
    pub fn parse(device: &str, recording: &str, sha256: &str) -> Result<Self, String> {
        if !is_ident(device) {
            return Err("device id is not a plain identifier".into());
        }
        if !is_ident(recording) {
            return Err("recording_id must be 1-64 letters, digits, '-' or '_'".into());
        }
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err("sha256 must be 64 lowercase hex characters".into());
        }
        Ok(Self { device: device.into(), recording: recording.into(), sha256: sha256.into() })
    }

    fn stem(&self) -> String {
        format!("{}-{}", self.recording, &self.sha256[..16])
    }
}

/// Names become path components, so only a plain identifier passes: no dots,
/// separators or drive letters can reach the filesystem.
fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What the phone says about the recording when it begins an upload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Declared {
    pub size_bytes: u64,
    #[serde(default)]
    pub recorded_at_ms: u64,
    #[serde(default)]
    pub duration_ms: u64,
}

/// A verified recording, handed to the transcription hook.
#[derive(Debug, Clone, PartialEq)]
pub struct Received {
    pub device_id: String,
    pub recording_id: String,
    pub sha256: String,
    pub audio: PathBuf,
    pub recorded_at_ms: u64,
    pub duration_ms: u64,
}

type Hook = Box<dyn Fn(&Received) + Send + Sync>;

static TRANSCRIPTION_HOOK: OnceLock<Hook> = OnceLock::new();

/// R5 installs its queue here. Called once per verified recording, after the
/// receipt is on disk, while the upload lock is held and the phone's call waits,
/// so a hook must only enqueue (spawn or send) and return at once; a recording that arrived before the hook existed is
/// found again by `pending_transcriptions`.
pub fn set_transcription_hook(hook: impl Fn(&Received) + Send + Sync + 'static) -> bool {
    TRANSCRIPTION_HOOK.set(Box::new(hook)).is_ok()
}

pub struct UploadStore {
    root: PathBuf,
    // One lock for every upload: a chunk is a few milliseconds of disk, there is
    // one phone, and it makes "two calls at the same offset" impossible.
    lock: Mutex<()>,
    hook: Mutex<Option<Arc<dyn Fn(&Received) + Send + Sync>>>,
}

impl UploadStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root, lock: Mutex::new(()), hook: Mutex::new(None) }
    }

    /// A store-local hook (tests); production uses `set_transcription_hook`.
    #[cfg(test)]
    pub fn with_hook(self, hook: impl Fn(&Received) + Send + Sync + 'static) -> Self {
        *self.hook.lock().unwrap() = Some(Arc::new(hook));
        self
    }

    fn paths(&self, key: &UploadKey) -> Paths {
        let dir = self.root.join(&key.device);
        let stem = key.stem();
        Paths {
            begin: dir.join(format!("{stem}.begin.json")),
            part: dir.join(format!("{stem}.part")),
            audio: dir.join(format!("{stem}.opus")),
            receipt: dir.join(format!("{stem}.json")),
            dir,
        }
    }

    /// Starts an upload, or answers where it stands. Safe to repeat: a finished
    /// one is `Complete`, a partial one reports its length, a declaration whose
    /// size changed starts over.
    pub fn begin(&self, key: &UploadKey, declared: &Declared) -> Result<Outcome, String> {
        if declared.size_bytes == 0 || declared.size_bytes > MAX_RECORDING_BYTES {
            return Err(format!("size_bytes must be 1..={MAX_RECORDING_BYTES}"));
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let p = self.paths(key);
        if self.is_complete(key, &p) {
            return Ok(Outcome::Complete);
        }
        fs::create_dir_all(&p.dir).map_err(|e| format!("cannot create the audio folder: {e}"))?;
        let previous = read_json::<Declared>(&p.begin);
        if previous.as_ref().map(|d| d.size_bytes) != Some(declared.size_bytes) {
            // A new declaration (or a lost one): a partial of another size can
            // not belong to it.
            let _ = fs::remove_file(&p.part);
        }
        if previous.as_ref() != Some(declared) {
            write_atomic(&p.begin, &serde_json::to_vec(declared).map_err(|e| e.to_string())?)?;
        }
        let held = fs::metadata(&p.part).map(|m| m.len()).unwrap_or(0);
        if held > declared.size_bytes {
            fs::remove_file(&p.part).map_err(|e| e.to_string())?;
            return Ok(Outcome::Partial { offset: 0 });
        }
        if held == declared.size_bytes {
            // A kill between the last append and the verification.
            return self.finish(key, &p, declared);
        }
        Ok(Outcome::Partial { offset: held })
    }

    /// Appends `data` when it starts exactly where the PC's copy ends. A chunk
    /// that arrives twice (a retry after a lost answer) finds the copy already
    /// longer and gets `OffsetMismatch`, so no byte is ever written twice.
    pub fn chunk(&self, key: &UploadKey, offset: u64, data: &[u8]) -> Result<Outcome, String> {
        if data.is_empty() || data.len() > MAX_CHUNK_BYTES {
            return Err(format!("a chunk is 1..={MAX_CHUNK_BYTES} bytes"));
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let p = self.paths(key);
        if self.is_complete(key, &p) {
            return Ok(Outcome::Complete);
        }
        let Some(declared) = read_json::<Declared>(&p.begin) else {
            return Ok(Outcome::NoUpload);
        };
        let held = fs::metadata(&p.part).map(|m| m.len()).unwrap_or(0);
        if held != offset {
            return Ok(Outcome::OffsetMismatch { offset: held });
        }
        if held + data.len() as u64 > declared.size_bytes {
            return Err("chunk runs past the declared size".into());
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&p.part).map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.sync_data().map_err(|e| e.to_string())?;
        if held + data.len() as u64 == declared.size_bytes {
            return self.finish(key, &p, &declared);
        }
        Ok(Outcome::Partial { offset: held + data.len() as u64 })
    }

    /// Verifies the whole file; only a matching hash makes it audio.
    fn finish(&self, key: &UploadKey, p: &Paths, declared: &Declared) -> Result<Outcome, String> {
        let actual = sha256_of(&p.part).map_err(|e| format!("cannot hash the upload: {e}"))?;
        if actual != key.sha256 {
            let _ = fs::remove_file(&p.part);
            return Ok(Outcome::HashMismatch);
        }
        fs::rename(&p.part, &p.audio).map_err(|e| format!("cannot finish the upload: {e}"))?;
        let receipt = json!({
            "device_id": key.device,
            "recording_id": key.recording,
            "sha256": key.sha256,
            "size_bytes": declared.size_bytes,
            "recorded_at_ms": declared.recorded_at_ms,
            "duration_ms": declared.duration_ms,
            "received_at_ms": now_ms(),
            "audio": p.audio.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            "transcription": "pending",
        });
        write_atomic(&p.receipt, receipt.to_string().as_bytes())?;
        let _ = fs::remove_file(&p.begin);
        let received = Received {
            device_id: key.device.clone(),
            recording_id: key.recording.clone(),
            sha256: key.sha256.clone(),
            audio: p.audio.clone(),
            recorded_at_ms: declared.recorded_at_ms,
            duration_ms: declared.duration_ms,
        };
        let local = self.hook.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(hook) = local {
            hook(&received);
        } else if let Some(hook) = TRANSCRIPTION_HOOK.get() {
            hook(&received);
        }
        Ok(Outcome::Complete)
    }

    /// The receipt and the audio both exist and agree with the key. A receipt
    /// whose audio is gone is not complete: the phone sends it again.
    fn is_complete(&self, key: &UploadKey, p: &Paths) -> bool {
        let Some(receipt) = read_json::<Value>(&p.receipt) else { return false };
        receipt["sha256"].as_str() == Some(key.sha256.as_str())
            && fs::metadata(&p.audio).map(|m| m.len()).ok() == receipt["size_bytes"].as_u64()
    }

    /// Verified recordings whose transcription has not been taken yet, oldest
    /// first. The pending-only view; start-up uses `unfinished_transcriptions`.
    pub fn pending_transcriptions(&self) -> Vec<Received> {
        self.receipts_in(&["pending"])
    }

    /// Recordings the transcription job still owes work on: not transcribed yet
    /// (`pending`), or transcribed but not yet written to the vault (`transcribed`).
    pub fn unfinished_transcriptions(&self) -> Vec<Received> {
        self.receipts_in(&["pending", "transcribed"])
    }

    /// The receipt's transcription state for one upload (`pending`, `transcribed`,
    /// `done`, `failed`), or `None` when the PC holds no verified copy of it.
    pub fn transcription_state(&self, key: &UploadKey) -> Option<String> {
        let p = self.paths(key);
        if !self.is_complete(key, &p) {
            return None;
        }
        read_json::<Value>(&p.receipt)?["transcription"].as_str().map(str::to_string)
    }

    fn receipts_in(&self, states: &[&str]) -> Vec<Received> {
        let mut out = Vec::new();
        let Ok(devices) = fs::read_dir(&self.root) else { return out };
        for device in devices.flatten() {
            let Ok(files) = fs::read_dir(device.path()) else { continue };
            for file in files.flatten() {
                let path = file.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.ends_with(".json") || name.ends_with(".begin.json") {
                    continue;
                }
                let Some(r) = read_json::<Value>(&path) else { continue };
                if !states.iter().any(|s| r["transcription"].as_str() == Some(*s)) {
                    continue;
                }
                let audio = path.with_extension("opus");
                if !audio.is_file() {
                    continue;
                }
                out.push(Received {
                    device_id: r["device_id"].as_str().unwrap_or("").into(),
                    recording_id: r["recording_id"].as_str().unwrap_or("").into(),
                    sha256: r["sha256"].as_str().unwrap_or("").into(),
                    audio,
                    recorded_at_ms: r["recorded_at_ms"].as_u64().unwrap_or(0),
                    duration_ms: r["duration_ms"].as_u64().unwrap_or(0),
                });
            }
        }
        out.sort_by_key(|r| r.recorded_at_ms);
        out
    }
}

struct Paths {
    dir: PathBuf,
    begin: PathBuf,
    part: PathBuf,
    audio: PathBuf,
    receipt: PathBuf,
}

/// The receipt next to a published recording (`<stem>.opus` -> `<stem>.json`).
pub fn receipt_of(audio: &Path) -> Option<Value> {
    read_json::<Value>(&audio.with_extension("json"))
}

/// Sets the fields of `patch` (a JSON object) in the receipt next to `audio`,
/// leaving every other field alone. The transcription job is the only writer
/// after the upload published the receipt.
pub fn update_receipt(audio: &Path, patch: &Value) -> Result<(), String> {
    let path = audio.with_extension("json");
    let mut receipt = read_json::<Value>(&path).ok_or("the receipt is missing or unreadable")?;
    let (Some(fields), Some(changes)) = (receipt.as_object_mut(), patch.as_object()) else {
        return Err("a receipt and its patch are JSON objects".into());
    };
    for (k, v) in changes {
        fields.insert(k.clone(), v.clone());
    }
    write_atomic(&path, receipt.to_string().as_bytes())
}

pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic(path, bytes)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Temp file, fsync, rename: a kill mid-write leaves the old file whole.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
