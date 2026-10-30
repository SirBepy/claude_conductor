//! Todo ids: `<device label>-<number>`, e.g. `pc-1407`, `mac2-0003`. One parser
//! for every reader of `.claude/todos/` (file names, `PLAN.md` lines, claim
//! files, ids a user types), so a spelling is accepted or refused the same way
//! everywhere. Mirrors the contract in `~/.claude/skills/close/ai-todos-format.md`.
//!
//! Padding is never significant on read (`pc-7` is `pc-0007`); the canonical
//! spelling pads to four digits and grows past 9999 (`pc-10000`). A bare
//! numeric id (`1407`, `1407-slug.md`) predates device labels, and every such
//! todo was made on the Windows PC, so it reads as label `pc`.

use std::path::{Path, PathBuf};

/// The label every pre-device-label (bare numeric) todo belongs to.
pub const LEGACY_LABEL: &str = "pc";

/// One todo, independent of how its id was spelled.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TodoKey {
    pub label: String,
    pub number: u64,
}

impl TodoKey {
    /// `pc-1407`: the only spelling that is written out or shown.
    pub fn canonical(&self) -> String {
        format!("{}-{:04}", self.label, self.number)
    }
}

/// A todo or claim file name taken apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedName {
    pub key: TodoKey,
    /// Everything after the id, without the leading dash; empty when absent.
    pub slug: String,
    /// True when the name had no device label (a bare numeric id).
    pub legacy: bool,
}

/// What a PLAN line or a typed id asks for. A bare number does not name a
/// device; typed by a user it resolves by the rules in `find_todo_file`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wanted {
    Key(TodoKey),
    Bare(u64),
}

impl Wanted {
    /// Whether a todo with `key` is the one asked for. A bare number is the
    /// legacy spelling, so it names the `pc` todo only; this is how a PLAN
    /// line and a claim file are matched. (A bare number typed by a user also
    /// reaches other labels, see `find_todo_file`.)
    pub fn matches(&self, key: &TodoKey) -> bool {
        match self {
            Wanted::Key(k) => k == key,
            Wanted::Bare(n) => *n == key.number && key.label == LEGACY_LABEL,
        }
    }
}

/// `^[a-z]+[0-9]*$`
fn is_label(s: &str) -> bool {
    let letters = s.chars().take_while(|c| c.is_ascii_lowercase()).count();
    letters > 0 && s[letters..].chars().all(|c| c.is_ascii_digit())
}

/// The device kinds the id contract names: a label is `pc` or `mac`, plus a
/// number for a second machine (`pc2`, `mac2`).
///
/// Hardcoded on purpose: one dev, two machines, so a registry of labels would
/// be machinery for a set that never changes. The cost is that a third kind of
/// device (a todo from a peer labelled `laptop`) stops being recognized as a
/// todo until it is added here, unless it is this machine's own
/// `device-label`.
const DEVICE_KINDS: [&str; 2] = ["pc", "mac"];

/// Read once: `parse_stem` runs per file name, and a file read each time would
/// cost a disk hit for every entry in the backlog.
fn this_device() -> &'static str {
    static LABEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LABEL.get_or_init(device_label)
}

/// Whether `s` can be the label of a todo id. Any `^[a-z]+[0-9]*$` word has
/// the shape (`notes`, `fix`, `sc`), so `notes-1.md` and `fix-3-things.md`
/// would read as todos and `fix-3-a.md` / `fix-3-b.md` as one colliding id;
/// the label has to be a device kind or the label this machine was given.
fn is_device_label(s: &str) -> bool {
    is_label(s)
        && (s == this_device()
            || DEVICE_KINDS.iter().any(|kind| s.strip_prefix(kind).is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))))
}

fn digits(s: &str) -> Option<u64> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parses the part of a file name before its extension:
/// `pc-1407-slug`, `pc-1407`, `1407-slug`, `1407`.
pub fn parse_stem(stem: &str) -> Option<ParsedName> {
    let first = stem.split('-').next()?;
    if let Some(number) = digits(first) {
        let slug = stem.get(first.len() + 1..).unwrap_or("").to_string();
        return Some(ParsedName { key: TodoKey { label: LEGACY_LABEL.into(), number }, slug, legacy: true });
    }
    if !is_device_label(first) {
        return None;
    }
    let after = &stem[first.len()..];
    let after = after.strip_prefix('-')?;
    let second = after.split('-').next()?;
    let number = digits(second)?;
    let slug = after.get(second.len() + 1..).unwrap_or("").to_string();
    Some(ParsedName { key: TodoKey { label: first.into(), number }, slug, legacy: false })
}

