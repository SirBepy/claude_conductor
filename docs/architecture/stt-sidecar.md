# STT sidecar is not bundled

Read before touching `src-tauri/src/daemon/stt.rs`, `stt-sidecar/` or the installer contents.

- **Decided 2026-08-08 (todo 521): the STT sidecar is NOT bundled into the installer.** `SttSupervisor::sidecar_dir()` (`src-tauri/src/daemon/stt.rs`) only finds `stt-sidecar/server.py` via an env override, a recorded app-data path, or a directory walk-up from the exe/cwd - none of which hit on an installed app with no repo nearby, so dictation only works from a source checkout today. Bundling a prepared `.venv` would add roughly 2-4GB (`faster-whisper` + `ctranslate2` + CUDA wheels) to the installer for one user; not worth it unless dictation needs to be portable to a machine without the repo.
