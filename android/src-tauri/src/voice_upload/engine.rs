//! The upload logic, with no Android and no network in it: what to send, where
//! to resume, what to record in the index after each step. The index (Kotlin's
//! `RecordingStore`) is reached through `Source` and the PC through `Rpc`, so the
//! resume and no-duplicate rules are tested with fakes of both.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One recording that still has to reach the PC.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Job {
    pub id: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    /// `None` when the recorder could not hash the file; hashed here then.
    pub sha256: Option<String>,
    pub recorded_at_ms: u64,
    pub duration_ms: u64,
}

/// What the uploader records in the index about one recording.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Mark {
    Uploading { bytes: u64 },
    /// Back to waiting: the PC could not be reached, nothing is lost.
    Queued,
    Uploaded,
    Failed(String),
}

/// The login of the PC's tunnel origin: the bearer token the SPA holds for the
/// loopback port its tunnel runs on. A token is only ever sent to that port's PC.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Auth {
    pub port: u16,
    pub token: String,
}

/// The phone's index and credentials (Kotlin's `VoiceUploadPlugin`).
pub(crate) trait Source: Send + Sync {
    /// Recordings that need sending, oldest first; queues any that are only saved.
    fn claim(&self) -> BoxFut<'_, Result<Vec<Job>, String>>;
    fn mark(&self, id: &str, mark: Mark) -> BoxFut<'_, Result<(), String>>;
    fn auth(&self) -> BoxFut<'_, Result<Option<Auth>, String>>;
}

/// Why an RPC call did not return a result.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RpcFailure {
    /// No tunnel, no connection, or the stream died: try again later.
    Offline(String),
    /// No login for this PC, or the PC refused it.
    Unauthorized,
    /// The PC understood and refused this recording for good (bad parameters).
    Rejected(String),
    /// The PC failed on its side or does not know the method yet: try again later.
    Server(String),
}

pub(crate) trait Rpc: Send + Sync {
    fn call(&self, method: &str, params: Value) -> BoxFut<'_, Result<Value, RpcFailure>>;
}

/// How a pass ended; the runner turns it into a wait.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum PassEnd {
    /// Nothing needed sending.
    Idle,
    /// Everything claimed was handled (sent, or failed for good).
    Worked,
    /// The PC could not be reached; the rows are queued again.
    Offline,
    Unauthorized,
}

const CHUNK_MAX: usize = 256 * 1024;
const CHUNK_MIN: usize = 16 * 1024;
/// A call slower than this halves the next chunk: on a relay measured at about
/// 20 KB/s, a 256 KiB call takes 13 s, and nothing in flight may sit silent for
/// the connection's 30 s idle timeout.
const SLOW_CALL: Duration = Duration::from_secs(10);
const FAST_CALL: Duration = Duration::from_secs(2);
/// Restarts of one recording after the PC reports its hash does not match.
const MAX_HASH_RESTARTS: u32 = 2;

/// Chunk size that follows the link: halves after a slow call, doubles back
/// after a fast one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Pacer(pub usize);

impl Default for Pacer {
    fn default() -> Self {
        Pacer(CHUNK_MAX)
    }
}

impl Pacer {
    pub fn after(self, took: Duration) -> Pacer {
        if took > SLOW_CALL {
            Pacer((self.0 / 2).max(CHUNK_MIN))
        } else if took < FAST_CALL {
            Pacer((self.0 * 2).min(CHUNK_MAX))
        } else {
            self
        }
    }
}

enum Stop {
    Offline,
    Unauthorized,
    /// This recording failed for good; the next one is still tried.
    Failed,
}

pub(crate) struct Uploader<S: Source + ?Sized, R: Rpc + ?Sized> {
    source: Arc<S>,
    rpc: Arc<R>,
    pacer: Mutex<Pacer>,
}

impl<S: Source + ?Sized, R: Rpc + ?Sized> Uploader<S, R> {
    pub fn new(source: Arc<S>, rpc: Arc<R>) -> Self {
        Self { source, rpc, pacer: Mutex::new(Pacer::default()) }
    }

    pub async fn run_pass(&self) -> PassEnd {
        let jobs = match self.source.claim().await {
            Ok(jobs) => jobs,
            Err(e) => {
                log::warn!("voice upload: cannot read the index: {e}");
                return PassEnd::Idle;
            }
        };
        if jobs.is_empty() {
            return PassEnd::Idle;
        }
        for job in jobs {
            match self.upload(&job).await {
                Ok(()) | Err(Stop::Failed) => {}
                Err(Stop::Offline) => return PassEnd::Offline,
                Err(Stop::Unauthorized) => return PassEnd::Unauthorized,
            }
        }
        PassEnd::Worked
    }

    async fn mark(&self, id: &str, mark: Mark) {
        if let Err(e) = self.source.mark(id, mark).await {
            // The upload itself is safe to repeat (the PC dedupes), so a lost
            // index write costs a repeat of begin, never a duplicate file.
            log::warn!("voice upload: cannot update the index for {id}: {e}");
        }
    }

    async fn fail(&self, job: &Job, why: String) -> Stop {
        log::warn!("voice upload: {} failed: {why}", job.id);
        self.mark(&job.id, Mark::Failed(why)).await;
        Stop::Failed
    }

