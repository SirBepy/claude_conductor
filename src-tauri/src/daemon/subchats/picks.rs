//! Autopilot picks (pc-1750): choices Claude made by itself on an unattended run
//! because nobody was there to answer a question card. Joe reviews them later,
//! one by one: agree, or overrule with what he wants instead, which becomes a
//! change of the code that a chat marks corrected.
//!
//! A pick is recorded only by the `autopilot_pick` MCP tool, never inferred from
//! a sub's `finish_subchat.decided` (pc-1663 measured that most of those rows are
//! status facts). The tool is listed for every chat (the tool list is fixed when
//! the MCP server starts), so the gate is here: a chat whose run is not
//! unattended is refused and told to ask on a card, which keeps an attended
//! choice out of the review list.
//!
//! Store: `<data_dir>/subchats/<owner>.picks.json`, next to the owner's decisions
//! log (`decisions.rs`). The owner is the main chat a sub belongs to, or the chat
//! itself. The typed record (options, status, Joe's correction) lives here; each
//! pick also writes one plain `Decided` line into the decisions log, so a later
//! sub is told the choice was made, and an overrule closes that line with a
//! `replaces` entry. A typed row inside the markdown log was rejected: its
//! entries are append-and-close, and a pick's review status has to change.
//!
//! Every field except the id has `#[serde(default)]`, and an unreadable file is
//! kept as `.bad` beside it, never read as empty (the same rule as `held.json`).

use super::decisions::{self, Kind, NewEntry};
use crate::daemon::state::DaemonState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A chat whose run is not unattended is sent here: the question card is the
/// channel for Joe, and an attended choice never lands in the review list.
pub const ATTENDED_REFUSAL: &str = "autopilot_pick is only for an unattended run (this chat is not on autopilot). Joe is here: ask the question on a card with ask_user_question instead of choosing for him.";
pub const UNKNOWN_CHAT: &str = "this chat is not known to the app, so no pick was recorded";

const QUESTION_CAP: usize = 400;
const OPTION_CAP: usize = 200;
const REASON_CAP: usize = 600;
const LANDED_CAP: usize = 300;
const NOTE_CAP: usize = 300;
const MAX_OPTIONS: usize = 8;
/// One owner's list never grows past this: an overnight run that picks on every
/// step would otherwise fill a file Joe has to read.
const MAX_PICKS: usize = 300;

/// Serializes every read-modify-write of every picks file.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Joe has not looked at it yet.
    #[default]
    Unreviewed,
    /// Joe agrees with Claude's choice.
    Agreed,
    /// Joe wants something else; the code change is still to do.
    Overruled,
    /// The overruled choice was changed in the code.
    Corrected,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Pick {
    /// `P1`, `P2`, ... per owner, never reused.
    #[serde(default)]
    pub id: String,
    /// RFC 3339 local time the pick was recorded.
    #[serde(default)]
    pub date: String,
    /// The sub's name, or `main chat`.
    #[serde(default)]
    pub who: String,
    /// The sub's session id, when a sub picked.
    #[serde(default)]
    pub sub: Option<String>,
    #[serde(default)]
    pub question: String,
    /// Every candidate, the picked one included.
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub pick: String,
    #[serde(default)]
    pub reason: String,
    /// Where it landed: a commit, a file, a todo.
    #[serde(default)]
    pub landed: String,
    #[serde(default)]
    pub status: Status,
    /// What Joe wants instead, once overruled.
    #[serde(default)]
    pub instead: Option<String>,
    /// The `D<n>` line this pick wrote into the decisions log.
    #[serde(default)]
    pub log_id: Option<u32>,
    /// What the correcting chat reports (commit, files).
    #[serde(default)]
    pub corrected_note: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    #[serde(default)]
    picks: Vec<Pick>,
}

pub(crate) fn path_in(root: &Path, owner: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.picks.json", decisions::file_stem(owner)))
}

/// The stored picks. Only a file that is not there is empty: any other read
/// error (a sharing violation from a scanner or a sync tool) is an `Err`, so a
/// write never starts from an empty list and replaces picks it failed to read.
fn try_load_in(root: &Path, owner: &str) -> Result<Vec<Pick>, String> {
    let path = path_in(root, owner);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read the picks file, nothing was changed: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<File>(&text) {
        Ok(f) => Ok(f.picks),
        Err(e) => {
            // Never read as empty: the next write would replace the only copy.
            let bad = path.with_extension("json.bad");
            log::warn!("subchats: unreadable picks file {} ({e}); kept as {}", path.display(), bad.display());
            let _ = std::fs::rename(&path, &bad);
            Ok(Vec::new())
        }
    }
}

