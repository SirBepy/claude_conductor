//! One recording through the transcription pipeline, and the single worker that
//! takes them one at a time. The receipt next to the audio is the state:
//! `pending` -> `transcribed` (text saved beside the audio) -> `done` (note in
//! the vault), or `failed` after `MAX_ATTEMPTS` errors. Every step re-reads the
//! receipt, so a duplicate queue entry or a restart repeats nothing.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::vault::{self, Note};
use crate::daemon::voice_upload::store::{receipt_of, update_receipt, write_file_atomic, Received};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
}

pub enum TranscribeError {
    /// The engine could not even start (no sidecar folder, no Python): a problem
    /// with this install, not with the recording, so it never counts as an attempt
    /// and the recording is tried again later.
    Unavailable(String),
    /// The engine ran and failed on this recording.
    Failed(String),
}

impl From<String> for TranscribeError {
    fn from(s: String) -> Self {
        Self::Failed(s)
    }
}

impl From<&str> for TranscribeError {
    fn from(s: &str) -> Self {
        Self::Failed(s.to_string())
    }
}

pub trait Transcriber: Send + Sync {
    /// The text of `audio`. `terms` are extra vocabulary (the vault Glossary).
    fn transcribe<'a>(&'a self, audio: &'a Path, terms: &'a [String]) -> BoxFut<'a, Result<Transcript, TranscribeError>>;
}

/// Errors in a row before a recording is marked `failed` and left alone.
pub const MAX_ATTEMPTS: u64 = 3;

pub struct JobCtx {
    pub transcriber: Arc<dyn Transcriber>,
    /// The vault to write into, looked up per job (Obsidian may open later).
    pub vault: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    /// True while a dictation is live; the job waits it out.
    pub busy: Arc<dyn Fn() -> bool + Send + Sync>,
    pub busy_poll: Duration,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Nothing to do: already finished, failed for good, or no receipt.
    Skipped,
    /// The note is in the vault.
    Exported(PathBuf),
    /// The recording holds no speech; nothing worth a note.
    Empty,
    /// Transcribed, but there is no vault to write to yet.
    NoVault,
    /// An error that may pass; the recording is queued again after a delay.
    Retry,
    /// Failed `MAX_ATTEMPTS` times; the receipt says `failed`.
    Failed,
}

fn text_path(audio: &Path) -> PathBuf {
    audio.with_extension("txt")
}

pub async fn process(ctx: &JobCtx, r: &Received) -> Step {
    let Some(receipt) = receipt_of(&r.audio) else { return Step::Skipped };
    let (text, language) = match receipt["transcription"].as_str() {
        Some("pending") => match transcribe_step(ctx, r, &receipt).await {
            Ok(t) => t,
            Err(step) => return step,
        },
        Some("transcribed") => match std::fs::read_to_string(text_path(&r.audio)) {
            Ok(text) => (text, receipt["language"].as_str().map(str::to_string)),
            Err(e) => {
                // The text file is gone: transcribe again rather than lose the note.
                log::warn!("voice transcribe: saved text of {} unreadable ({e}); transcribing again", r.recording_id);
                let _ = update_receipt(&r.audio, &json!({"transcription": "pending"}));
                return Step::Retry;
            }
        },
        _ => return Step::Skipped,
    };
    export_step(ctx, r, &text, language.as_deref())
}

async fn transcribe_step(ctx: &JobCtx, r: &Received, receipt: &Value) -> Result<(String, Option<String>), Step> {
    while (ctx.busy)() {
        tokio::time::sleep(ctx.busy_poll).await;
    }
    let terms = (ctx.vault)().map(|v| vault::read_glossary(&v)).unwrap_or_default();
    match ctx.transcriber.transcribe(&r.audio, &terms).await {
        Ok(t) => {
            let saved = write_file_atomic(&text_path(&r.audio), t.text.as_bytes()).and_then(|_| {
                update_receipt(
                    &r.audio,
                    &json!({"transcription": "transcribed", "language": t.language, "error": null}),
                )
            });
            match saved {
                Ok(()) => Ok((t.text, t.language)),
                Err(e) => Err(record_failure(r, receipt, &format!("cannot save the transcript: {e}"))),
            }
        }
        Err(TranscribeError::Failed(e)) => Err(record_failure(r, receipt, &e)),
        Err(TranscribeError::Unavailable(e)) => {
            log::warn!("voice transcribe: engine unavailable for {}: {e}", r.recording_id);
            let _ = update_receipt(&r.audio, &json!({"error": e}));
            Err(Step::Retry)
        }
    }
}

