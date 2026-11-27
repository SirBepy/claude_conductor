//! Runs `stt-sidecar/batch.py` for one recording. A child process per recording,
//! not a call into the dictation sidecar: it has its own (below-normal) priority,
//! gives the GPU memory back when it exits, and cannot slow a live dictation.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::job::{BoxFut, TranscribeError, Transcriber, Transcript};
use crate::daemon::stt::SttSupervisor;

/// A recording that takes longer than this is a stuck process, not a long note.
const RUN_LIMIT: Duration = Duration::from_secs(12 * 60 * 60);

pub struct SidecarBatch {
    app_data: PathBuf,
}

impl SidecarBatch {
    pub fn new(app_data: PathBuf) -> Self {
        Self { app_data }
    }

    fn work_dir(&self) -> PathBuf {
        self.app_data.join("voice-notes").join("work")
    }
}

/// The arguments of `batch.py`. `CC_VOICE_NOTE_LANG` ("auto" lets Whisper pick),
/// `CC_VOICE_NOTE_DEVICE` (auto, cuda, cpu) and `CC_VOICE_NOTE_PAUSE_RATIO`
/// (idle time per second of work; 1.0 halves the duty cycle) tune a run.
pub(super) fn batch_args(
    script: &Path,
    app_data: &Path,
    audio: &Path,
    out: &Path,
    terms_file: &Path,
    env: impl Fn(&str) -> Option<String>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        script.into(),
        "--app-data".into(),
        app_data.into(),
        "--audio".into(),
        audio.into(),
        "--out".into(),
        out.into(),
        "--terms-file".into(),
        terms_file.into(),
    ];
    let mut opt = |flag: &str, var: &str, allowed: Option<&[&str]>| {
        if let Some(v) = env(var).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            let ok = match allowed {
                Some(list) => list.contains(&v.as_str()),
                // A number, so a stray value can never become another flag.
                None => v.parse::<f64>().map(|n| n.is_finite() && n >= 0.0).unwrap_or(false),
            };
            if ok {
                args.push(flag.into());
                args.push(v.into());
            }
        }
    };
    opt("--device", "CC_VOICE_NOTE_DEVICE", Some(&["auto", "cuda", "cpu"]));
    opt("--pause-ratio", "CC_VOICE_NOTE_PAUSE_RATIO", None);
    if let Some(lang) = env("CC_VOICE_NOTE_LANG").map(|v| v.trim().to_string()) {
        if !lang.is_empty() && lang.len() <= 8 && lang.chars().all(|c| c.is_ascii_alphabetic()) {
            args.push("--language".into());
            args.push(lang.into());
        }
    }
    args
}

impl Transcriber for SidecarBatch {
    fn transcribe<'a>(&'a self, audio: &'a Path, terms: &'a [String]) -> BoxFut<'a, Result<Transcript, TranscribeError>> {
        Box::pin(async move {
            let dir = SttSupervisor::sidecar_dir_in(&self.app_data);
            let script = dir.join("batch.py");
            if !script.exists() {
                return Err(TranscribeError::Unavailable(format!(
                    "stt-sidecar/batch.py not found at {dir:?} (set CC_STT_SIDECAR_DIR or <app-data>/voice/sidecar-path.txt)"
                )));
            }
            let work = self.work_dir();
            std::fs::create_dir_all(&work).map_err(|e| format!("cannot create {}: {e}", work.display()))?;
            let stem = audio.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
            let out = work.join(format!("{stem}.out.json"));
            let terms_file = work.join(format!("{stem}.terms.json"));
            let _ = std::fs::remove_file(&out);
            std::fs::write(&terms_file, serde_json::to_vec(terms).map_err(|e| e.to_string())?)
                .map_err(|e| format!("cannot write the terms file: {e}"))?;

            let args = batch_args(&script, &self.app_data, audio, &out, &terms_file, |k| std::env::var(k).ok());
            let mut cmd = Command::new(SttSupervisor::python_in(&dir));
            cmd.current_dir(&dir)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            crate::util::process::hide_console_tokio(&mut cmd);
            cmd.kill_on_drop(true);
            let child = cmd
                .spawn()
                .map_err(|e| TranscribeError::Unavailable(format!("spawn batch.py in {dir:?}: {e}")))?;
            crate::util::process::guard_orphan_tree(&child);
            let result = tokio::time::timeout(RUN_LIMIT, child.wait_with_output()).await;
            let _ = std::fs::remove_file(&terms_file);
            let output = match result {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => return Err(format!("batch.py failed to run: {e}").into()),
                // The child is dropped here, and kill_on_drop ends it.
                Err(_) => return Err("batch.py ran past the time limit".into()),
            };
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no error output");
                return Err(format!("batch.py exited with {}: {last}", output.status).into());
            }
            let raw = std::fs::read(&out).map_err(|e| format!("batch.py wrote no result: {e}"))?;
            let _ = std::fs::remove_file(&out);
            parse_result(&raw).map_err(Into::into)
        })
    }
}

pub(super) fn parse_result(raw: &[u8]) -> Result<Transcript, String> {
    let v: serde_json::Value = serde_json::from_slice(raw).map_err(|e| format!("batch.py result is not JSON: {e}"))?;
    let text = v["text"].as_str().ok_or("batch.py result has no text")?.to_string();
    Ok(Transcript { text, language: v["language"].as_str().map(str::to_string) })
}