/// For a read-only caller, where a failed read shows an empty list.
fn load_in(root: &Path, owner: &str) -> Vec<Pick> {
    try_load_in(root, owner).unwrap_or_default()
}

fn save_in(root: &Path, owner: &str, picks: &[Pick]) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(&File { picks: picks.to_vec() }).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(&path_in(root, owner), &text)
}

/// Every pick of `owner`'s run, oldest first.
pub fn list_in(root: &Path, owner: &str) -> Vec<Pick> {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    load_in(root, owner)
}

/// The main chat whose list `session_id` reads: its parent when it is a sub,
/// else itself.
pub fn owner_of(state: &DaemonState, session_id: &str) -> String {
    state
        .registry
        .get(session_id)
        .and_then(|i| i.subchat_of)
        .unwrap_or_else(|| session_id.to_string())
}

fn clip(text: &str, cap: usize) -> String {
    let one = decisions::one_line(text);
    if one.chars().count() <= cap {
        return one;
    }
    let cut: String = one.chars().take(cap).collect();
    format!("{cut}...")
}

/// What a `record` call carries.
#[derive(Debug, Default, Clone)]
pub struct NewPick {
    pub question: String,
    pub options: Vec<String>,
    pub pick: String,
    pub reason: String,
    pub landed: String,
}

/// A call is unattended when the chat itself, or the main chat it belongs to, is
/// on autopilot (`Instance.autopilot`, set by the `<cc-autopilot:on>` marker a
/// run's skill prints).
fn check_unattended(state: &DaemonState, session_id: &str) -> Result<(crate::types::Instance, String), String> {
    let Some(inst) = state.registry.get(session_id) else { return Err(UNKNOWN_CHAT.to_string()) };
    let owner = inst.subchat_of.clone().unwrap_or_else(|| session_id.to_string());
    let owner_on = state.registry.get(&owner).is_some_and(|m| m.autopilot);
    if inst.autopilot || owner_on {
        Ok((inst, owner))
    } else {
        Err(ATTENDED_REFUSAL.to_string())
    }
}

fn validated(input: &NewPick) -> Result<NewPick, String> {
    let question = clip(&input.question, QUESTION_CAP);
    if question.is_empty() {
        return Err("question is missing: write the choice as the question Joe would have been asked".to_string());
    }
    let mut options: Vec<String> = Vec::new();
    for o in &input.options {
        let o = clip(o, OPTION_CAP);
        if !o.is_empty() && !options.iter().any(|x| x.eq_ignore_ascii_case(&o)) {
            options.push(o);
        }
    }
    if options.len() < 2 {
        return Err("options needs at least two different candidates, the picked one included: a choice with no alternative is not a pick (a status fact belongs in the report, not here)".to_string());
    }
    if options.len() > MAX_OPTIONS {
        return Err(format!("options has {} entries, over {MAX_OPTIONS}: keep the real candidates", options.len()));
    }
    let pick = clip(&input.pick, OPTION_CAP);
    let Some(pick) = options.iter().find(|o| o.eq_ignore_ascii_case(&pick)).cloned() else {
        return Err("pick must be one of the options, spelled the same".to_string());
    };
    let reason = clip(&input.reason, REASON_CAP);
    if reason.is_empty() {
        return Err("reason is missing: say why this option over the others".to_string());
    }
    Ok(NewPick { question, options, pick, reason, landed: clip(&input.landed, LANDED_CAP) })
}

