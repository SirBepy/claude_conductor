//! What a visiting sub's host tells its home (`docs/cross-machine-subchats.md`,
//! "Wire", `sub_event`), and the host's side of sending it.
//!
//! The host runs the sub, so it alone knows when the sub finished, ended or could
//! not start. It sends the home small structured events through the outbox, which
//! keeps them across a gap in the link. The home builds every `is_meta` notice
//! itself from ids, fixed words and the sub's name (kept to plain characters), so
//! no byte the host or the sub wrote becomes an app-written message; the host's
//! text only ever reaches the home as card and tool data. Everything in an event
//! is untrusted on the home: [`clean_record`] and [`clean_facts`] clamp every field
//! before anything is stored or drawn.

use super::outbox;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::card_log::{CardDetail, RemoteCard, RemoteUpdate};
use crate::daemon::subchats::facts::Facts;
use crate::daemon::subchats::finish::FinishRecord;
use crate::util::text::flat_clip;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_VERDICT: usize = 80;
const MAX_TEXT: usize = 600;
const MAX_ROW: usize = 240;
const MAX_ROWS: usize = 8;
const MAX_FACT_TEXT: usize = 240;
const MAX_FILES_NAMED: usize = 6;
const MAX_NAME: usize = 120;
/// An answer card keeps the whole message, which a send caps well below this.
const MAX_CARD_TEXT: usize = 4_000;
const MAX_DETAILS: usize = 6;
const MAX_DETAIL_BODY: usize = 4_096;
const MAX_VISUALS: usize = 3;
/// A visual is a table or chart the chat parses; one past this is not a real one.
const MAX_VISUAL_BYTES: usize = 16 * 1024;
/// The wake detail is read through `subchat status` as tool data; this only bounds it.
const MAX_DETAIL: usize = 400;

/// One event a host reports about a visiting sub.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// The sub called `finish_subchat` and its turn ended: the record it wrote,
    /// the facts the host computed from its own git and the sub's transcript (the
    /// home cannot read either), and the model and effort it ran on.
    Finished {
        round: u32,
        record: FinishRecord,
        #[serde(default)]
        facts: Facts,
        #[serde(default)]
        model: String,
        #[serde(default)]
        effort: String,
    },
    /// The sub's chat ended on the host (closed there, or its process died for good).
    Ended,
    /// App plumbing on the host the main chat should hear about (`problem` is a
    /// `plumbing::Problem` word; the home accepts only the ones a host can raise).
    Wake {
        problem: String,
        #[serde(default)]
        detail: String,
    },
    /// A watcher on the host found something the main chat should hear about: a
    /// kind from a fixed list, never text. The home builds the line itself.
    Notice { notice: Notice },
    /// Joe picked "Open it" on a stall card of this sub, answered on the home but
    /// handled by the host's card code: the home's window opens the sub.
    OpenRequested,
    /// A `blocker`, `answer` or `rating` the sub sent with `send_message`: the card a
    /// local sub draws in its main chat, drawn on the home.
    Card { card: CardEvent },
    /// The sub revised (`update_message`) or retracted an `answer` or `rating` it sent this
    /// turn. The card is named by the number of the `Card` event that carried it
    /// (`card_log::remote_card_id`), never by an id; the home changes only a card of this sub
    /// that it drew, and an unknown number changes nothing.
    CardUpdate {
        card_seq: u64,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        details: Option<Vec<CardDetail>>,
        #[serde(default)]
        visuals: Option<Vec<serde_json::Value>>,
        #[serde(default)]
        retract: bool,
    },
    /// The problem the host's app drew a card about on the home is over (a landing went
    /// through, a held sub started, the tree was removed): the home takes down the app's own
    /// open blocker cards about this sub. A kind and nothing else, so no free text from the
    /// host reaches the home through it; the sub's own blockers stay.
    Retract,
    /// A kind this build does not know (a newer host's): the home notes its number and does
    /// nothing, instead of refusing the call, so one new kind never stalls the others behind it.
    #[serde(other)]
    Unknown,
}