/// A todo file name (`pc-1407-slug.md`).
pub fn parse_file_name(name: &str) -> Option<ParsedName> {
    parse_stem(name.strip_suffix(".md")?)
}

/// A claim file name (`pc-1407.claim`, `pc-1407-slug.claim`, legacy `1407.claim`).
pub fn parse_claim_name(name: &str) -> Option<ParsedName> {
    parse_stem(name.strip_suffix(".claim")?)
}

/// An id as written on a PLAN line or typed by a user. Tolerates a trailing
/// `.md` and a slug after the id.
pub fn parse_wanted(input: &str) -> Option<Wanted> {
    let s = input.trim();
    let s = s.strip_suffix(".md").unwrap_or(s);
    let p = parse_stem(s)?;
    Some(if p.legacy { Wanted::Bare(p.key.number) } else { Wanted::Key(p.key) })
}

/// This machine's device label (`~/.claude/device-label`). The id scripts fail
/// loudly without it; a reader falls back to the legacy label instead, since
/// the only todos that exist without a label were made on the PC.
pub fn device_label() -> String {
    dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".claude").join("device-label")).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| is_label(s))
        .unwrap_or_else(|| LEGACY_LABEL.to_string())
}

/// Every backlog todo file directly in `todos_dir`, with its parsed id.
/// Files whose name is not an id are left out.
pub fn list_todo_files(todos_dir: &Path) -> Vec<(TodoKey, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(todos_dir) else { return Vec::new() };
    let mut out: Vec<(TodoKey, PathBuf)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| super::todo_stats::is_backlog_file(p))
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?.to_string();
            Some((parse_file_name(&name)?.key, p))
        })
        .collect();
    out.sort_by(|a, b| (&a.0.label, a.0.number, &a.1).cmp(&(&b.0.label, b.0.number, &b.1)));
    out
}