pub fn record(state: &DaemonState, session_id: &str, input: &NewPick) -> Result<Pick, String> {
    let (inst, owner) = check_unattended(state, session_id)?;
    let clean = validated(input)?;
    let Some(root) = decisions::data_root() else { return Err("the app data folder is not available".to_string()) };
    let who = if super::is_sub(&inst) { decisions::sub_name(state, session_id) } else { "main chat".to_string() };
    let sub = super::is_sub(&inst).then(|| session_id.to_string());

    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut picks = try_load_in(&root, &owner)?;
    // A restated pick (the same question and option) is the one already stored.
    if let Some(same) = picks.iter().find(|p| {
        p.status == Status::Unreviewed && p.question.eq_ignore_ascii_case(&clean.question) && p.pick.eq_ignore_ascii_case(&clean.pick)
    }) {
        return Ok(same.clone());
    }
    // Reviewed picks stay stored but no longer count: the cap is about what Joe still has to read.
    let open = picks.iter().filter(|p| matches!(p.status, Status::Unreviewed | Status::Overruled)).count();
    if open >= MAX_PICKS {
        return Err(format!("{MAX_PICKS} picks are already waiting for Joe's review: stop choosing and report the rest as blocked"));
    }
    let n = picks.iter().filter_map(|p| p.id.strip_prefix('P').and_then(|n| n.parse::<u32>().ok())).max().unwrap_or(0) + 1;
    let id = format!("P{n}");
    let log_id = log_line(&root, &owner, &who, sub.as_deref(), &id, &clean).first().copied();
    let pick = Pick {
        id,
        date: chrono::Local::now().to_rfc3339(),
        who,
        sub,
        question: clean.question,
        options: clean.options,
        pick: clean.pick,
        reason: clean.reason,
        landed: clean.landed,
        status: Status::Unreviewed,
        instead: None,
        log_id,
        corrected_note: None,
    };
    picks.push(pick.clone());
    save_in(&root, &owner, &picks).map_err(|e| format!("could not save the pick: {e}"))?;
    drop(_g);
    announce(state, &owner, &root);
    Ok(pick)
}

/// The decisions-log line for a pick. Written for a sub or a mode-on main chat
/// only: a mode-off chat never gets a log.
fn log_line(root: &Path, owner: &str, who: &str, sub: Option<&str>, id: &str, p: &NewPick) -> Vec<u32> {
    let mode_on = crate::sessions::chat_config::get(owner).is_some_and(|c| c.subchats_on);
    if !mode_on {
        return Vec::new();
    }
    let others: Vec<&str> = p.options.iter().filter(|o| **o != p.pick).map(String::as_str).collect();
    let body = format!(
        "Autopilot pick {id}, not reviewed by Joe yet: {} -> {} (not: {}). Why: {}",
        p.question,
        p.pick,
        others.join("; "),
        p.reason
    );
    let item = NewEntry { kind: Kind::Decided, who: who.to_string(), sub: sub.map(str::to_string), question: None, body };
    decisions::append_in(root, owner, &chrono::Local::now().format("%Y-%m-%d").to_string(), vec![item]).unwrap_or_default()
}

/// What Joe does with a pick.
#[derive(Debug, Clone, PartialEq)]
pub enum Review {
    Agree,
    /// What he wants instead.
    Overrule(String),
}

pub fn review(state: &DaemonState, owner: &str, id: &str, action: &Review) -> Result<Pick, String> {
    let Some(root) = decisions::data_root() else { return Err("the app data folder is not available".to_string()) };
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut picks = try_load_in(&root, owner)?;
    let Some(p) = picks.iter_mut().find(|p| p.id == id) else { return Err(format!("no pick {id} on this chat")) };
    match action {
        Review::Agree => {
            p.status = Status::Agreed;
            p.instead = None;
        }
        Review::Overrule(text) => {
            let instead = clip(text, REASON_CAP);
            if instead.is_empty() {
                return Err("say what you want instead".to_string());
            }
            p.status = Status::Overruled;
            p.instead = Some(instead.clone());
            let replaces = p.log_id.map(|d| format!("replaces D{d}: ")).unwrap_or_default();
            let body = format!(
                "{replaces}Joe overruled autopilot pick {}: {} -> {} was not right. He wants: {instead}",
                p.id, p.question, p.pick
            );
            let item = NewEntry { kind: Kind::Decided, who: "Joe".to_string(), sub: None, question: None, body };
            let ids = decisions::append_in(&root, owner, &chrono::Local::now().format("%Y-%m-%d").to_string(), vec![item]).unwrap_or_default();
            p.log_id = ids.first().copied().or(p.log_id);
        }
    }
    let out = p.clone();
    save_in(&root, owner, &picks).map_err(|e| format!("could not save the review: {e}"))?;
    drop(_g);
    announce(state, owner, &root);
    Ok(out)
}