    /// A call the PC could not answer: the row waits, the pass stops.
    async fn stop_for(&self, job: &Job, failure: RpcFailure) -> Stop {
        match failure {
            RpcFailure::Rejected(why) => self.fail(job, why).await,
            RpcFailure::Unauthorized => {
                self.mark(&job.id, Mark::Queued).await;
                Stop::Unauthorized
            }
            RpcFailure::Offline(_) | RpcFailure::Server(_) => {
                self.mark(&job.id, Mark::Queued).await;
                Stop::Offline
            }
        }
    }

    async fn upload(&self, job: &Job) -> Result<(), Stop> {
        let meta = std::fs::metadata(&job.path).map_err(|e| e.to_string());
        match meta {
            Err(e) => return Err(self.fail(job, format!("audio file unreadable: {e}")).await),
            Ok(m) if m.len() != job.size_bytes => {
                return Err(self.fail(job, "audio file changed since it was recorded".into()).await)
            }
            Ok(_) => {}
        }
        let sha = match &job.sha256 {
            Some(s) => s.clone(),
            None => match hash_file(job.path.clone()).await {
                Ok(s) => s,
                Err(e) => return Err(self.fail(job, format!("cannot hash the audio: {e}")).await),
            },
        };
        let mut restarts = 0;
        'restart: loop {
            let begin = json!({
                "recording_id": job.id, "sha256": sha, "size_bytes": job.size_bytes,
                "recorded_at_ms": job.recorded_at_ms, "duration_ms": job.duration_ms,
            });
            let reply = match self.rpc.call("voice_upload_begin", begin).await {
                Ok(v) => v,
                Err(f) => return Err(self.stop_for(job, f).await),
            };
            let mut offset = match status_of(&reply) {
                Status::Complete => {
                    self.mark(&job.id, Mark::Uploaded).await;
                    return Ok(());
                }
                Status::Partial(o) | Status::Mismatch(o) => o,
                _ => return Err(self.fail(job, format!("unexpected answer to begin: {reply}")).await),
            };
            loop {
                if offset > job.size_bytes {
                    return Err(self.fail(job, "the PC reports more bytes than the file has".into()).await);
                }
                if offset == job.size_bytes {
                    // The PC holds every byte but did not say complete (it was
                    // mid-verification): asking again settles it either way.
                    restarts += 1;
                    if restarts > MAX_HASH_RESTARTS {
                        return Err(self.fail(job, "the PC never confirmed the upload".into()).await);
                    }
                    continue 'restart;
                }
                self.mark(&job.id, Mark::Uploading { bytes: offset }).await;
                let want = (job.size_bytes - offset).min(self.chunk_size() as u64) as usize;
                let data = match read_at(job.path.clone(), offset, want).await {
                    Ok(d) => d,
                    Err(e) => return Err(self.fail(job, format!("cannot read the audio: {e}")).await),
                };
                let params = json!({
                    "recording_id": job.id, "sha256": sha, "offset": offset,
                    "data_b64": base64::engine::general_purpose::STANDARD.encode(&data),
                });
                let started = Instant::now();
                let reply = match self.rpc.call("voice_upload_chunk", params).await {
                    Ok(v) => v,
                    Err(f) => return Err(self.stop_for(job, f).await),
                };
                self.pace(started.elapsed());
                match status_of(&reply) {
                    Status::Complete => {
                        self.mark(&job.id, Mark::Uploaded).await;
                        return Ok(());
                    }
                    // `Mismatch` is the PC saying where its copy really ends: a
                    // repeated chunk after a lost answer, or a PC that restarted.
                    Status::Partial(next) | Status::Mismatch(next) => offset = next,
                    // Counted like a hash mismatch: a PC that keeps losing the begun
                    // upload must end this recording, never spin on it.
                    Status::NoUpload => {
                        restarts += 1;
                        if restarts > MAX_HASH_RESTARTS {
                            return Err(self.fail(job, "the PC keeps losing the upload".into()).await);
                        }
                        continue 'restart;
                    }
                    Status::HashMismatch => {
                        restarts += 1;
                        if restarts > MAX_HASH_RESTARTS {
                            return Err(self.fail(job, "the PC could not verify the audio".into()).await);
                        }
                        continue 'restart;
                    }
                    Status::Unknown => {
                        return Err(self.fail(job, format!("unexpected answer to a chunk: {reply}")).await)
                    }
                }
            }
        }
    }

    fn chunk_size(&self) -> usize {
        self.pacer.lock().unwrap_or_else(|e| e.into_inner()).0
    }

    fn pace(&self, took: Duration) {
        let mut p = self.pacer.lock().unwrap_or_else(|e| e.into_inner());
        *p = p.after(took);
    }
}

enum Status {
    Complete,
    Partial(u64),
    Mismatch(u64),
    NoUpload,
    HashMismatch,
    Unknown,
}

fn status_of(reply: &Value) -> Status {
    let offset = reply["offset"].as_u64();
    match (reply["status"].as_str(), offset) {
        (Some("complete"), _) => Status::Complete,
        (Some("partial"), Some(o)) => Status::Partial(o),
        (Some("offset_mismatch"), Some(o)) => Status::Mismatch(o),
        (Some("no_upload"), _) => Status::NoUpload,
        (Some("hash_mismatch"), _) => Status::HashMismatch,
        _ => Status::Unknown,
    }
}

async fn hash_file(path: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn read_at(path: PathBuf, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