/// What a visiting sub's `send_message` of kind `blocker`, `answer` or `rating` carries.
/// Every field is the sub's own text, so the home cuts each one ([`clean_card`]).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CardEvent {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub points: Vec<String>,
    #[serde(default)]
    pub details: Vec<CardDetail>,
    #[serde(default)]
    pub visuals: Vec<serde_json::Value>,
    #[serde(default)]
    pub question: Option<String>,
    /// A `blocker` the host's app drew about the sub (a tree it kept), not one the sub sent:
    /// the home stores it as the app's own, so a later `retract_blockers` may take it down.
    #[serde(default)]
    pub by_app: bool,
}

/// What a host's watchers say. Each is a kind and numbers; the words are the home's
/// (`card_watch::notice`, `ceiling::context_notice`), so no byte the host or the sub
/// wrote reaches a main chat as app-written text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "what", rename_all = "snake_case")]
pub enum Notice {
    /// The sub's stall card has gone unanswered (`card_watch`).
    CardUnanswered { cause: crate::daemon::subchats::card_watch::Cause, minutes: i64 },
    /// The sub passed a context band (`ceiling`).
    ContextBand { pct: u8 },
}

/// The `sub_event` call's parameters.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SubEvent {
    pub sub_id: String,
    /// Rises with every event the host queues about this sub; the home drops any
    /// number it has already seen, so a resent or replayed event does nothing.
    pub seq: u64,
    pub event: Event,
}

fn rows(rows: &[String], max_rows: usize, max: usize) -> Vec<String> {
    rows.iter().map(|r| flat_clip(r, max)).filter(|r| !r.is_empty()).take(max_rows).collect()
}

/// `record` as the home stores it. The ids come from the home's own record of the
/// sub (never from the event), the time is the home's, and every text field is cut
/// to what a real finish may carry, because the host is not trusted to have done
/// that. A reviewer's tool-use id is dropped: the home cannot check it.
pub fn clean_record(record: &FinishRecord, sub_id: &str, parent_id: &str) -> FinishRecord {
    FinishRecord {
        sub_id: sub_id.to_string(),
        parent_id: Some(parent_id.to_string()),
        round: record.round.max(1),
        verdict: flat_clip(&record.verdict, MAX_VERDICT),
        text: flat_clip(&record.text, MAX_TEXT),
        tone: record.tone.clone().filter(|t| matches!(t.as_str(), "good" | "bad" | "neutral")),
        points: rows(&record.points, 6, MAX_ROW),
        decided: rows(&record.decided, MAX_ROWS, MAX_ROW),
        ruled_out: rows(&record.ruled_out, MAX_ROWS, MAX_ROW),
        learned: rows(&record.learned, MAX_ROWS, MAX_ROW),
        done: rows(&record.done, MAX_ROWS, MAX_ROW),
        not_done: rows(&record.not_done, MAX_ROWS, MAX_ROW),
        waiting_on: rows(&record.waiting_on, MAX_ROWS, MAX_ROW),
        your_move: rows(&record.your_move, MAX_ROWS, MAX_ROW),
        reviewer_tool_use_id: None,
        git_head_at_finish: record.git_head_at_finish.clone().filter(|h| super::git_sync::is_commit_id(h)),
        finished_at: chrono::Utc::now().to_rfc3339(),
        question: record
            .question
            .as_deref()
            .map(|q| flat_clip(q, crate::daemon::subchats::QUESTION_MAX))
            .filter(|q| !q.is_empty()),
    }
}

/// `facts` as the home draws them: counts as sent, every string cut. `merged` and
/// `merged_into` are the home's to say (what landed is a fact about the home's
/// checkout), so the host's are discarded here.
pub fn clean_facts(facts: &Facts) -> Facts {
    let clip = |s: &Option<String>| s.as_deref().map(|s| flat_clip(s, MAX_FACT_TEXT)).filter(|s| !s.is_empty());
    let mut out = facts.clone();
    out.since = flat_clip(&facts.since, 40);
    out.commits_note = clip(&facts.commits_note);
    out.uncommitted_note = clip(&facts.uncommitted_note);
    out.uncommitted_files = rows(&facts.uncommitted_files, MAX_FILES_NAMED, MAX_FACT_TEXT);
    out.test.state = flat_clip(&facts.test.state, 20);
    out.test.command = clip(&facts.test.command);
    out.test.summary = clip(&facts.test.summary);
    out.reviewer.state = flat_clip(&facts.reviewer.state, 20);
    out.reviewer.text = clip(&facts.reviewer.text);
    out.reviewer.note = clip(&facts.reviewer.note);
    out.head = facts.head.clone().filter(|h| super::git_sync::is_commit_id(h));
    out.merged_into = None;
    out.merged = None;
    out
}

