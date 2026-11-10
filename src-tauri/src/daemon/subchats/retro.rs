//! A subchats-mode main chat's retro: one markdown file written when the chat
//! closes, so a later Conductor session can read every closed main chat in one
//! folder and see what version each ran and how it felt to the chat itself.
//!
//! The chat supplies the five prose sections through the `main_chat_retro` MCP
//! tool. Everything else in the frontmatter is stamped here from what the daemon
//! knows, never self-reported: a chat cannot know which build it runs on, and
//! the version is the point of the file (`DAEMON_VERSION` is the real release
//! number on an installed app, because CI rewrites Cargo.toml before every
//! release build).
//!
//! Folder: `<data_dir>/main-chat-retros<instance suffix>/`, one file per chat,
//! `<YYYY-MM-DD>-<session id first 8>.md`. A second call from the same chat on
//! the same day rewrites its file, so a fuller retro replaces a thin one.
//!
//! Frontmatter is flat `key: value` lines (no nesting) so `Grep` and
//! [`parse_frontmatter`] read it without a YAML parser. A retro written by hand
//! in this shape reads the same as a tool-written one.

use super::{card_log, decisions, tool};
use crate::daemon::state::DaemonState;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Per-section cap in characters. A retro is read by a model comparing many of
/// them, so a section that runs long is told to tighten, the way `send_message`
/// refuses an over-cap text.
pub const SECTION_CAP: usize = 1500;

/// The five sections in file order: tool field, heading, what it holds.
pub const SECTIONS: [(&str, &str); 5] = [
    ("did", "What the main chat did"),
    ("efficient", "What felt efficient"),
    ("slow", "What felt slow or wasteful"),
    ("wrong", "What went wrong"),
    ("ideas", "Ideas for main chats"),
];

pub const NOT_A_MAIN_CHAT: &str = "main_chat_retro is only for a chat with Use subchats on (a main chat). This chat is not one, so there is nothing to write: close as usual.";
pub const SUB_REFUSAL: &str = "A sub does not write a retro: it is for a main chat. End your job with finish_subchat.";

/// The prose a chat sends, indexed like [`SECTIONS`].
#[derive(Debug, Clone, Default)]
pub struct Sections(pub [Option<String>; 5]);

impl Sections {
    pub fn from_fields(did: Option<String>, efficient: Option<String>, slow: Option<String>, wrong: Option<String>, ideas: Option<String>) -> Self {
        Sections([did, efficient, slow, wrong, ideas])
    }

    /// Every section trimmed, each present and within [`SECTION_CAP`], or the
    /// first problem naming the field and the fix.
    fn validated(&self) -> Result<Vec<String>, String> {
        let mut out = Vec::with_capacity(SECTIONS.len());
        for ((field, heading), value) in SECTIONS.iter().zip(self.0.iter()) {
            let text = value.as_deref().map(str::trim).unwrap_or("");
            if text.is_empty() {
                return Err(format!(
                    "{field} is missing: write the \"{heading}\" section as plain honest prose, one or two short paragraphs (write that nothing applies if that is true)"
                ));
            }
            let n = text.chars().count();
            if n > SECTION_CAP {
                return Err(format!("{field} is {n} chars, over {SECTION_CAP}: tighten the \"{heading}\" section"));
            }
            out.push(text.to_string());
        }
        Ok(out)
    }
}

/// What the daemon stamps, kept apart from the prose so a test can pin each field.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamp {
    pub version: String,
    pub session_id: String,
    pub chat_title: String,
    pub project: String,
    pub model: String,
    pub effort: String,
    pub started: String,
    pub closed: String,
    pub subs: usize,
    pub subs_finished: usize,
    pub subs_blocked: usize,
    pub subs_by_tier: String,
    pub decisions: usize,
}

