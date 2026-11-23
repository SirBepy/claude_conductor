//! Cheap, one-shot `claude -p` passes related to voice dictation. The STT
//! sidecar supervisor itself (the faster-whisper process) lives in
//! `daemon::stt`; this module is only the post-transcription LLM rewrite
//! (`cleanup` spawns and gates, `rewrite` holds the pure rules).

pub mod cleanup;
pub mod rewrite;
pub mod vocab_seed;