/// `card` as the home draws it: only the kinds that draw, every text cut, a detail id kept
/// to the plain shape the chat links by, visuals kept only as small objects. `None` for any
/// other kind.
pub fn clean_card(card: &CardEvent, seq: u64) -> Option<RemoteCard> {
    if !matches!(card.kind.as_str(), "blocker" | "answer" | "rating") {
        return None;
    }
    Some(RemoteCard {
        seq,
        kind: card.kind.clone(),
        text: clip_card_text(&card.text),
        verdict: flat_clip(&card.verdict, MAX_VERDICT),
        tone: card.tone.clone().filter(|t| matches!(t.as_str(), "good" | "bad" | "neutral")),
        points: rows(&card.points, 6, MAX_ROW),
        details: clean_details(&card.details),
        visuals: clean_visuals(&card.visuals),
        question: card.question.as_deref().map(|q| flat_clip(q, crate::daemon::subchats::QUESTION_MAX)).filter(|q| !q.is_empty()),
        // Only a blocker is ever the app's: an answer or a rating is the sub's word.
        by_app: card.by_app && card.kind == "blocker",
    })
}

fn clip_card_text(s: &str) -> String {
    s.trim().chars().take(MAX_CARD_TEXT).collect()
}

/// A card's details: an id kept to the plain shape the chat links by, each text cut.
fn clean_details(details: &[CardDetail]) -> Vec<CardDetail> {
    details
        .iter()
        .filter(|d| !d.id.is_empty() && d.id.len() <= 32 && d.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
        .take(MAX_DETAILS)
        .map(|d| CardDetail { id: d.id.clone(), label: flat_clip(&d.label, MAX_VERDICT), body_md: d.body_md.chars().take(MAX_DETAIL_BODY).collect() })
        .collect()
}

/// A card's visuals, kept only as small objects.
fn clean_visuals(visuals: &[serde_json::Value]) -> Vec<serde_json::Value> {
    visuals
        .iter()
        .filter(|v| v.is_object() && serde_json::to_string(v).is_ok_and(|s| s.len() <= MAX_VISUAL_BYTES))
        .take(MAX_VISUALS)
        .cloned()
        .collect()
}

/// A card revision as the home applies it: every text cut as the card it revises was. A text
/// that is blank after cutting is no revision of the text.
pub(crate) fn clean_update(
    text: Option<&str>,
    details: Option<&[CardDetail]>,
    visuals: Option<&[serde_json::Value]>,
    retract: bool,
) -> RemoteUpdate {
    RemoteUpdate {
        text: text.map(clip_card_text).filter(|t| !t.is_empty() && !retract),
        details: details.map(clean_details),
        visuals: visuals.map(clean_visuals),
        retract,
    }
}

/// A name for notices and cards: plain characters only, cut short.
pub fn clean_name(name: &str) -> String {
    flat_clip(name, MAX_NAME)
}

/// A wake's detail as `subchat status` shows it.
pub fn clean_detail(detail: &str) -> String {
    flat_clip(detail, MAX_DETAIL)
}

// ---- the host's side ------------------------------------------------------

/// The home a visiting sub reports to: the machine its brief names, never a
/// payload. `None` for a sub that is not visiting.
pub fn home_of(sub_id: &str) -> Option<crate::daemon::subchats::HomeRef> {
    crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat).and_then(|b| b.home)
}

/// Queues `event` about `sub_id` for its home and starts delivering. `false` when
/// the sub is not visiting or the entry could not be written.
pub fn queue(state: &Arc<DaemonState>, sub_id: &str, event: &Event) -> bool {
    queue_seq(state, sub_id, event).is_some()
}

/// [`queue`], giving the number the event went out under.
pub fn queue_seq(state: &Arc<DaemonState>, sub_id: &str, event: &Event) -> Option<u64> {
    let home = home_of(sub_id)?;
    let value = serde_json::to_value(event).ok()?;
    match outbox::enqueue_event(&home.machine_id, sub_id, value) {
        Ok(seq) => {
            log::debug!("subchats: queued {} event {seq} about visiting sub {sub_id} for {}", kind_of(event), home.machine_id);
            outbox::flush_in_background(state);
            Some(seq)
        }
        Err(e) => {
            log::warn!("subchats: could not queue an event about visiting sub {sub_id}: {e}");
            None
        }
    }
}

