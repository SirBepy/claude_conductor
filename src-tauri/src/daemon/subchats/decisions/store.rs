use super::*;

// ---- paths and the read API -----------------------------------------------

/// The app data dir. Under `cfg(test)` it is `None` unless `CC_DATA_DIR` points
/// somewhere, so a unit test that reaches the finish seam without a scratch
/// folder (the turn-end tests do) cannot write into the developer's real app
/// data.
pub(crate) fn data_root() -> Option<PathBuf> {
    #[cfg(test)]
    if std::env::var_os("CC_DATA_DIR").is_none() {
        return None;
    }
    crate::settings::paths::data_dir().ok()
}

pub(crate) fn file_stem(parent_id: &str) -> String {
    let s: String = parent_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') { c } else { '_' })
        .collect();
    if s.is_empty() { "_".to_string() } else { s }
}

/// `<root>/subchats/<parent_id>.decisions.md`. The id is a session id the daemon
/// minted; the character filter only keeps a hostile one inside the folder.
pub(crate) fn path_in(root: &Path, parent_id: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.decisions.md", file_stem(parent_id)))
}

/// Where `parent_id`'s log lives (or will live). Step 6's `subchat log` action
/// hands this path to the main chat.
pub fn log_path(parent_id: &str) -> PathBuf {
    path_in(&data_root().unwrap_or_else(|| PathBuf::from(".")), parent_id)
}

/// The log's markdown, whole, or `None` when the chat has no log yet (a mode-off
/// chat never gets one).
pub fn read_log(parent_id: &str) -> Option<String> {
    let text = std::fs::read_to_string(log_path(parent_id)).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// Moves a log to the chat that took over (`respawn`). A destination that
/// already has a log is left alone, and so is the predecessor's: the two are not
/// merged, because overwriting would lose entries and a merge would have to
/// renumber the `replaces` links. The continuation links move with the log.
pub fn move_log(old_parent_id: &str, new_parent_id: &str) {
    if let Some(root) = data_root() {
        move_log_in(&root, old_parent_id, new_parent_id);
    }
}

pub(crate) fn move_log_in(root: &Path, old_parent_id: &str, new_parent_id: &str) {
    if old_parent_id == new_parent_id {
        return;
    }
    let _g = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (from, to) = (path_in(root, old_parent_id), path_in(root, new_parent_id));
    // The links follow the log, and also go when there is no log left to move (a
    // chat with no log yet, or a move that died between the two renames), or they
    // would stay stranded under the old chat's id.
    let mut links_follow = !from.exists();
    if from.exists() {
        if to.exists() {
            log::warn!("subchats: not moving the decisions log {old_parent_id} -> {new_parent_id}: the destination already has one");
        } else if let Err(e) = std::fs::rename(&from, &to) {
            log::warn!("subchats: could not move the decisions log {old_parent_id} -> {new_parent_id}: {e}");
        } else {
            links_follow = true;
            // The successor's session id is a new recall key; the old chat's
            // digest stays as it was.
            write_main_digest_in(root, new_parent_id, &load_in(root, new_parent_id));
        }
    }
    if links_follow {
        let (links_from, links_to) = (continued_path_in(root, old_parent_id), continued_path_in(root, new_parent_id));
        if links_from.exists() {
            if links_to.exists() {
                log::warn!("subchats: not moving the continuation links {old_parent_id} -> {new_parent_id}: the destination already has some");
            } else if let Err(e) = std::fs::rename(&links_from, &links_to) {
                log::warn!("subchats: could not move the continuation links {old_parent_id} -> {new_parent_id}: {e}");
            }
        }
    }
}

/// `<root>/subchats/<parent_id>.continued.json`: which sub carried on which, as
/// `{new sub id: old sub id}`. A continuing sub has a new session id, so without
/// this its predecessor's `decided` and `ruled_out` rows would read as a
/// sibling's and be hidden from it.
pub(super) fn continued_path_in(root: &Path, parent_id: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.continued.json", file_stem(parent_id)))
}

pub(super) type Links = std::collections::BTreeMap<String, String>;

/// What a reader sees: no links when the file is absent or unreadable.
pub(super) fn load_continued_in(root: &Path, parent_id: &str) -> Links {
    std::fs::read_to_string(continued_path_in(root, parent_id))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// What a writer starts from. A file that cannot be parsed is kept as `.bad` and
/// the writer starts empty; a file that cannot be read at all (a share lock, an
/// antivirus scan) is `None`, so the writer leaves it alone instead of replacing
/// every earlier link with one.
pub(super) fn load_continued_for_write(root: &Path, parent_id: &str) -> Option<Links> {
    let path = continued_path_in(root, parent_id);
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(links) => Some(links),
            Err(_) => {
                // The copy must exist before the writer replaces the file.
                let bad = path.with_extension("json.bad");
                match std::fs::rename(&path, &bad) {
                    Ok(()) => {
                        log::warn!("subchats: {} is unreadable JSON, kept as {}", path.display(), bad.display());
                        Some(Links::new())
                    }
                    Err(e) => {
                        log::warn!("subchats: could not keep {} as {}: {e}", path.display(), bad.display());
                        None
                    }
                }
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Links::new()),
        Err(e) => {
            log::warn!("subchats: could not read {}: {e}", path.display());
            None
        }
    }
}

/// Records that `new_sub` carries on `old_sub`'s work (`continue_from`), so the
/// log shows the new sub the old one's own rows too.
pub fn record_continuation(parent_id: &str, new_sub: &str, old_sub: &str) {
    if let Some(root) = data_root() {
        record_continuation_in(&root, parent_id, new_sub, old_sub);
    }
}

pub(crate) fn record_continuation_in(root: &Path, parent_id: &str, new_sub: &str, old_sub: &str) {
    if new_sub == old_sub {
        return;
    }
    let _g = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(mut links) = load_continued_for_write(root, parent_id) else { return };
    links.insert(new_sub.to_string(), old_sub.to_string());
    match serde_json::to_string_pretty(&links) {
        Ok(text) => {
            if let Err(e) = crate::util::write_json_atomic(&continued_path_in(root, parent_id), &text) {
                log::warn!("subchats: could not record that {new_sub} continues {old_sub}: {e}");
            }
        }
        Err(e) => log::warn!("subchats: could not record that {new_sub} continues {old_sub}: {e}"),
    }
}

/// `viewer` and every sub it carries on, nearest first. A chain (C continues B,
/// which continued A) is followed to its end; the walk is bounded so a corrupt
/// file with a cycle cannot loop.
pub(super) fn viewers_in(root: &Path, parent_id: &str, viewer: &str) -> Vec<String> {
    let links = load_continued_in(root, parent_id);
    let mut seen = vec![viewer.to_string()];
    let mut at = viewer.to_string();
    while let Some(old) = links.get(&at) {
        if seen.contains(old) || seen.len() > 16 {
            break;
        }
        seen.push(old.clone());
        at = old.clone();
    }
    seen
}

pub(super) fn load_in(root: &Path, parent_id: &str) -> Vec<Entry> {
    std::fs::read_to_string(path_in(root, parent_id)).map(|t| parse(&t)).unwrap_or_default()
}

pub(super) fn save_in(root: &Path, parent_id: &str, entries: &[Entry]) -> std::io::Result<()> {
    // `write_json_atomic` is the shared temp-file-and-rename writer; it does not
    // care what the text is.
    crate::util::write_json_atomic(&path_in(root, parent_id), &render(entries))
}
