//! Mid-message slash-command context. The CLI expands a slash command only in
//! leading position, so a `/close` written mid-sentence lands as plain prose
//! while the UI still paints it as a pill. Each mentioned command is appended
//! as a pointer block, and the model judges whether the user meant to run it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{enumerate, SlashEntry, SlashSource};

pub const MENTION_BLOCK_OPEN: &str = "<conductor-slash-context>";
pub const MENTION_BLOCK_CLOSE: &str = "</conductor-slash-context>";

/// Past this, a message listing many commands would bury its own content.
const MAX_MENTIONS: usize = 5;

/// Command-ish tokens in `text`, in order, excluding one in leading position
/// (the CLI already expands that one). A token counts only after start-of-text,
/// whitespace, `(` or `>`, which also excludes `` `/close` `` in inline code.
fn scan_tokens(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let lead_skip = text.len() - text.trim_start().len();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'/' {
            i += 1;
            continue;
        }
        let boundary_ok = i == 0
            || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r' | b'(' | b'>');
        if !boundary_ok {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        if j >= bytes.len() || !bytes[j].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-') {
            j += 1;
        }
        // Optional `plugin:skill` second segment.
        if j < bytes.len() && bytes[j] == b':' && bytes.get(j + 1).is_some_and(|c| c.is_ascii_alphabetic()) {
            j += 1;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-') {
                j += 1;
            }
        }
        // A trailing `/` means this was a path or URL segment, not a command.
        let is_path = j < bytes.len() && bytes[j] == b'/';
        if !is_path && i != lead_skip {
            out.push(text[start..j].to_string());
        }
        i = j.max(i + 1);
    }
    out
}

fn source_label(src: &SlashSource) -> String {
    match src {
        SlashSource::Builtin => "builtin".into(),
        SlashSource::UserCommand => "user command".into(),
        SlashSource::ProjectCommand => "project command".into(),
        SlashSource::UserSkill => "user skill".into(),
        SlashSource::ProjectSkill { project } => format!("project skill ({project})"),
        SlashSource::PluginSkill { plugin } => format!("plugin skill ({plugin})"),
        SlashSource::PluginCommand { plugin } => format!("plugin command ({plugin})"),
    }
}

fn qualified_names(e: &SlashEntry) -> Vec<String> {
    match &e.source {
        SlashSource::PluginSkill { plugin } | SlashSource::PluginCommand { plugin } => {
            vec![e.name.clone(), format!("{plugin}:{}", e.name)]
        }
        _ => vec![e.name.clone()],
    }
}

/// Render the context block for `text`, or `None` when nothing is mentioned.
/// `entries` is the resolved command registry.
pub fn build_block(text: &str, entries: &[SlashEntry]) -> Option<String> {
    let tokens = scan_tokens(text);
    if tokens.is_empty() {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for tok in tokens {
        if seen.contains(&tok) || lines.len() >= MAX_MENTIONS {
            continue;
        }
        let hit = entries
            .iter()
            .find(|e| e.path.is_some() && qualified_names(e).iter().any(|n| n == &tok));
        let Some(hit) = hit else { continue };
        seen.push(tok.clone());
        let desc = hit.description.trim();
        let desc = if desc.is_empty() { String::new() } else { format!(": {desc}") };
        lines.push(format!(
            "- /{tok} ({}){desc}\n  {}",
            source_label(&hit.source),
            hit.path.as_deref().unwrap_or_default()
        ));
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "{MENTION_BLOCK_OPEN}\nThe user's message mentions the slash commands below. The CLI did NOT \
expand them - it only expands a command written at the very start of a turn - so none of their \
instructions have been loaded for you.\n\nDecide from the message whether the user wants each one \
RUN now or is only talking about it. To run one, load it first (the Skill tool for a skill, or Read \
its file) and follow it in full; a command the user is merely referring to needs no action. This \
block is machine-generated, not something the user typed.\n\n{}\n{MENTION_BLOCK_CLOSE}",
        lines.join("\n")
    ))
}

/// Removes an appended context block from transcript text. The daemon writes
/// the block into the wire message, so it lands in the CLI's JSONL and would
/// otherwise leak into a derived chat title.
pub fn strip_block(s: &str) -> std::borrow::Cow<'_, str> {
    let Some(open) = s.find(MENTION_BLOCK_OPEN) else { return std::borrow::Cow::Borrowed(s) };
    let after = match s[open..].find(MENTION_BLOCK_CLOSE) {
        Some(rel) => open + rel + MENTION_BLOCK_CLOSE.len(),
        None => s.len(),
    };
    let mut out = s[..open].trim_end().to_string();
    out.push_str(&s[after..]);
    std::borrow::Cow::Owned(out.trim().to_string())
}

/// `enumerate::scan_all` reads every `SKILL.md` body under `~/.claude`, and
/// `scan_tokens` fires on any `/word`, so a burst of sends would repeat that
/// walk for an identical answer. Short enough that a skill edited mid-chat is
/// picked up by the next message.
const REGISTRY_TTL: Duration = Duration::from_secs(5);

