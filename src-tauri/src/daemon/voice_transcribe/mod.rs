//! Transcription of the voice notes the phone uploaded (todo pc-1852, round R5).
//!
//! Every verified recording (`voice_upload::store`'s hook, plus a scan at start-up
//! for ones that arrived while the daemon was down or failed to export) is
//! queued. One worker takes them one at a time: `sidecar` runs
//! `stt-sidecar/batch.py` (decode, VAD chunking, Whisper with the dictation
//! hotwords, corrections and the vault Glossary, stitched), `job` keeps the state
//! in the receipt next to the audio, and `vault` writes the Markdown note into
//! `Inbox/Voice`. The transcript goes to the vault only: no chat is started.
//!
//! Gentle by construction (a long run happens while Joe works): the child runs at
//! below-normal priority with a pause after every chunk, only one runs at a time,
//! and the job waits while a dictation is live (`stt::dictation_active`).

mod job;
mod sidecar;
#[cfg(test)]
mod tests;
pub mod vault;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use job::{spawn_worker, JobCtx};

use crate::daemon::voice_upload::store::{set_transcription_hook, UploadStore};

const RETRY_DELAY: Duration = Duration::from_secs(5 * 60);
const BUSY_POLL: Duration = Duration::from_secs(5);

/// Starts the worker, hooks it to the upload store and queues what an earlier run
/// left unfinished. Called once from daemon boot, inside the runtime.
pub fn install(app_data: PathBuf) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let ctx = Arc::new(JobCtx {
        transcriber: Arc::new(sidecar::SidecarBatch::new(app_data.clone())),
        vault: Arc::new(vault::vault_dir),
        busy: Arc::new(crate::daemon::stt::dictation_active),
        busy_poll: BUSY_POLL,
    });
    spawn_worker(ctx, rx, tx.clone(), RETRY_DELAY);
    let hook_tx = tx.clone();
    // The hook runs inside an upload call, so it only queues.
    if !set_transcription_hook(move |r| {
        let _ = hook_tx.send(r.clone());
    }) {
        log::warn!("voice transcribe: a transcription hook was already installed");
    }
    let store = UploadStore::new(app_data.join("voice-notes").join("audio"));
    tokio::task::spawn_blocking(move || {
        for r in store.unfinished_transcriptions() {
            let _ = tx.send(r);
        }
    });
}