fn kind_of(event: &Event) -> &'static str {
    match event {
        Event::Finished { .. } => "finished",
        Event::Ended => "ended",
        Event::Wake { .. } => "wake",
        Event::Notice { .. } => "notice",
        Event::OpenRequested => "open_requested",
        Event::Card { .. } => "card",
        Event::CardUpdate { .. } => "card_update",
        Event::Retract => "retract",
        Event::Unknown => "unknown",
    }
}

/// The `finished` event for a visiting sub's latest finish record: the record, and
/// the facts read from this machine's git and the sub's transcript. Blocking (git).
/// `None` when no record was stored.
pub(crate) fn finished_event(state: &Arc<DaemonState>, sub_id: &str, transcript: Option<std::path::PathBuf>) -> Option<Event> {
    let record = crate::daemon::subchats::finish::read_record(sub_id)?;
    let inst = state.registry.get(sub_id)?;
    let check = crate::daemon::subchats::project::check_mode(state, &inst.cwd);
    // No card log lives on this machine for a visiting sub, so the base is the one
    // its tree started from.
    let facts = crate::daemon::subchats::card_log::sub_facts(&inst, check, record.reviewer_tool_use_id.as_deref(), &[], transcript.as_deref());
    Some(Event::Finished { round: record.round, record, facts, model: inst.model.clone(), effort: inst.effort.clone() })
}

/// A visiting sub finished: computes the facts off the caller's thread (git can be
/// slow, and this runs inside the pump's result handler) and queues the event.
pub fn on_finished(state: &Arc<DaemonState>, sub_id: &str) {
    let (state, id) = (state.clone(), sub_id.to_string());
    let run = move || {
        let transcript = crate::context_status::resolve_transcript(&state.registry, &id);
        match finished_event(&state, &id, transcript) {
            Some(event) => {
                queue(&state, &id, &event);
            }
            None => log::warn!("subchats: visiting sub {id} finished but its record could not be read; its home was not told"),
        }
    };
    // `flush_in_background` needs the runtime of the calling thread, so it is handed
    // over: a plain thread has none of its own.
    let handle = tokio::runtime::Handle::try_current().ok();
    let spawned = std::thread::Builder::new().name("subchat-event".into()).spawn(move || {
        let _enter = handle.as_ref().map(|h| h.enter());
        run();
    });
    if let Err(e) = spawned {
        log::warn!("subchats: could not start the event thread for {sub_id}: {e}");
    }
}

/// A visiting sub's chat ended.
pub fn on_ended(state: &Arc<DaemonState>, sub_id: &str) {
    queue(state, sub_id, &Event::Ended);
}

/// A watcher's finding about a visiting sub, for the main chat on its home.
pub fn queue_notice(state: &Arc<DaemonState>, sub_id: &str, notice: Notice) -> bool {
    queue(state, sub_id, &Event::Notice { notice })
}

/// Joe asked on the home to open a visiting sub from its stall card.
pub fn queue_open_requested(state: &Arc<DaemonState>, sub_id: &str) -> bool {
    queue(state, sub_id, &Event::OpenRequested)
}

/// A card a visiting sub's `send_message` drew, for the main chat on its home.
pub fn queue_card(state: &Arc<DaemonState>, sub_id: &str, card: CardEvent) -> bool {
    queue_card_seq(state, sub_id, card).is_some()
}

/// [`queue_card`], giving the number the card went out under, which names it on the home.
pub fn queue_card_seq(state: &Arc<DaemonState>, sub_id: &str, card: CardEvent) -> Option<u64> {
    queue_seq(state, sub_id, &Event::Card { card })
}

/// The problem the host's app told the home about a visiting sub is over: the home takes its
/// own blocker cards about the sub down.
pub fn queue_retract(state: &Arc<DaemonState>, sub_id: &str) -> bool {
    queue(state, sub_id, &Event::Retract)
}

