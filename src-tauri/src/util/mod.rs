pub mod claude_bin;
pub mod process;

/// Shared lock for any test in this crate that mutates a process-global env
/// var (`CC_DATA_DIR`, `CC_DAEMON_INSTANCE`, ...). The default `--lib` run
/// uses 4 threads (`src-tauri/.cargo/config.toml`'s `RUST_TEST_THREADS`), so
/// two such tests in DIFFERENT modules, each with its own local mutex, can
/// still stomp each other's value mid-test - this one lock is what actually
/// serializes them, since a per-module mutex only guards within that module.
#[cfg(test)]
pub(crate) static ENV_MUTATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Tolerates the shapes a path can arrive in (trailing separators,
/// `.`-segments, Windows case). An uncanonicalizable path falls back to a
/// literal compare, which can only reject, never wrongly accept - `spawn_chat`
/// leans on that direction to guard which cwd a chat may be spawned in.
pub(crate) fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

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

/// File name for a per-project store (`user_todos`, `message_drafts`,
/// `repo_channel`). A real project id (uuid) maps unchanged to `"{id}.json"`,
/// so existing store files keep their names. An `ephemeral:<cwd>` id can
/// carry `:`, `\` or `/`, which NTFS rejects (os error 123, and the stores
/// only log write failures), so it hashes to a safe name instead.
pub(crate) fn project_store_file_name(project_id: &str) -> String {
    let is_plain_id = !project_id.is_empty()
        && project_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if is_plain_id {
        format!("{project_id}.json")
    } else {
        // Truncated hash, not the raw id: deterministic (same id, same file,
        // so reads and writes agree) and collision-resistant across the
        // small number of distinct ephemeral cwds a machine actually has.
        format!("ephemeral-{}.json", &sha256_hex(project_id)[..16])
    }
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

#[cfg(test)]
mod project_store_file_name_tests {
    use super::project_store_file_name;

    #[test]
    fn a_real_uuid_project_id_maps_to_the_unchanged_file_name() {
        let id = "3fa5c9e0-1b2d-4a6e-9c3f-8e2d1a7b6c5d";
        assert_eq!(project_store_file_name(id), format!("{id}.json"));
    }

    #[test]
    fn an_ephemeral_id_produces_no_windows_illegal_characters() {
        let name = project_store_file_name(r"ephemeral:c:\tmp\x");
        assert!(!name.contains(':'), "got {name}");
        assert!(!name.contains('\\'), "got {name}");
        assert!(!name.contains('/'), "got {name}");
    }

    #[test]
    fn the_same_ephemeral_id_always_maps_to_the_same_name() {
        let id = r"ephemeral:c:\tmp\probe";
        assert_eq!(project_store_file_name(id), project_store_file_name(id));
    }

    #[test]
    fn two_different_ephemeral_ids_map_to_different_names() {
        let a = project_store_file_name(r"ephemeral:c:\tmp\a");
        let b = project_store_file_name(r"ephemeral:c:\tmp\b");
        assert_ne!(a, b);
    }
}