/// The backlog file for `input`. A full id (`pc-1407`) is exact. A bare number
/// resolves to `device`'s todo first, else to the one todo any other label
/// has, and is an error naming every candidate when several labels match.
pub fn find_todo_file(todos_dir: &Path, input: &str, device: &str) -> Result<PathBuf, String> {
    let wanted = parse_wanted(input).ok_or_else(|| format!("'{input}' is not a todo id"))?;
    let files = list_todo_files(todos_dir);
    let mut hits: Vec<&(TodoKey, PathBuf)> = files
        .iter()
        .filter(|(k, _)| match &wanted {
            Wanted::Key(want) => want == k,
            Wanted::Bare(n) => *n == k.number,
        })
        .collect();
    if let Wanted::Bare(_) = wanted {
        let mine: Vec<_> = hits.iter().copied().filter(|(k, _)| k.label == device).collect();
        if !mine.is_empty() {
            hits = mine;
        }
    }
    match hits.as_slice() {
        [] => Err(format!("no todo {input} in {}", todos_dir.display())),
        [one] => Ok(one.1.clone()),
        many => {
            let names: Vec<String> = many
                .iter()
                .map(|(_, p)| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
                .collect();
            Err(format!("several todos match {input}: {}", names.join(", ")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(label: &str, number: u64) -> TodoKey {
        TodoKey { label: label.into(), number }
    }

    #[test]
    fn a_new_format_name_splits_into_label_number_and_slug() {
        let p = parse_file_name("pc-1407-white-unresponsive-windows.md").unwrap();
        assert_eq!(p.key, key("pc", 1407));
        assert_eq!(p.slug, "white-unresponsive-windows");
        assert!(!p.legacy);
    }

    #[test]
    fn a_legacy_numeric_name_reads_as_the_pc_label() {
        let p = parse_file_name("1407-x.md").unwrap();
        assert_eq!(p.key, key("pc", 1407));
        assert_eq!(p.slug, "x");
        assert!(p.legacy);
        assert_eq!(parse_file_name("07-x.md").unwrap().key, key("pc", 7));
    }

    #[test]
    fn a_name_with_no_slug_still_parses() {
        assert_eq!(parse_file_name("pc-7.md").unwrap().slug, "");
        assert_eq!(parse_file_name("7.md").unwrap().key, key("pc", 7));
    }

    #[test]
    fn numbers_past_four_digits_and_labels_with_digits_parse() {
        assert_eq!(parse_file_name("mac2-10000-big.md").unwrap().key, key("mac2", 10000));
        assert_eq!(key("mac2", 10000).canonical(), "mac2-10000");
    }

    #[test]
    fn the_canonical_spelling_pads_to_four_digits() {
        assert_eq!(key("pc", 7).canonical(), "pc-0007");
        assert_eq!(key("pc", 1407).canonical(), "pc-1407");
    }

    #[test]
    fn names_that_are_not_ids_do_not_parse() {
        assert_eq!(parse_file_name("notes.md"), None);
        assert_eq!(parse_file_name("PLAN.md"), None);
        assert_eq!(parse_file_name("Pc-1-x.md"), None);
        assert_eq!(parse_file_name("pc-x-1.md"), None);
        assert_eq!(parse_file_name("12-x.txt"), None);
    }

    #[test]
    fn a_name_without_a_device_label_is_not_a_todo() {
        for name in ["notes-1.md", "fix-3-things.md", "fix-3-a.md", "sc-56160-x.md", "v2-4.md"] {
            assert_eq!(parse_file_name(name), None, "{name}");
        }
        assert_eq!(parse_wanted("fix-3-things"), None);
        assert_eq!(parse_wanted("sc-56160"), None);
        for name in ["pc-3.md", "mac-3-x.md", "pc2-3-x.md", "mac12-0003.md"] {
            assert!(parse_file_name(name).is_some(), "{name}");
        }
    }

    #[test]
    fn fix_3_a_and_fix_3_b_are_neither_todos_nor_a_collision_for_pc_0003() {
        let dir = todos(&["fix-3-a.md", "fix-3-b.md", "notes-1.md", "pc-0003-real.md"]);
        assert_eq!(list_todo_files(dir.path()).len(), 1);
        // Another device's bare number: the one real todo, not an ambiguity with the look-alikes.
        assert!(find_todo_file(dir.path(), "3", "mac").unwrap().ends_with("pc-0003-real.md"));
    }

    #[test]
    fn padding_is_not_significant_on_read() {
        assert_eq!(parse_wanted("pc-7"), parse_wanted("pc-0007"));
        assert_eq!(parse_wanted("pc-7"), Some(Wanted::Key(key("pc", 7))));
        assert_eq!(key("pc", 7).canonical(), "pc-0007");
    }

    #[test]
    fn a_bare_number_is_wanted_without_a_label() {
        assert_eq!(parse_wanted("1407"), Some(Wanted::Bare(1407)));
        assert_eq!(parse_wanted("1407-slug"), Some(Wanted::Bare(1407)));
        assert_eq!(parse_wanted("pc-1407.md"), Some(Wanted::Key(key("pc", 1407))));
    }

    #[test]
    fn claim_names_accept_the_legacy_and_the_slug_spellings() {
        assert_eq!(parse_claim_name("pc-1407.claim").unwrap().key, key("pc", 1407));
        assert_eq!(parse_claim_name("1407.claim").unwrap().key, key("pc", 1407));
        assert_eq!(parse_claim_name("pc-1407-slug.claim").unwrap().key, key("pc", 1407));
        assert_eq!(parse_claim_name("pc-1407.md"), None);
    }

    fn todos(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for f in files {
            std::fs::write(dir.path().join(f), "x").unwrap();
        }
        dir
    }

    #[test]
    fn find_matches_any_padding_and_a_legacy_file() {
        let dir = todos(&["pc-0007-a.md", "1407-b.md", "PLAN.md"]);
        assert!(find_todo_file(dir.path(), "pc-7", "pc").unwrap().ends_with("pc-0007-a.md"));
        assert!(find_todo_file(dir.path(), "pc-1407", "pc").unwrap().ends_with("1407-b.md"));
        assert!(find_todo_file(dir.path(), "pc-9", "pc").is_err());
    }

    #[test]
    fn a_bare_number_prefers_this_device_then_a_unique_other_label() {
        let dir = todos(&["pc-1407-a.md", "mac-1407-b.md", "mac-0003-c.md"]);
        assert!(find_todo_file(dir.path(), "1407", "pc").unwrap().ends_with("pc-1407-a.md"));
        assert!(find_todo_file(dir.path(), "1407", "mac").unwrap().ends_with("mac-1407-b.md"));
        assert!(find_todo_file(dir.path(), "3", "pc").unwrap().ends_with("mac-0003-c.md"));
    }

    #[test]
    fn a_bare_number_matching_several_other_labels_names_them_all() {
        let dir = todos(&["mac-0005-a.md", "pc2-0005-b.md"]);
        let err = find_todo_file(dir.path(), "5", "pc").unwrap_err();
        assert!(err.contains("mac-0005-a.md") && err.contains("pc2-0005-b.md"), "{err}");
    }
}