/// One line, no newlines: a frontmatter value must not break the flat format.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The chat's `Instance` when it is a main chat that may write a retro. A sub
/// and a chat with the mode off each get a refusal naming why.
fn check_role(state: &DaemonState, session_id: &str) -> Result<crate::types::Instance, String> {
    let Some(inst) = state.registry.get(session_id) else {
        return Err("this chat is not known to the app, so no retro was written".to_string());
    };
    if super::is_sub(&inst) {
        return Err(SUB_REFUSAL.to_string());
    }
    let on = crate::sessions::chat_config::get(session_id).is_some_and(|c| c.subchats_on);
    if !on {
        return Err(NOT_A_MAIN_CHAT.to_string());
    }
    Ok(inst)
}

/// Facts the daemon reads for `main`: its row, its subs and its logs.
fn stamp_for(state: &DaemonState, inst: &crate::types::Instance, now: &chrono::DateTime<chrono::Local>) -> Stamp {
    let id = inst.session_id.as_str();
    let subs: Vec<crate::types::Instance> =
        state.registry.list().into_iter().filter(|i| i.subchat_of.as_deref() == Some(id)).collect();
    let blocked: std::collections::HashSet<String> = card_log::read(id)
        .into_iter()
        .filter(|c| c.kind == card_log::KIND_BLOCKER)
        .filter_map(|c| c.sub_id)
        .collect();
    let mut tiers: BTreeMap<String, usize> = BTreeMap::new();
    for s in &subs {
        *tiers.entry(tool::tier(s)).or_default() += 1;
    }
    let by_tier = if tiers.is_empty() {
        "none".to_string()
    } else {
        tiers.iter().map(|(t, n)| format!("{t} x{n}")).collect::<Vec<_>>().join(", ")
    };
    Stamp {
        version: crate::daemon::health::DAEMON_VERSION.to_string(),
        session_id: id.to_string(),
        chat_title: one_line(&tool::label(inst)),
        project: one_line(&inst.cwd.to_string_lossy()),
        model: one_line(&inst.model),
        effort: one_line(&inst.effort),
        started: one_line(&inst.started_at),
        closed: now.to_rfc3339(),
        subs: subs.len(),
        subs_finished: subs.iter().filter(|s| s.subchat_finished).count(),
        subs_blocked: subs.iter().filter(|s| blocked.contains(&s.session_id)).count(),
        subs_by_tier: by_tier,
        decisions: decisions::read_log(id).map(|t| decisions::parse(&t).len()).unwrap_or(0),
    }
}

/// The file's text: frontmatter, then the five sections in order.
pub fn render(stamp: &Stamp, sections: &[String]) -> String {
    let mut out = String::from("---\n");
    for (k, v) in [
        ("version", stamp.version.clone()),
        ("session_id", stamp.session_id.clone()),
        ("chat_title", stamp.chat_title.clone()),
        ("project", stamp.project.clone()),
        ("model", stamp.model.clone()),
        ("effort", stamp.effort.clone()),
        ("started", stamp.started.clone()),
        ("closed", stamp.closed.clone()),
        ("subs", stamp.subs.to_string()),
        ("subs_finished", stamp.subs_finished.to_string()),
        ("subs_blocked", stamp.subs_blocked.to_string()),
        ("subs_by_tier", stamp.subs_by_tier.clone()),
        ("decisions", stamp.decisions.to_string()),
    ] {
        out.push_str(&format!("{k}: {v}\n"));
    }
    out.push_str("---\n");
    for ((_, heading), body) in SECTIONS.iter().zip(sections) {
        out.push_str(&format!("\n## {heading}\n\n{body}\n"));
    }
    out
}

/// The frontmatter's `key: value` lines, or `None` when the text does not open
/// with a `---` block. A reader (and the test of a hand-written retro) uses this
/// instead of a YAML parser because the format is flat on purpose.
pub fn parse_frontmatter(text: &str) -> Option<BTreeMap<String, String>> {
    let mut lines = text.replace("\r\n", "\n");
    lines.insert(0, '\n');
    let body = lines.strip_prefix("\n---\n")?;
    let end = body.find("\n---")?;
    let mut map = BTreeMap::new();
    for line in body[..end].lines() {
        if let Some((k, v)) = line.split_once(": ") {
            map.insert(k.trim().to_string(), v.trim().to_string());
        } else if let Some(k) = line.strip_suffix(':') {
            map.insert(k.trim().to_string(), String::new());
        }
    }
    Some(map)
}