/// A chat reports the overruled pick changed in the code. Allowed for any chat of
/// the owner's family (the correcting chat is usually not the one that picked),
/// and only for an overruled pick: an agreed one needs no change.
pub fn mark_corrected(state: &DaemonState, session_id: &str, id: &str, note: &str) -> Result<Pick, String> {
    if state.registry.get(session_id).is_none() {
        return Err(UNKNOWN_CHAT.to_string());
    }
    let owner = owner_of(state, session_id);
    let Some(root) = decisions::data_root() else { return Err("the app data folder is not available".to_string()) };
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut picks = try_load_in(&root, &owner)?;
    let Some(p) = picks.iter_mut().find(|p| p.id == id) else { return Err(format!("no pick {id} on this chat's run")) };
    if p.status != Status::Overruled {
        return Err(format!("pick {id} is not overruled, so there is nothing to mark corrected"));
    }
    p.status = Status::Corrected;
    p.corrected_note = Some(clip(note, NOTE_CAP)).filter(|n| !n.is_empty());
    let out = p.clone();
    save_in(&root, &owner, &picks).map_err(|e| format!("could not save: {e}"))?;
    drop(_g);
    announce(state, &owner, &root);
    Ok(out)
}

/// Tells open dashboards a list changed. Carries the owner and the unreviewed
/// count only, never a pick's text.
fn announce(state: &DaemonState, owner: &str, root: &Path) {
    let unreviewed = load_in(root, owner).iter().filter(|p| p.status == Status::Unreviewed).count();
    state.notifier.publish("autopilot_picks_changed", serde_json::json!({"session_id": owner, "unreviewed": unreviewed}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn input() -> NewPick {
        NewPick {
            question: "Which header colour?".into(),
            options: vec!["Teal".into(), "Navy".into()],
            pick: "teal".into(),
            reason: "matches the logo".into(),
            landed: "src/header.css".into(),
        }
    }

    fn chat(s: &DaemonState, id: &str) {
        s.registry.upsert_interactive(id, Path::new("."), "proj", "2026-11-15T08:00:00+00:00");
    }

    #[test]
    fn an_attended_chat_is_refused_and_nothing_is_stored() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "att-main");
        assert_eq!(record(&s, "att-main", &input()).unwrap_err(), ATTENDED_REFUSAL);
        assert!(list_in(&decisions::data_root().unwrap(), "att-main").is_empty());
    }

    #[test]
    fn a_chat_on_autopilot_records_and_a_sub_of_one_does_too() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "ap-main");
        chat(&s, "ap-sub");
        s.registry.set_autopilot("ap-main", true);
        s.registry.set_subchat_of("ap-sub", Some("ap-main".to_string()));

        let main_pick = record(&s, "ap-main", &input()).unwrap();
        assert_eq!(main_pick.id, "P1");
        assert_eq!(main_pick.pick, "Teal", "the pick is stored as the option is spelled");
        assert_eq!(main_pick.who, "main chat");

        // The sub is not on autopilot itself, its main chat is: unattended.
        let mut other = input();
        other.question = "Which footer?".into();
        let sub_pick = record(&s, "ap-sub", &other).unwrap();
        assert_eq!(sub_pick.id, "P2");
        assert_eq!(sub_pick.sub.as_deref(), Some("ap-sub"));
        let root = decisions::data_root().unwrap();
        assert_eq!(list_in(&root, "ap-main").len(), 2, "a sub's pick lands in its main chat's list");
        assert!(list_in(&root, "ap-sub").is_empty());
    }

    #[test]
    fn a_status_fact_or_a_bad_pick_is_refused_with_the_fix() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "v-main");
        s.registry.set_autopilot("v-main", true);
        let mut one = input();
        one.options = vec!["Teal".into()];
        assert!(record(&s, "v-main", &one).unwrap_err().contains("at least two"));
        let mut off = input();
        off.pick = "Green".into();
        assert!(record(&s, "v-main", &off).unwrap_err().contains("one of the options"));
        let mut no_reason = input();
        no_reason.reason = "  ".into();
        assert!(record(&s, "v-main", &no_reason).unwrap_err().contains("reason is missing"));
        let mut no_q = input();
        no_q.question = String::new();
        assert!(record(&s, "v-main", &no_q).unwrap_err().contains("question is missing"));
    }

    #[test]
    fn a_restated_pick_is_one_row() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "r-main");
        s.registry.set_autopilot("r-main", true);
        let a = record(&s, "r-main", &input()).unwrap();
        let b = record(&s, "r-main", &input()).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(list_in(&decisions::data_root().unwrap(), "r-main").len(), 1);
    }

    #[test]
    fn agree_overrule_and_correct_walk_the_status_and_the_decisions_log_follows() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "w-main");
        s.registry.set_autopilot("w-main", true);
        crate::sessions::chat_config::set_subchats_on("w-main", true);
        let p = record(&s, "w-main", &input()).unwrap();
        assert!(p.log_id.is_some(), "a mode-on main chat's pick also writes a decisions-log line");
        let log = decisions::read_log("w-main").unwrap();
        assert!(log.contains("Autopilot pick P1") && log.contains("Teal"), "{log}");

        assert_eq!(review(&s, "w-main", "P1", &Review::Agree).unwrap().status, Status::Agreed);

        let over = review(&s, "w-main", "P1", &Review::Overrule("Navy, the brand changed".into())).unwrap();
        assert_eq!(over.status, Status::Overruled);
        assert_eq!(over.instead.as_deref(), Some("Navy, the brand changed"));
        let entries = decisions::parse(&decisions::read_log("w-main").unwrap());
        let old = entries.iter().find(|e| e.body.contains("Autopilot pick P1")).unwrap();
        assert!(old.closed_by.is_some(), "the overrule closes the pick's own line");
        assert!(entries.iter().any(|e| e.is_live() && e.body.contains("overruled autopilot pick P1")));

        assert!(review(&s, "w-main", "P1", &Review::Overrule("  ".into())).is_err());
        assert!(review(&s, "w-main", "P9", &Review::Agree).unwrap_err().contains("no pick P9"));

        let done = mark_corrected(&s, "w-main", "P1", "commit abc1234, src/header.css").unwrap();
        assert_eq!(done.status, Status::Corrected);
        assert_eq!(done.corrected_note.as_deref(), Some("commit abc1234, src/header.css"));
    }

    #[test]
    fn only_an_overruled_pick_can_be_marked_corrected() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "c-main");
        s.registry.set_autopilot("c-main", true);
        record(&s, "c-main", &input()).unwrap();
        assert!(mark_corrected(&s, "c-main", "P1", "x").unwrap_err().contains("not overruled"));
    }

    #[test]
    fn an_unreadable_file_is_kept_as_bad_and_never_read_as_empty() {
        let _data = super::super::TempDataDir::new();
        let root = decisions::data_root().unwrap();
        let path = path_in(&root, "bad-main");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(list_in(&root, "bad-main").is_empty());
        assert!(path.with_extension("json.bad").exists(), "the broken bytes survive");
    }

    /// A read that fails for any reason but "not there" must not look like an
    /// empty list: the write that follows would replace what could not be read.
    #[test]
    fn a_failed_read_refuses_the_write_and_keeps_the_picks() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "io-main");
        s.registry.set_autopilot("io-main", true);
        record(&s, "io-main", &input()).unwrap();
        let root = decisions::data_root().unwrap();
        let path = path_in(&root, "io-main");
        let kept = std::fs::read_to_string(&path).unwrap();
        // A directory where the file is: reading it is an error that is not NotFound.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let mut other = input();
        other.question = "Which footer?".into();
        assert!(record(&s, "io-main", &other).unwrap_err().contains("could not read the picks file"));
        assert!(path.is_dir(), "nothing was written over it");
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, kept).unwrap();
        assert_eq!(list_in(&root, "io-main").len(), 1);
    }

    #[test]
    fn reviewed_picks_do_not_count_against_the_cap() {
        let _data = super::super::TempDataDir::new();
        let s = state();
        chat(&s, "cap-main");
        s.registry.set_autopilot("cap-main", true);
        let root = decisions::data_root().unwrap();
        let many: Vec<Pick> = (1..=MAX_PICKS)
            .map(|n| Pick { id: format!("P{n}"), question: format!("q{n}"), pick: "a".into(), status: Status::Agreed, ..Pick::default() })
            .collect();
        save_in(&root, "cap-main", &many).unwrap();
        assert_eq!(record(&s, "cap-main", &input()).unwrap().id, format!("P{}", MAX_PICKS + 1));
    }

    #[test]
    fn a_future_field_and_a_missing_one_both_read() {
        let _data = super::super::TempDataDir::new();
        let root = decisions::data_root().unwrap();
        let path = path_in(&root, "old-main");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"picks":[{"id":"P1","question":"q","pick":"a","new_field":1}]}"#).unwrap();
        let picks = list_in(&root, "old-main");
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].status, Status::Unreviewed);
        assert!(picks[0].options.is_empty());
    }
}
