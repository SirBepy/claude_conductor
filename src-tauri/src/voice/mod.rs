//! Cheap, one-shot `claude -p` passes related to voice dictation. The STT
//! sidecar supervisor itself (the faster-whisper process) lives in
//! `daemon::stt`; this module is only the post-transcription LLM cleanup.

pub mod cleanup;