/// `<root>/main-chat-retros<suffix>/`. The suffix is the daemon instance's, so a
/// dev or test daemon on the same data folder writes next to the real folder
/// and never into it.
pub fn dir_in(root: &Path, suffix: &str) -> PathBuf {
    root.join(format!("main-chat-retros{suffix}"))
}

fn file_name(date: &str, session_id: &str) -> String {
    let id8: String = decisions::file_stem(session_id).chars().take(8).collect();
    format!("{date}-{id8}.md")
}

/// What a successful write reports back to the chat.
#[derive(Debug, Clone, PartialEq)]
pub struct Written {
    pub path: PathBuf,
    pub version: String,
    pub rewritten: bool,
}

/// Writes the retro for `session_id` under `root`. The seam the tests use; the
/// route calls [`write`], which supplies the real data dir and instance suffix.
pub fn write_in(
    state: &DaemonState,
    session_id: &str,
    sections: &Sections,
    root: &Path,
    suffix: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Result<Written, String> {
    let inst = check_role(state, session_id)?;
    let prose = sections.validated()?;
    let stamp = stamp_for(state, &inst, &now);
    let text = render(&stamp, &prose);
    let dir = dir_in(root, suffix);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create the retro folder: {e}"))?;
    let path = dir.join(file_name(&now.format("%Y-%m-%d").to_string(), session_id));
    let rewritten = path.exists();
    // Temp file then rename: a reader scanning the folder never sees half a retro.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write the retro: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not write the retro: {e}"))?;
    Ok(Written { path, version: stamp.version, rewritten })
}

pub fn write(state: &DaemonState, session_id: &str, sections: &Sections) -> Result<Written, String> {
    let root = decisions::data_root().ok_or_else(|| "the app data folder is unavailable, so no retro was written".to_string())?;
    write_in(state, session_id, sections, &root, &crate::daemon::instance::instance_suffix(), chrono::Local::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn full() -> Sections {
        Sections::from_fields(
            Some("Ran the dashboard build.".into()),
            Some("Handing jobs to subs kept this chat small.".into()),
            Some("Queued subs sat idle for hours.".into()),
            Some("The held queue was wiped by a test daemon.".into()),
            Some("Wake the main chat when a lane goes quiet.".into()),
        )
    }

    fn now() -> chrono::DateTime<chrono::Local> {
        use chrono::TimeZone;
        chrono::Local.with_ymd_and_hms(2026, 11, 11, 9, 30, 0).unwrap()
    }

    fn register_main(state: &DaemonState, id: &str, mode_on: bool) {
        let _ = state;
        crate::sessions::chat_config::set_subchats_on(id, mode_on);
    }

    fn insert_row(state: &DaemonState, id: &str) {
        state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-06T08:00:00+00:00");
        state.registry.set_model_effort(id, "claude-opus-4-1", "high");
        state.registry.set_name(id, "Chat as dashboard".to_string());
    }

    #[test]
    fn a_main_chat_gets_a_file_with_daemon_stamped_fields_and_five_sections() {
        let _data = super::super::TempDataDir::new();
        let st = state();
        insert_row(&st, "aaaaaaaa-1111");
        register_main(&st, "aaaaaaaa-1111", true);
        let root = tempfile::tempdir().unwrap();

        let w = write_in(&st, "aaaaaaaa-1111", &full(), root.path(), "", now()).expect("written");
        assert_eq!(w.path, root.path().join("main-chat-retros").join("2026-11-11-aaaaaaaa.md"));
        assert_eq!(w.version, crate::daemon::health::DAEMON_VERSION, "the version is the daemon's, never the chat's");
        assert!(!w.rewritten);

        let text = std::fs::read_to_string(&w.path).unwrap();
        let fm = parse_frontmatter(&text).expect("frontmatter");
        assert_eq!(fm["version"], crate::daemon::health::DAEMON_VERSION);
        assert_eq!(fm["session_id"], "aaaaaaaa-1111");
        assert_eq!(fm["chat_title"], "Chat as dashboard");
        assert_eq!(fm["model"], "claude-opus-4-1");
        assert_eq!(fm["effort"], "high");
        assert_eq!(fm["started"], "2026-11-06T08:00:00+00:00");
        assert!(fm["closed"].starts_with("2026-11-11T09:30:00"), "{}", fm["closed"]);
        assert_eq!(fm["subs"], "0");
        assert_eq!(fm["subs_by_tier"], "none");
        assert_eq!(fm["decisions"], "0");
        for (_, heading) in SECTIONS {
            assert!(text.contains(&format!("## {heading}\n")), "missing {heading}");
        }
        assert!(text.contains("Queued subs sat idle for hours."));
    }

    #[test]
    fn subs_and_decisions_are_counted_from_the_daemons_own_records() {
        let _data = super::super::TempDataDir::new();
        let st = state();
        insert_row(&st, "main-cnt-1");
        register_main(&st, "main-cnt-1", true);
        for (id, finished) in [("sub-cnt-a", true), ("sub-cnt-b", false)] {
            insert_row(&st, id);
            st.registry.set_subchat_of(id, Some("main-cnt-1".into()));
            st.registry.set_subchat_finished(id, finished);
        }
        let root = tempfile::tempdir().unwrap();
        let w = write_in(&st, "main-cnt-1", &full(), root.path(), "", now()).unwrap();
        let fm = parse_frontmatter(&std::fs::read_to_string(&w.path).unwrap()).unwrap();
        assert_eq!(fm["subs"], "2");
        assert_eq!(fm["subs_finished"], "1");
        assert_eq!(fm["subs_by_tier"], "opus high x2");
    }

    #[test]
    fn a_sub_and_a_plain_chat_are_refused_and_write_nothing() {
        let _data = super::super::TempDataDir::new();
        let st = state();
        insert_row(&st, "plain-chat-1");
        insert_row(&st, "its-main-1");
        register_main(&st, "its-main-1", true);
        insert_row(&st, "a-sub-0001");
        st.registry.set_subchat_of("a-sub-0001", Some("its-main-1".into()));
        let root = tempfile::tempdir().unwrap();

        assert_eq!(write_in(&st, "a-sub-0001", &full(), root.path(), "", now()).unwrap_err(), SUB_REFUSAL);
        assert_eq!(write_in(&st, "plain-chat-1", &full(), root.path(), "", now()).unwrap_err(), NOT_A_MAIN_CHAT);
        assert!(write_in(&st, "ghost-chat-1", &full(), root.path(), "", now()).unwrap_err().contains("not known"));
        assert!(!root.path().join("main-chat-retros").exists(), "a refusal creates no folder");
    }

    #[test]
    fn a_missing_empty_or_over_cap_section_is_refused_naming_the_field() {
        let _data = super::super::TempDataDir::new();
        let st = state();
        insert_row(&st, "main-cap-1");
        register_main(&st, "main-cap-1", true);
        let root = tempfile::tempdir().unwrap();

        let mut s = full();
        s.0[3] = None;
        let e = write_in(&st, "main-cap-1", &s, root.path(), "", now()).unwrap_err();
        assert!(e.starts_with("wrong is missing") && e.contains("What went wrong"), "{e}");

        let mut s = full();
        s.0[1] = Some("   \n ".into());
        assert!(write_in(&st, "main-cap-1", &s, root.path(), "", now()).unwrap_err().starts_with("efficient is missing"));

        let mut s = full();
        s.0[2] = Some("x".repeat(SECTION_CAP + 1));
        let e = write_in(&st, "main-cap-1", &s, root.path(), "", now()).unwrap_err();
        assert!(e.contains(&format!("slow is {} chars, over {SECTION_CAP}", SECTION_CAP + 1)), "{e}");

        let mut s = full();
        s.0[2] = Some("x".repeat(SECTION_CAP));
        assert!(write_in(&st, "main-cap-1", &s, root.path(), "", now()).is_ok(), "exactly the cap passes");
    }

    #[test]
    fn the_folder_follows_the_data_dir_and_the_instance_suffix() {
        let _data = super::super::TempDataDir::new();
        let st = state();
        insert_row(&st, "main-dir-1");
        register_main(&st, "main-dir-1", true);

        // The route's own path: under the CC_DATA_DIR override, in the suffixed folder.
        let w = write(&st, "main-dir-1", &full()).expect("written");
        let data = std::path::PathBuf::from(std::env::var("CC_DATA_DIR").unwrap());
        let expected_dir = dir_in(&data, &crate::daemon::instance::instance_suffix());
        assert_eq!(w.path.parent().unwrap(), expected_dir);

        // A test or dev daemon (a suffix) never writes into the plain folder.
        let root = tempfile::tempdir().unwrap();
        let w = write_in(&st, "main-dir-1", &full(), root.path(), "-test", now()).unwrap();
        assert_eq!(w.path.parent().unwrap(), root.path().join("main-chat-retros-test"));
        assert!(!root.path().join("main-chat-retros").exists());
    }

    #[test]
    fn a_second_call_the_same_day_rewrites_the_file() {
        let _data = super::super::TempDataDir::new();
        let st = state();
        insert_row(&st, "main-twice-1");
        register_main(&st, "main-twice-1", true);
        let root = tempfile::tempdir().unwrap();
        let first = write_in(&st, "main-twice-1", &full(), root.path(), "", now()).unwrap();
        let mut s = full();
        s.0[0] = Some("A fuller account.".into());
        let second = write_in(&st, "main-twice-1", &s, root.path(), "", now()).unwrap();
        assert_eq!(first.path, second.path);
        assert!(second.rewritten);
        assert!(std::fs::read_to_string(&second.path).unwrap().contains("A fuller account."));
        assert_eq!(std::fs::read_dir(first.path.parent().unwrap()).unwrap().count(), 1, "no temp file left behind");
    }

    /// A retro written by hand (the first one, for the main chat that ran this
    /// build) uses the same flat frontmatter, and reads through the same parser.
    #[test]
    fn a_hand_written_retro_parses_with_the_same_fields() {
        let hand = "---\nversion: 0.2.147\nsession_id: 22ff80ce-62a0-4c57-a3c0-f1f5646d63a6\nchat_title: Chat as dashboard\nproject: C:\\Users\\tecno\\Desktop\\Projects\\claude_usage_in_taskbar\nmodel: claude-opus-4-1\neffort: high\nstarted: 2026-11-06T08:00:00+00:00\nclosed: 2026-11-11T09:30:00+00:00\nsubs: 12\nsubs_finished: 10\nsubs_blocked: 2\nsubs_by_tier: sonnet high x8, opus high x4\ndecisions: 110\n---\n\n## What the main chat did\n\nBuilt it.\n";
        let fm = parse_frontmatter(hand).expect("frontmatter");
        let st = state();
        insert_row(&st, "x-main-0001");
        let inst = st.registry.get("x-main-0001").unwrap();
        let tool_written = render(&stamp_for(&st, &inst, &now()), &vec!["a".to_string(); 5]);
        let tool_keys: Vec<String> = parse_frontmatter(&tool_written).unwrap().keys().cloned().collect();
        let hand_keys: Vec<String> = fm.keys().cloned().collect();
        assert_eq!(hand_keys, tool_keys, "same field set");
        assert_eq!(fm["version"], "0.2.147");
        assert_eq!(fm["decisions"], "110");
    }

    #[test]
    fn frontmatter_values_never_carry_a_newline() {
        assert_eq!(one_line("a\nb\r\n c"), "a b c");
        assert!(parse_frontmatter("no frontmatter").is_none());
        let m = parse_frontmatter("---\r\nk: v\r\n---\r\nbody").unwrap();
        assert_eq!(m["k"], "v");
    }
}
