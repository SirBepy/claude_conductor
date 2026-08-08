pub mod process;

use sha2::{Digest, Sha256};

/// Lowercase hex encoding, byte order preserved. Shared by device
/// tokens/ids, remote-access hashes, and the iroh endpoint key file, which
/// requires exactly 64 lowercase hex chars for `SecretKey::from_str`.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of `s`, lowercase hex.
pub(crate) fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    to_hex(&h.finalize())
}

/// Write `json` to `path` atomically via a `.json.tmp` sibling and rename.
/// Creates the parent directory if absent (non-fatal). Returns an error if
/// the write or rename fails.
pub(crate) fn write_json_atomic(path: &std::path::Path, json: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

/// Removes entries directly inside `dir` whose `filter` passes and whose
/// mtime is older than `max_age`. `remove_dir` selects `remove_dir_all`
/// (true, for entries that are directories) vs `remove_file` (false).
/// Missing `dir` / unreadable entries are silently skipped - this is a
/// best-effort GC sweep, never expected to error the caller. Shared by
/// `daemon::claude_config::gc_temp_files` (stale MCP/hook temp files) and
/// `ipc::chat::lifecycle::gc_attachments` (stale chat-attachment dirs), which
/// previously hand-rolled the same read_dir/cutoff/remove loop (ai_todo 190).
pub(crate) fn sweep_dir_older_than(
    dir: &std::path::Path,
    max_age: std::time::Duration,
    filter: impl Fn(&std::path::Path) -> bool,
    remove_dir: bool,
) {
    let cutoff = std::time::SystemTime::now() - max_age;
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !filter(&path) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    if remove_dir {
                        let _ = std::fs::remove_dir_all(&path);
                    } else {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}