/// Keyed by project dir, not a single slot: the registry differs per project
/// and sessions in several projects send interleaved, which would make one
/// slot evict itself every call. Expired keys are dropped on each lookup, so
/// this holds only the projects that sent inside the last `REGISTRY_TTL`.
static REGISTRY_CACHE: Mutex<Option<HashMap<Option<PathBuf>, (Instant, Vec<SlashEntry>)>>> =
    Mutex::new(None);

#[cfg(test)]
static SCANS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Blocking - the lock is deliberately held across the walk so concurrent
/// sends for one project collapse into a single scan instead of racing.
fn cached_scan(project_dir: Option<&Path>) -> Vec<SlashEntry> {
    let mut guard = REGISTRY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    cache.retain(|_, (at, _)| at.elapsed() < REGISTRY_TTL);
    let key = project_dir.map(Path::to_path_buf);
    if let Some((_, entries)) = cache.get(&key) {
        return entries.clone();
    }
    #[cfg(test)]
    SCANS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let entries = enumerate::scan_all(project_dir);
    cache.insert(key, (Instant::now(), entries.clone()));
    entries
}

/// `text` with the context block appended, or unchanged when nothing matched.
/// Scans the command registry only when the text holds a candidate token, so
/// an ordinary message costs one byte-scan and no filesystem work. The scan
/// itself goes to the blocking pool: this sits on the interactive send path.
pub async fn augment(text: &str, project_dir: Option<&Path>) -> String {
    if scan_tokens(text).is_empty() {
        return text.to_string();
    }
    let dir = project_dir.map(Path::to_path_buf);
    let entries = match tokio::task::spawn_blocking(move || cached_scan(dir.as_deref())).await {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("[slash::mentions] registry scan failed: {e}");
            return text.to_string();
        }
    };
    match build_block(text, &entries) {
        Some(block) => format!("{text}\n\n{block}"),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> SlashEntry {
        SlashEntry {
            name: name.to_string(),
            args: None,
            description: format!("does {name}"),
            source: SlashSource::UserSkill,
            path: Some(format!("/home/u/.claude/skills/{name}/SKILL.md")),
        }
    }

    #[test]
    fn skips_leading_command() {
        assert!(scan_tokens("/close now").is_empty());
        assert!(scan_tokens("  \n/close now").is_empty());
    }

    #[test]
    fn finds_mid_and_trailing_commands() {
        assert_eq!(scan_tokens("run /commit then /close up"), vec!["commit", "close"]);
        assert_eq!(scan_tokens("/commit and then /close"), vec!["close"]);
    }

    #[test]
    fn ignores_inline_code_and_paths() {
        assert!(scan_tokens("i typed `/close` earlier").is_empty());
        assert!(scan_tokens("see src/shared/chat and /usr/bin").is_empty());
    }

    #[test]
    fn matches_plugin_qualified_names() {
        let mut e = entry("figma-use");
        e.source = SlashSource::PluginSkill { plugin: "figma".into() };
        let block = build_block("try /figma:figma-use for that", &[e]).unwrap();
        assert!(block.contains("/figma:figma-use"));
    }

    #[test]
    fn block_lists_path_and_none_when_unknown() {
        let block = build_block("ok, /close up", &[entry("close")]).unwrap();
        assert!(block.starts_with(MENTION_BLOCK_OPEN));
        assert!(block.ends_with(MENTION_BLOCK_CLOSE));
        assert!(block.contains("/home/u/.claude/skills/close/SKILL.md"));
        assert!(build_block("ok, /notathing up", &[entry("close")]).is_none());
    }

    #[test]
    fn dedupes_and_caps() {
        let entries: Vec<SlashEntry> = ["a", "b", "c", "d", "e", "f"].iter().map(|n| entry(n)).collect();
        let block = build_block("x /a /a /b /c /d /e /f", &entries).unwrap();
        assert_eq!(block.matches("\n- /").count(), MAX_MENTIONS);
    }

    #[test]
    fn strip_block_removes_appended_context() {
        let augmented = format!("ok, /close up\n\n{}", build_block("ok, /close up", &[entry("close")]).unwrap());
        assert_eq!(strip_block(&augmented), "ok, /close up");
        assert_eq!(strip_block("plain text"), "plain text");
    }

    #[tokio::test]
    async fn augment_is_identity_without_mentions() {
        assert_eq!(augment("just some prose", None).await, "just some prose");
    }

    /// The `/token` matches no command, so the answer is unchanged text either
    /// way - what is asserted is that repeated sends cost one registry walk.
    #[tokio::test]
    async fn repeated_sends_walk_the_registry_once() {
        use std::sync::atomic::Ordering;
        let before = SCANS.load(Ordering::SeqCst);
        for _ in 0..3 {
            assert_eq!(augment("B, /or C", None).await, "B, /or C");
        }
        assert_eq!(SCANS.load(Ordering::SeqCst) - before, 1);
    }
}
