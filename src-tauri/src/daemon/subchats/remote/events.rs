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
    let Some(home) = home_of(sub_id) else { return false };
    let Ok(value) = serde_json::to_value(event) else { return false };
    match outbox::enqueue_event(&home.machine_id, sub_id, value) {
        Ok(seq) => {
            log::debug!("subchats: queued {} event {seq} about visiting sub {sub_id} for {}", kind_of(event), home.machine_id);
            outbox::flush_in_background(state);
            true
        }
        Err(e) => {
            log::warn!("subchats: could not queue an event about visiting sub {sub_id}: {e}");
            false
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

    #[test]
    fn an_event_round_trips_through_the_wire_shape_the_doc_names() {
        let e = Event::Wake { problem: "could_not_start".into(), detail: "bootstrap failed".into() };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "wake");
        assert_eq!(serde_json::from_value::<Event>(v).unwrap(), e);
        assert_eq!(serde_json::to_value(Event::Ended).unwrap()["kind"], "ended");
        // A kind this build does not know is a decode error, so it is refused rather than guessed at.
        assert!(serde_json::from_value::<Event>(serde_json::json!({"kind": "merge_it_now"})).is_err());
    }
}
