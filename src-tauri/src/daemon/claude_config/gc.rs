//! Temp-file GC: the periodic sweep of leftover `.mcp.json`/`.settings.json`
//! files.

/// Startup + periodic sweep of `mcp_temp_dir()`: removes any `.json` file
/// (covers both `<id>.json` mcp configs and `<id>.settings.json` hook
/// settings) whose mtime is older than 7 days. Normal operation deletes both
/// at pump-exit / `end_session`, keyed off `Session::mcp_config_path` /
/// `hook_settings_path`; this only catches leftovers from a daemon crash, a
/// hard kill, or a session spawned by a build that predates that cleanup.
/// Mirrors the chat-attachments sweep in `ipc::chat::lifecycle::gc_attachments`.
pub(crate) fn gc_temp_files() {
    let Ok(dir) = crate::settings::paths::mcp_temp_dir() else { return };
    crate::util::sweep_dir_older_than(
        &dir,
        std::time::Duration::from_secs(7 * 24 * 60 * 60),
        |path| {
            // "tmp" also catches a write_json_atomic tmp sibling stranded by a
            // crash mid-rename (e.g. "<turn_id>.json.tmp"): with_extension
            // appends ".json.tmp" as a literal suffix, so Path::extension()
            // (last dot-segment only) sees "tmp", never "json".
            matches!(path.extension().and_then(|e| e.to_str()), Some("json") | Some("tmp"))
        },
        false,
    );
}