fn record_failure(r: &Received, receipt: &Value, why: &str) -> Step {
    let attempts = receipt["attempts"].as_u64().unwrap_or(0) + 1;
    log::warn!("voice transcribe: {} failed (attempt {attempts}): {why}", r.recording_id);
    if attempts >= MAX_ATTEMPTS {
        let _ = update_receipt(&r.audio, &json!({"transcription": "failed", "attempts": attempts, "error": why}));
        Step::Failed
    } else {
        let _ = update_receipt(&r.audio, &json!({"attempts": attempts, "error": why}));
        Step::Retry
    }
}

fn export_step(ctx: &JobCtx, r: &Received, text: &str, language: Option<&str>) -> Step {
    if text.trim().is_empty() {
        let _ = update_receipt(&r.audio, &json!({"transcription": "done", "vault_note": null, "empty": true}));
        return Step::Empty;
    }
    let Some(vault) = (ctx.vault)() else {
        log::warn!("voice transcribe: no vault to write {} to; it waits", r.recording_id);
        return Step::NoVault;
    };
    let note = Note {
        source: "phone voice note",
        created: vault::local_time(r.recorded_at_ms),
        language,
        audio: &r.audio,
        device_id: &r.device_id,
        recording_id: &r.recording_id,
        text,
    };
    match vault::export(&vault, &note) {
        Ok(path) => {
            // A failure here (or a kill before it) leaves `transcribed`, and the next
            // run writes the note a second time under "(2)": never an overwrite, but
            // a duplicate. Nothing else runs between the write and this update.
            if let Err(e) = update_receipt(
                &r.audio,
                &json!({"transcription": "done", "vault_note": path.to_string_lossy()}),
            ) {
                log::warn!("voice transcribe: note written but the receipt update failed: {e}");
            }
            Step::Exported(path)
        }
        Err(e) => {
            log::warn!("voice transcribe: vault write failed for {}: {e}", r.recording_id);
            Step::Retry
        }
    }
}

/// One job at a time, in arrival order. A recording that needs another try is
/// put back on the queue after `retry_delay`.
pub fn spawn_worker(
    ctx: Arc<JobCtx>,
    mut rx: UnboundedReceiver<Received>,
    tx: UnboundedSender<Received>,
    retry_delay: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(r) = rx.recv().await {
            // Run in its own task so a panic in one recording ends that job, not
            // the worker every later recording depends on.
            let (job_ctx, job) = (ctx.clone(), r.clone());
            let step = match tokio::spawn(async move { process(&job_ctx, &job).await }).await {
                Ok(step) => step,
                Err(e) => {
                    log::error!("voice transcribe: the job for {} panicked: {e}", r.recording_id);
                    // A panic is a fault of this recording, so it counts an attempt:
                    // one that always panics ends as `failed`, not a loop.
                    match receipt_of(&r.audio) {
                        Some(receipt) if matches!(receipt["transcription"].as_str(), Some("pending" | "transcribed")) => {
                            record_failure(&r, &receipt, "the job panicked")
                        }
                        _ => Step::Skipped,
                    }
                }
            };
            match step {
                Step::Retry | Step::NoVault => {
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(retry_delay).await;
                        let _ = tx.send(r);
                    });
                }
                Step::Exported(p) => log::info!("voice transcribe: {} -> {}", r.recording_id, p.display()),
                _ => {}
            }
        }
    })
}