/// App plumbing about a visiting sub the main chat on its home should hear about.
pub fn queue_wake(state: &Arc<DaemonState>, sub_id: &str, problem: &str, detail: &str) -> bool {
    queue(state, sub_id, &Event::Wake { problem: problem.to_string(), detail: clean_detail(detail) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long(n: usize) -> String {
        "x".repeat(n)
    }

    fn big_record() -> FinishRecord {
        FinishRecord {
            sub_id: "someone-else".into(),
            parent_id: Some("a-chat-that-is-not-its-main".into()),
            round: 0,
            verdict: long(500),
            text: long(5000),
            tone: Some("<script>".into()),
            points: (0..40).map(|_| long(900)).collect(),
            decided: (0..40).map(|_| long(900)).collect(),
            ruled_out: vec!["  ".into(), "kept".into()],
            reviewer_tool_use_id: Some("toolu_forged".into()),
            git_head_at_finish: Some("not a commit".into()),
            finished_at: "1999-01-01T00:00:00Z".into(),
            question: Some(long(5000)),
            ..FinishRecord::default()
        }
    }

    #[test]
    fn a_hosts_record_takes_its_ids_from_the_home_and_every_field_is_cut_to_a_real_finishs_size() {
        let c = clean_record(&big_record(), "real-sub", "real-main");
        assert_eq!((c.sub_id.as_str(), c.parent_id.as_deref()), ("real-sub", Some("real-main")), "the event names neither");
        assert_eq!(c.round, 1, "a round is at least the first");
        assert!(c.verdict.chars().count() <= MAX_VERDICT && c.text.chars().count() <= MAX_TEXT);
        assert_eq!(c.tone, None, "only the three tones are drawn");
        assert_eq!(c.points.len(), 6);
        assert_eq!(c.decided.len(), MAX_ROWS);
        assert!(c.decided.iter().all(|r| r.chars().count() <= MAX_ROW));
        assert_eq!(c.ruled_out, ["kept"], "a blank row is dropped");
        assert_eq!(c.reviewer_tool_use_id, None);
        assert_eq!(c.git_head_at_finish, None, "a head that is not a commit id is not kept");
        assert_ne!(c.finished_at, "1999-01-01T00:00:00Z", "the time is the home's");
        assert!(c.question.unwrap().chars().count() <= crate::daemon::subchats::QUESTION_MAX);
    }

    #[test]
    fn facts_from_a_host_are_cut_and_never_say_what_landed_on_the_home() {
        let mut f = Facts { merged: Some(true), merged_into: Some("main".into()), commits: Some(3), ..Facts::default() };
        f.commits_note = Some(long(5000));
        f.uncommitted_files = (0..30).map(|_| long(900)).collect();
        f.test.summary = Some(long(5000));
        f.head = Some("zzz".into());
        let c = clean_facts(&f);
        assert_eq!((c.merged, c.merged_into), (None, None), "the home reads its own checkout");
        assert_eq!(c.commits, Some(3));
        assert!(c.commits_note.unwrap().chars().count() <= MAX_FACT_TEXT);
        assert_eq!(c.uncommitted_files.len(), MAX_FILES_NAMED);
        assert!(c.test.summary.unwrap().chars().count() <= MAX_FACT_TEXT);
        assert_eq!(c.head, None);
    }

    fn state() -> Arc<DaemonState> {
        DaemonState::new(
            crate::daemon::session::new_session_map(),
            crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
        )
    }

    fn queued(machine: &str) -> Vec<(String, u64, String)> {
        outbox::pending_for(machine)
            .into_iter()
            .map(|e| {
                assert_eq!(e.method, "sub_event");
                let p = &e.params;
                (p["sub_id"].as_str().unwrap().to_string(), p["seq"].as_u64().unwrap(), p["event"]["kind"].as_str().unwrap().to_string())
            })
            .collect()
    }

    #[test]
    fn a_visiting_subs_events_are_queued_for_its_home_in_order_and_a_local_subs_are_not() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-v", "home-main", "ev-pc");
        crate::daemon::subchats::store_sub_brief("ev-l", "main");
        assert!(queue(&st, "ev-v", &Event::Ended));
        assert!(queue_wake(&st, "ev-v", "could_not_start", "boom"));
        assert!(!queue(&st, "ev-l", &Event::Ended), "a local sub has no home to tell");
        assert!(outbox::pending_for("main").is_empty());
        let q = queued("ev-pc");
        assert_eq!(q.iter().map(|(s, _, k)| (s.as_str(), k.as_str())).collect::<Vec<_>>(), [("ev-v", "ended"), ("ev-v", "wake")]);
        assert!(q[1].1 > q[0].1, "numbers rise");
    }

    #[test]
    fn the_home_is_named_by_the_stored_brief_never_by_the_caller() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        assert_eq!(home_of("nobody"), None);
        crate::daemon::subchats::store_visiting_brief("ev-h", "home-main", "ev-pc2");
        assert_eq!(home_of("ev-h").unwrap().machine_id, "ev-pc2");
    }

    /// The app's plumbing about a visiting sub is the home's to hear: a wake queued here
    /// would name a main chat this machine does not have.
    #[test]
    fn plumbing_about_a_visiting_sub_goes_to_its_home_and_wakes_no_chat_here() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-p", "home-main", "ev-pc3");
        st.registry.upsert_interactive("ev-p", std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
        st.registry.set_subchat_of("ev-p", Some("home-main".into()));
        assert!(crate::daemon::subchats::plumbing::report(&st, "ev-p", crate::daemon::subchats::plumbing::Problem::CouldNotStart, "the bootstrap script failed".into(), vec![]));
        let waiting = outbox::pending_for("ev-pc3");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].params["event"]["kind"], "wake");
        assert_eq!(waiting[0].params["event"]["problem"], "could_not_start");
        assert_eq!(waiting[0].params["event"]["detail"], "the bootstrap script failed");
        assert!(st.repo_channel_wakes.lock().unwrap().is_empty(), "nothing is queued for a chat on this machine");
    }

    #[test]
    fn a_visiting_subs_chat_ending_tells_its_home() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-e", "home-main", "ev-pc4");
        crate::daemon::subchats::on_chat_ended(&st, "ev-e");
        assert_eq!(queued("ev-pc4").into_iter().map(|(_, _, k)| k).collect::<Vec<_>>(), ["ended"]);
        // A chat that is not a visiting sub tells nobody.
        crate::daemon::subchats::on_chat_ended(&st, "plain-chat");
        assert_eq!(outbox::pending_for("ev-pc4").len(), 1);
    }

    #[test]
    fn the_finished_event_carries_the_stored_record_and_facts_read_on_this_machine() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        let (_dir, repo) = crate::daemon::subchats::git::test_repo::init();
        st.registry.upsert_interactive("ev-f", &repo, "proj", "2026-11-15T00:00:00Z");
        crate::daemon::subchats::store_visiting_brief("ev-f", "home-main", "ev-pc5");
        let root = crate::settings::paths::data_dir().unwrap();
        let record = FinishRecord { sub_id: "ev-f".into(), round: 2, verdict: "Built".into(), decided: vec!["nothing".into()], ..FinishRecord::default() };
        crate::daemon::subchats::finish::write_record_in(&root, &record).unwrap();
        let Some(Event::Finished { round, record, facts, .. }) = finished_event(&st, "ev-f", None) else { panic!("no finished event") };
        assert_eq!((round, record.verdict.as_str()), (2, "Built"));
        assert_eq!((facts.merged_into, facts.merged), (None, None), "what landed on the home is the home's to say");
        assert!(finished_event(&st, "no-record", None).is_none());
    }

    /// A visiting sub's `blocker`, `answer` and `rating` would otherwise be written into a
    /// card log on this machine, under a main chat that lives on its home.
    #[test]
    fn a_visiting_subs_blocker_and_answer_go_to_its_home_not_to_a_card_log_here() {
        use crate::daemon::subchats::card_log::{on_answer, on_blocker, AnswerCard, BlockerCard};
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-c", "home-main", "ev-pc6");
        st.registry.upsert_interactive("ev-c", std::path::Path::new("."), "proj", "2026-11-16T00:00:00Z");
        st.registry.set_subchat_of("ev-c", Some("home-main".into()));
        let mut brief = crate::sessions::chat_config::get("ev-c").and_then(|c| c.subchat).unwrap();
        brief.question = Some("Which port?".into());
        crate::sessions::chat_config::set_subchat("ev-c", Some(brief));
        assert!(on_blocker(&st, "ev-c", BlockerCard { text: "need a key".into(), verdict: "Stuck".into(), ..Default::default() }).is_none());
        let answer = AnswerCard { kind: "rating".into(), text: "7/10".into(), verdict: "Fine".into(), ..Default::default() };
        assert!(on_answer(&st, "ev-c", answer).is_none(), "the home draws it");
        let sent: Vec<serde_json::Value> = outbox::pending_for("ev-pc6").into_iter().map(|e| e.params["event"].clone()).collect();
        assert_eq!(sent.len(), 2);
        assert_eq!((sent[0]["kind"].as_str(), sent[0]["card"]["kind"].as_str(), sent[0]["card"]["text"].as_str()), (Some("card"), Some("blocker"), Some("need a key")));
        assert_eq!(sent[0]["card"]["by_app"], false, "a sub's own blocker is its word, never the app's");
        assert_eq!((sent[1]["card"]["kind"].as_str(), sent[1]["card"]["question"].as_str()), (Some("rating"), Some("Which port?")), "the host's pending question rides along");
        assert!(crate::sessions::chat_config::get("ev-c").and_then(|c| c.subchat).unwrap().question.is_none(), "and is spent once queued");
        assert!(crate::daemon::subchats::card_log::read("home-main").is_empty(), "no card log is written on the host");
    }

    /// A "Worktree kept" card about a visiting sub's host tree goes to the home chat that
    /// shows it, never into a card log of a main chat that does not live on this machine.
    #[test]
    fn a_visiting_subs_kept_worktree_card_goes_to_its_home() {
        use crate::daemon::subchats::card_log::{on_app_blocker, BlockerCard};
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-k", "home-main", "ev-pc7");
        st.registry.upsert_interactive("ev-k", std::path::Path::new("."), "proj", "2026-11-16T00:00:00Z");
        st.registry.set_subchat_of("ev-k", Some("home-main".into()));
        let card = BlockerCard { text: "kept".into(), verdict: "Worktree kept".into(), tone: Some("bad".into()), points: Vec::new() };
        assert!(on_app_blocker(&st, "ev-k", None, card).is_none());
        let sent: Vec<serde_json::Value> = outbox::pending_for("ev-pc7").into_iter().map(|e| e.params["event"].clone()).collect();
        assert_eq!(sent.len(), 1);
        assert_eq!((sent[0]["card"]["kind"].as_str(), sent[0]["card"]["verdict"].as_str()), (Some("blocker"), Some("Worktree kept")));
        assert_eq!(sent[0]["card"]["by_app"], true, "the home must store the app's card as the app's, or it never retracts it");
        assert!(crate::daemon::subchats::card_log::read("home-main").is_empty(), "no card log is written on the host");
    }

    /// The host resolving a visiting sub's problem sends its home a retract (a kind, no text), so the
    /// "Worktree kept" card the home drew from the host's blocker does not linger; a sub that is not
    /// visiting queues nothing.
    #[test]
    fn a_visiting_subs_resolved_problem_sends_its_home_a_retract_and_a_local_sub_sends_nothing() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-r", "home-main", "ev-pc8");
        crate::daemon::subchats::plumbing::resolved(&st, "ev-r");
        crate::daemon::subchats::plumbing::resolved(&st, "ev-local");
        let sent: Vec<serde_json::Value> = outbox::pending_for("ev-pc8").into_iter().map(|e| e.params["event"].clone()).collect();
        assert_eq!(sent, [serde_json::json!({"kind": "retract"})], "a kind and nothing the host or the sub wrote");
        assert!(outbox::machines_waiting().iter().all(|m| m == "ev-pc8"), "nothing was queued for the local sub");
    }

    /// A card that cannot be queued for the home is reported to the caller instead of
    /// vanishing, and the question the host held for it is kept for a resend.
    #[test]
    fn a_visiting_subs_card_that_cannot_be_queued_is_reported_lost_and_keeps_its_question() {
        use crate::daemon::subchats::card_log::{send_answer, send_blocker, AnswerCard, BlockerCard, CardLost};
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        crate::daemon::subchats::store_visiting_brief("ev-lost", "home-main", "ev-pc8");
        st.registry.upsert_interactive("ev-lost", std::path::Path::new("."), "proj", "2026-11-18T00:00:00Z");
        st.registry.set_subchat_of("ev-lost", Some("home-main".into()));
        let mut brief = crate::sessions::chat_config::get("ev-lost").and_then(|c| c.subchat).unwrap();
        brief.question = Some("Which port?".into());
        crate::sessions::chat_config::set_subchat("ev-lost", Some(brief));
        let huge = "x".repeat(outbox::MAX_PARAMS_BYTES + 1);
        let blocker = BlockerCard { text: huge.clone(), verdict: "Stuck".into(), ..Default::default() };
        assert_eq!(send_blocker(&st, "ev-lost", blocker).unwrap_err(), CardLost);
        let answer = AnswerCard { kind: "answer".into(), text: huge, verdict: "Fine".into(), ..Default::default() };
        assert_eq!(send_answer(&st, "ev-lost", answer).unwrap_err(), CardLost);
        assert!(queued("ev-pc8").is_empty(), "nothing reached the outbox");
        assert_eq!(
            crate::sessions::chat_config::get("ev-lost").and_then(|c| c.subchat).unwrap().question.as_deref(),
            Some("Which port?"),
            "a lost card does not spend the question"
        );
        // A card that fits goes through the same entry points.
        let small = BlockerCard { text: "need a key".into(), verdict: "Stuck".into(), ..Default::default() };
        assert!(send_blocker(&st, "ev-lost", small).unwrap().is_none());
        assert_eq!(queued("ev-pc8").len(), 1);
    }

    #[test]
    fn a_card_from_a_host_is_cut_before_it_is_drawn() {
        let card = CardEvent {
            kind: "answer".into(),
            verdict: long(500),
            tone: Some("<b>".into()),
            text: long(9000),
            points: (0..20).map(|_| long(900)).collect(),
            details: (0..10).map(|i| CardDetail { id: format!("d{i}"), label: long(500), body_md: long(9000) }).collect(),
            visuals: (0..6).map(|_| serde_json::json!({"type": "bar"})).chain([serde_json::json!({"big": long(20_000)})]).collect(),
            question: Some(long(5000)),
            by_app: true,
        };
        let c = clean_card(&card, 7).unwrap();
        assert!(!c.by_app, "an answer is never the app's own card, whatever the host says");
        assert!(c.verdict.chars().count() <= MAX_VERDICT && c.text.chars().count() <= MAX_CARD_TEXT);
        assert_eq!(c.tone, None);
        assert_eq!((c.points.len(), c.details.len(), c.visuals.len()), (6, MAX_DETAILS, MAX_VISUALS));
        assert!(c.details.iter().all(|d| d.body_md.chars().count() <= MAX_DETAIL_BODY && d.label.chars().count() <= MAX_VERDICT));
        assert!(c.question.unwrap().chars().count() <= crate::daemon::subchats::QUESTION_MAX);
        let big = CardEvent { kind: "answer".into(), visuals: vec![serde_json::json!({"big": long(20_000)})], ..Default::default() };
        assert!(clean_card(&big, 7).unwrap().visuals.is_empty(), "a visual past the byte cap is not drawn");
        for kind in ["finish", "report", "all_finished", ""] {
            assert!(clean_card(&CardEvent { kind: kind.into(), ..Default::default() }, 7).is_none(), "{kind:?} draws no card from a host");
        }
    }

    #[test]
    fn an_event_round_trips_through_the_wire_shape_the_doc_names() {
        let e = Event::Wake { problem: "could_not_start".into(), detail: "bootstrap failed".into() };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "wake");
        assert_eq!(serde_json::from_value::<Event>(v).unwrap(), e);
        assert_eq!(serde_json::to_value(Event::Ended).unwrap()["kind"], "ended");
        assert_eq!(serde_json::to_value(Event::Retract).unwrap(), serde_json::json!({"kind": "retract"}));
        assert_eq!(serde_json::from_value::<Event>(serde_json::json!({"kind": "retract"})).unwrap(), Event::Retract);
    }

    /// A kind this build does not know decodes to `Unknown`, which the home only notes: it is
    /// never guessed at, and it never fails the whole call.
    #[test]
    fn a_kind_this_build_does_not_know_decodes_to_unknown_not_an_error() {
        let v = serde_json::json!({"sub_id": "s", "seq": 3, "event": {"kind": "merge_it_now", "extra": "x"}});
        assert_eq!(serde_json::from_value::<SubEvent>(v).unwrap().event, Event::Unknown);
    }
}
