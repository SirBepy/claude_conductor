//! `finish_subchat`: how a sub ends its job. Finished means idle and hidden:
//! the process stops, the row stays, and a follow-up wakes it with its context
//! (spec section 9). It is `finalize_close` without `mark_ended`, plus the
//! activity checks that one lacks.
//!
//! Two halves, because the tool call lands mid-turn:
//! - [`request_finish`] runs at the call. It refuses (naming the fix) while the
//!   sub has its own uncommitted edits, a question card open or no reviewer, and
//!   otherwise parks the request in [`super::runtime`]. Background work is judged
//!   at the commit, never refused here (the verdict at the call is a turn old).
//! - [`commit_finish`] runs at turn end, from the pump's result handler or its
//!   EOF handler. It re-checks background work against the fresh Stop-hook
//!   verdict, stores the [`FinishRecord`], stops the process and fires
//!   [`super::on_finished`].

use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use crate::sessions::registry_turn::TurnActivity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_DECISION_ROWS: usize = 8;
const MAX_DECISION_ROW: usize = 200;
/// How many file names a refusal lists before it says "and N more".
const MAX_NAMED_FILES: usize = 8;

/// Everything a sub said when it finished, kept per sub under
/// `<data_dir>/subchats/<sub_id>.finish.json`. Steps that draw the verdict card,
/// feed the one line back and write the decisions log all read this one record.
/// Every field is `#[serde(default)]` so a record written by an older build
/// still loads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct FinishRecord {
    #[serde(default)]
    pub sub_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 1 for the first finish, then one more each time a continued sub finishes
    /// again, so a reader can tell a new verdict from one it already drew.
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub points: Vec<String>,
    /// Decisions the sub made that are worth keeping. `["nothing"]` is a valid answer.
    #[serde(default)]
    pub decided: Vec<String>,
    /// Things the sub tried or weighed and dropped. `["nothing"]` is a valid answer.
    #[serde(default)]
    pub ruled_out: Vec<String>,
    /// What the job taught that stays true after it, each row naming where it was
    /// saved (a memory file or a todo id). `["nothing"]` is a valid answer. Not
    /// copied to the decisions log or the digest: the fact lives in what the row names.
    #[serde(default)]
    pub learned: Vec<String>,
    #[serde(default)]
    pub done: Vec<String>,
    #[serde(default)]
    pub not_done: Vec<String>,
    #[serde(default)]
    pub waiting_on: Vec<String>,
    #[serde(default)]
    pub your_move: Vec<String>,
    /// The `tool_use` id of the reviewer subagent run, only when the sub passed
    /// one. Normally `None`: a model cannot see tool_use ids, so the daemon finds
    /// the reviewer in the transcript itself.
    #[serde(default)]
    pub reviewer_tool_use_id: Option<String>,
    /// `HEAD` of the sub's repo when it finished. The head at spawn is recorded
    /// by the spawn path, so commits-since-spawn is the pair.
    #[serde(default)]
    pub git_head_at_finish: Option<String>,
    #[serde(default)]
    pub finished_at: String,
    /// The question of Joe's this round answers, taken off the brief when the
    /// finish was committed. Its card is then drawn as an answer.
    #[serde(default)]
    pub question: Option<String>,
}

/// A `finish_subchat` call, decoded leniently and checked for the fields this
/// tool adds to a `report`. The report rows themselves are validated by the
/// route with `send_message`'s own limits.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FinishArgs {
    pub verdict: Option<String>,
    pub text: Option<String>,
    pub tone: Option<String>,
    pub points: Option<Vec<String>>,
    pub done: Option<Vec<String>>,
    pub not_done: Option<Vec<String>>,
    pub waiting_on: Option<Vec<String>>,
    pub your_move: Option<Vec<String>>,
    pub decided: Vec<String>,
    pub ruled_out: Vec<String>,
    pub learned: Vec<String>,
    pub reviewer_tool_use_id: Option<String>,
}

fn opt_string(body: &Value, key: &str) -> Result<Option<String>, String> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{key} must be a string: resend with {key} as plain text")),
    }
}

fn opt_rows(body: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| i.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .map(Some)
            .ok_or_else(|| format!("{key} must be a list of strings: resend with one short string per row")),
        Some(_) => Err(format!("{key} must be a list of strings: resend with one short string per row")),
    }
}

/// `decided` / `ruled_out` / `learned`: required, at least one row, and `["nothing"]` is how
/// to say there is nothing. Forced writes can fill with junk, so an empty list
/// is refused rather than guessed at.
fn required_rows(body: &Value, key: &str) -> Result<Vec<String>, String> {
    let rows = opt_rows(body, key)?.unwrap_or_default();
    let rows: Vec<String> = rows.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
    if rows.is_empty() {
        return Err(format!(
            "{key} is required: list each one as a short row, or [\"nothing\"] when there is nothing worth keeping"
        ));
    }
    if rows.len() > MAX_DECISION_ROWS {
        return Err(format!("{key} has {} rows, over {MAX_DECISION_ROWS}: keep the most important", rows.len()));
    }
    if let Some(long) = rows.iter().find(|r| r.chars().count() > MAX_DECISION_ROW) {
        return Err(format!(
            "a {key} row is {} chars, over {MAX_DECISION_ROW}: shorten it",
            long.chars().count()
        ));
    }
    Ok(rows)
}

/// Every field and its limit on one line, for a sub that called the tool with
/// the wrong shape (the tool is deferred, so a sub often calls it before its
/// schema is loaded). Mirrors the schema in `mcp::tool_schemas_subchat` and the
/// caps in `hooks_server::messages`.
pub const FIELD_LIMITS: &str = "Fields: verdict (required, at most 40 chars, the conclusion as a person says it), text (required, at most 200 chars, one or two lines for Joe), decided, ruled_out and learned (required lists, at most 8 rows of 200 chars each, [\"nothing\"] is a valid answer; each learned row names the memory file or todo id where it was saved); optional: tone (good, bad or neutral), done, not_done, waiting_on, your_move (lists, at most 8 rows of 120 chars), points (at most 6 rows of 200 chars).";

/// The required fields a call left out, named together in one refusal so a sub
/// fixes them in one retry instead of meeting them one by one. A field present
/// with the wrong type is not missing: [`FinishArgs::parse`] names that fix.
pub fn missing_fields(body: &Value) -> Option<String> {
    let blank_text = |key: &str| match body.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(_) => false,
    };
    let empty_rows = |key: &str| match body.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::Array(items)) => items.iter().all(|i| i.as_str().is_some_and(|s| s.trim().is_empty())),
        Some(_) => false,
    };
    let mut missing: Vec<&str> = Vec::new();
    if blank_text("verdict") {
        missing.push("verdict");
    }
    // `message` is accepted as another name for `text` (see `FinishArgs::parse`).
    if blank_text("text") && blank_text("message") {
        missing.push("text");
    }
    for key in ["decided", "ruled_out", "learned"] {
        if empty_rows(key) {
            missing.push(key);
        }
    }
    (!missing.is_empty()).then(|| format!("finish_subchat is missing {}. Send them all in one call. {FIELD_LIMITS}", missing.join(", ")))
}

impl FinishArgs {
    /// Decodes the relay body. Every failure names the fix and none is a decode
    /// error, because a model reads the text as the tool result and retries.
    pub fn parse(body: &Value) -> Result<Self, String> {
        Ok(Self {
            verdict: opt_string(body, "verdict")?,
            text: opt_string(body, "text")?.or(opt_string(body, "message")?),
            tone: opt_string(body, "tone")?,
            points: opt_rows(body, "points")?,
            done: opt_rows(body, "done")?,
            not_done: opt_rows(body, "not_done")?,
            waiting_on: opt_rows(body, "waiting_on")?,
            your_move: opt_rows(body, "your_move")?,
            decided: required_rows(body, "decided")?,
            ruled_out: required_rows(body, "ruled_out")?,
            learned: required_rows(body, "learned")?,
            reviewer_tool_use_id: opt_string(body, "reviewer_tool_use_id")?
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        })
    }
}

fn record_dir(root: &Path) -> PathBuf {
    root.join("subchats")
}

/// `<root>/subchats/<sub_id>.finish.json`. `sub_id` is a session id the daemon
/// minted, validated at spawn; the guard keeps a hostile id from leaving the folder.
fn record_path(root: &Path, sub_id: &str) -> Option<PathBuf> {
    if sub_id.is_empty() || sub_id.contains(['/', '\\', '.']) {
        return None;
    }
    Some(record_dir(root).join(format!("{sub_id}.finish.json")))
}

/// Reads a sub's finish record from `root` (the data dir, or a tempdir in tests).
pub fn read_record_in(root: &Path, sub_id: &str) -> Option<FinishRecord> {
    let path = record_path(root, sub_id)?;
    let raw = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(record) => Some(record),
        Err(e) => {
            super::jsonfile::keep_bad_copy(&path, &raw, &e.to_string());
            None
        }
    }
}

/// A sub's latest finish record from the real data dir.
pub fn read_record(sub_id: &str) -> Option<FinishRecord> {
    read_record_in(&crate::settings::paths::data_dir().ok()?, sub_id)
}

pub(crate) fn write_record_in(root: &Path, record: &FinishRecord) -> std::io::Result<()> {
    let path = record_path(root, &record.sub_id)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad sub id"))?;
    std::fs::create_dir_all(record_dir(root))?;
    let body = serde_json::to_string(record).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(&path, &body)
}

/// True while the Stop hook's last verdict says this session still has work of
/// its own running: a build or subagent (`Working`), a poller
/// (`WaitingOnProcess`) or a scheduled wake (`WaitingOnSchedule`). Stopping the
/// process would kill the first two and strand the third. `Unknown` and `Idle`
/// are not evidence of anything running.
pub fn has_background_work(activity: TurnActivity) -> bool {
    matches!(
        activity,
        TurnActivity::Working | TurnActivity::WaitingOnProcess | TurnActivity::WaitingOnSchedule
    )
}

/// What a refused finish tells the sub about its missing review. Each text names
/// the fix. They all end the same way: a fix after the review needs the review
/// run again only when it is material (`facts::scan::TRIVIAL_EDIT_LINES`).
fn review_refusal(gap: &super::facts::ReviewGap, risky: &[String]) -> String {
    use super::facts::ReviewGap::*;
    let n = super::facts::TRIVIAL_EDIT_LINES;
    // A model cannot see a tool_use id, so none is asked for: the app finds the
    // subagent call itself, the last one whose review still stands.
    let what = match gap {
        NotNamed => "you changed files, and this project requires a fresh subagent to review your own diff after your last edit that is more than a small fix, but none ran after it.".to_string(),
        NotInTranscript => "reviewer_tool_use_id matches no tool call in your transcript. Leave it out: the app finds your reviewer itself.".to_string(),
        NotASubagent(tool) => format!("reviewer_tool_use_id names a {tool:?} call, which is not a subagent. Leave it out: the app finds your reviewer itself."),
        BeforeLastEdit => format!("your reviewer started before an edit that is more than a small fix (more than {n} changed lines after it, or code in a file it had not seen), so it did not see the code you are finishing with."),
        NoResult => "your reviewer has not returned a result (the subagent is still running in the background, was refused, failed, or returned nothing).".to_string(),
    };
    format!(
        "Your changes touch risky code ({}), which is the only kind that owes a per-sub reviewer: {what} Run a fresh subagent with the Agent tool on your diff, started after your last substantial edit, in the foreground (run_in_background false) so its result lands in your transcript: give it the diff or the paths you changed and ask it to find real problems, with no shared context. Wait for its result, fix what it finds, commit, then call finish_subchat again without reviewer_tool_use_id. If a hook refused the subagent call, do what the hook says and run it again. Run ONE reviewer for this round. A fix after the review needs the review run again only when it is material: documentation edits and fixes of up to {n} changed lines (old plus new text) in files the reviewer already saw leave the review standing, so finish without another reviewer after a fix that small. Do not tell the reviewer to approve, and do not resume an earlier subagent. If the job is purely visual, finish without a reviewer by asking the main chat to set review false in the brief.",
        list_files(risky)
    )
}

fn list_files(files: &[String]) -> String {
    let shown: Vec<&str> = files.iter().take(MAX_NAMED_FILES).map(String::as_str).collect();
    let more = files.len().saturating_sub(MAX_NAMED_FILES);
    if more > 0 {
        format!("{} and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

/// The verdict lowercased with apostrophes dropped ("isn't" -> "isnt"), for [`says`].
fn normalise(verdict: &str) -> String {
    verdict.to_lowercase().replace(['\'', '\u{2019}'], "")
}

fn words_of(normalised: &str) -> Vec<&str> {
    normalised.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect()
}

/// Whether `phrase` appears as whole words and is not negated: a negator right before it,
/// or one with only filler words between ("nothing was blocked", "no longer blocked"). A
/// negator further back belongs to another clause ("could not post, needs writes").
fn says(words: &[&str], phrase: &[&str]) -> bool {
    let negator = |w: &str| matches!(w, "not" | "no" | "nothing" | "never" | "non" | "isnt" | "wasnt" | "arent" | "without");
    let filler = |w: &str| matches!(w, "longer" | "was" | "is" | "been" | "being" | "are" | "were" | "be" | "currently" | "actually" | "really" | "yet");
    let negated = |i: usize| {
        for w in words[..i].iter().rev().take(2) {
            if negator(w) {
                return true;
            }
            if !filler(w) {
                break;
            }
        }
        false
    };
    words.windows(phrase.len()).enumerate().any(|(i, w)| w == phrase && !negated(i))
}

/// Whether a verdict says the job is not done: not posted, needs writes or blocked.
/// Read by the wake (`wake::on_finished`) and the repeat check ([`repeat_refusal`]).
/// Only the daemon's own matching is done on the sub's words; none of them is quoted
/// into `is_meta` text.
pub(crate) fn is_unmet_verdict(verdict: &str) -> bool {
    let v = normalise(verdict);
    if ["not posted", "unposted"].iter().any(|k| v.contains(k)) {
        return true;
    }
    let words = words_of(&v);
    ["needs writes", "need writes", "needs write", "blocked"].iter().any(|p| says(&words, &p.split(' ').collect::<Vec<_>>()))
}

/// Whether a verdict says the sub could only finish because it believes it is read-only.
fn is_needs_writes_verdict(verdict: &str) -> bool {
    let v = normalise(verdict);
    let words = words_of(&v);
    ["needs writes", "need writes", "needs write", "writes true"].iter().any(|p| says(&words, &p.split(' ').collect::<Vec<_>>()))
}

fn same_words(a: &str, b: &str) -> bool {
    a.split_whitespace().map(str::to_lowercase).eq(b.split_whitespace().map(str::to_lowercase))
}

/// The refusal text for a repeat finish.
pub const REPEAT_FINISH_REFUSAL: &str = "Your writes are on now. Do the job, or name the exact error: finish again with a verdict that says what failed and the error text you got, not that the job needs writes.";

/// `Some(refusal)` when a sub whose writes went from off to on since its last finish
/// finishes with a needs-writes verdict, or again with the unmet verdict it gave
/// before. Its old read-only line no longer applies, so repeating it only hides that
/// it never tried the job.
pub(crate) fn repeat_refusal(on_since_finish: bool, verdict: &str, previous: Option<&FinishRecord>) -> Option<String> {
    if !on_since_finish {
        return None;
    }
    let repeats_unmet = previous.is_some_and(|p| is_unmet_verdict(&p.verdict) && same_words(&p.verdict, verdict));
    (is_needs_writes_verdict(verdict) || repeats_unmet).then(|| REPEAT_FINISH_REFUSAL.to_string())
}

/// Runs at the `finish_subchat` call. `Ok` carries the text the sub reads back;
/// `Err` is the refusal, already naming the fix.
pub async fn request_finish(
    state: &Arc<DaemonState>,
    sub_id: &str,
    args: FinishArgs,
) -> Result<String, String> {
    let transcript = crate::context_status::resolve_transcript(&state.registry, sub_id);
    request_finish_with(state, sub_id, args, transcript).await
}

/// [`request_finish`] with the sub's transcript injected, so a test can point
/// it at a scratch file instead of `~/.claude/projects`.
pub(crate) async fn request_finish_with(
    state: &Arc<DaemonState>,
    sub_id: &str,
    args: FinishArgs,
    transcript: Option<PathBuf>,
) -> Result<String, String> {
    let inst = state.registry.get(sub_id).ok_or_else(|| format!("unknown session: {sub_id}"))?;
    if !super::is_sub(&inst) {
        return Err("finish_subchat is only for a sub; this chat is not one. Ask Joe on a card, or finish the job in the usual way.".to_string());
    }
    if inst.ended_at.is_some() {
        return Err("this sub has already been ended".to_string());
    }
    // No refusal for background work here. The verdict `turn_activity` holds is the LAST
    // Stop hook's, so a sub woken by its finished build or reviewer still read "working"
    // for the whole turn and was refused again on every call, each a full call at its
    // context. The finish is accepted instead, and the turn's own Stop hook reads fresh: work still running
    // then drops it (`commit_finish_at`, `hooks_server::stop`), nothing is killed, and
    // the CLI wakes the sub when the work ends.
    // A sub that finishes with its own question card still open leaves Joe a
    // card whose asker has declared itself done. `ask_user_question` can return
    // to the sub unconfirmed while the durable card stays queued for the main
    // chat, so this is reachable, and the right move is to end the turn and wait.
    if crate::daemon::lifecycle::has_open_prompt(state, sub_id).await {
        return Err("you have a question or permission card still open for Joe, and finishing now would leave it with nobody to answer. Do not call finish_subchat: end your turn and carry on when his answer arrives, then call finish_subchat.".to_string());
    }
    let cwd = inst.cwd.clone();
    let reviewer_id = args.reviewer_tool_use_id.clone();
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let review_required = super::project::review_required(super::project::check_mode(state, &inst.cwd), brief.as_ref());
    // A reviewer is owed only for a change on the risky list (`facts::risk`); every other
    // writing sub rests on its tests, its facts and the push gate's review of the range.
    let (own_dirty, gap, scope) = match transcript {
        Some(t) => tokio::task::spawn_blocking(move || {
            let dirty = super::git::own_uncommitted(&t, &cwd);
            let scope = if review_required { super::facts::review_scope(&t, &cwd) } else { Default::default() };
            let gap = if scope.risky.is_empty() { None } else { super::facts::review_gap(&t, reviewer_id.as_deref()) };
            (dirty, gap, scope)
        })
        .await
        .unwrap_or_default(),
        None => (Vec::new(), None, Default::default()),
    };
    if !own_dirty.is_empty() {
        return Err(format!(
            "you have uncommitted edits to your own files: {}. Commit them (by path, only these files, in the repo each one belongs to: a submodule is its own repo), then call finish_subchat again.",
            list_files(&own_dirty)
        ));
    }
    if let Some(gap) = gap {
        return Err(review_refusal(&gap, &scope.risky));
    }
    if let Some(b) = brief.as_ref() {
        let previous = crate::settings::paths::data_dir().ok().and_then(|r| read_record_in(&r, sub_id));
        if let Some(refusal) = repeat_refusal(b.writes_on_since_finish, args.verdict.as_deref().unwrap_or(""), previous.as_ref()) {
            return Err(refusal);
        }
    }
    let rows = |v: Option<Vec<String>>| v.unwrap_or_default();
    let record = FinishRecord {
        sub_id: sub_id.to_string(),
        parent_id: inst.subchat_of.clone(),
        verdict: args.verdict.unwrap_or_default().trim().to_string(),
        text: args.text.unwrap_or_default().trim().to_string(),
        tone: args.tone,
        points: rows(args.points),
        decided: args.decided,
        ruled_out: args.ruled_out,
        learned: args.learned,
        done: rows(args.done),
        not_done: rows(args.not_done),
        waiting_on: rows(args.waiting_on),
        your_move: rows(args.your_move),
        reviewer_tool_use_id: args.reviewer_tool_use_id,
        ..FinishRecord::default()
    };
    super::runtime::runtime().set_pending_finish(sub_id, record);
    let no_review = if review_required && scope.edited && scope.risky.is_empty() {
        NO_REVIEWER_NEEDED
    } else {
        ""
    };
    Ok(format!("{no_review}Finish accepted. End your turn now without calling more tools; the daemon stops this chat once the turn ends. If background work (a build, a subagent, a watcher) is still running when it ends, nothing is stopped and this finish is dropped: you are woken when that work ends, then call finish_subchat again. Work that never ends by itself (a dev server, a watcher) would leave you waiting forever: stop it before you call this tool."))
}

/// Said at the start of an accepted finish whose changes are all off the risky list,
/// so the sub (and its transcript) records that no reviewer was skipped by mistake.
const NO_REVIEWER_NEEDED: &str = "No reviewer needed: none of your changed files is on the risky list (daemon concurrency and lifecycle, security, data loss, merge or worktree, migration, Android tunnel), so your tests and the push gate's review of the range stand in for one. ";

/// Commits a pending finish at turn end. `session` is the live child to stop;
/// `None` at EOF, when it already exited. Returns whether the sub finished.
pub fn commit_finish(state: &Arc<DaemonState>, sub_id: &str, session: Option<&Arc<Session>>) -> bool {
    let transcript = crate::context_status::resolve_transcript(&state.registry, sub_id);
    commit_finish_at(None, state, sub_id, session, transcript)
}

/// Said to a sub whose finish was dropped at commit because it edited files after
/// calling `finish_subchat` (an Edit in the same assistant message as the call is
/// not seen by the check at the call). Constant, never built from anything the sub
/// wrote, so it is safe as `is_meta` text. The sub did call finish, so
/// [`super::NUDGE_TEXT`] ("you did not call it") would be false.
pub const FINISH_DROPPED_DIRTY_NUDGE: &str = "Your finish_subchat call was not accepted, because files you edited are uncommitted. Commit your own edits, by path and only your files, then call finish_subchat again.";

/// Said to a sub whose finish was dropped at commit because an edit landed after
/// its reviewer ran (an Edit later in the same assistant message as the call).
/// Constant, so it is safe as `is_meta` text.
pub const FINISH_DROPPED_REVIEW_NUDGE: &str = "Your finish_subchat call was not accepted, because you edited files after your reviewer ran. Run a fresh subagent on your final diff in the foreground, fix what it finds, commit, then call finish_subchat again.";

/// The registry snapshot write, to the real file, or under `root` in tests so a
/// test registry never overwrites the live one.
fn save_registry_snapshot(root: Option<&Path>, state: &DaemonState) {
    match root {
        None => crate::sessions::persistence::save_snapshot_default(&state.registry),
        Some(r) => {
            let Ok(live) = crate::settings::paths::interactive_sessions_file() else { return };
            let Some(name) = live.file_name() else { return };
            crate::sessions::persistence::save_snapshot(&state.registry, &r.join(name));
        }
    }
}

/// Marks the open steps of the sub's plan done where the sidebar and hover card read it, when
/// its finish commits (a finish accepted at the call but dropped at the Stop hook leaves the
/// sub working, so the plan must stay as it is). The transcript's own `write_plan` calls cannot
/// be edited, so the turn footer's checklist keeps what the sub last wrote. The caller
/// publishes the change.
fn close_open_plan_steps(state: &DaemonState, sub_id: &str) {
    let Some(plan) = state.registry.get(sub_id).and_then(|i| i.progress.plan) else { return };
    let closed: Vec<_> = plan
        .into_iter()
        .map(|mut s| {
            if s.status == "pending" || s.status == "active" {
                s.status = "done".to_string();
            }
            s
        })
        .collect();
    state.registry.set_plan(sub_id, Some(closed));
}

/// [`commit_finish`] with the data dir and the transcript injected, so tests
/// write to a tempdir and read a scratch transcript.
pub(crate) fn commit_finish_at(
    root: Option<&Path>,
    state: &Arc<DaemonState>,
    sub_id: &str,
    session: Option<&Arc<Session>>,
    transcript: Option<PathBuf>,
) -> bool {
    #[cfg(test)]
    commit_seam::note_thread(sub_id);
    let rt = super::runtime::runtime();
    let Some(mut record) = rt.take_pending_finish(sub_id) else { return false };
    let Some(inst) = state.registry.get(sub_id) else { return false };
    if inst.ended_at.is_some() {
        return false;
    }
    // The Stop hook just refreshed this verdict. Work started after the call
    // would die with the process, and the CLI wakes the sub when it ends, so
    // dropping the request here costs one more finish call and nothing else: the
    // woken turn's own end goes through the Stop sequence, which blocks a sub that
    // has not finished.
    if has_background_work(state.registry.turn_activity(sub_id)) {
        log::info!("subchats: {sub_id} finish dropped, background work is running; it will be woken when that ends");
        return false;
    }
    // The call's own check ran mid-turn, so an Edit later in the same assistant
    // message was not in the transcript yet. Look again now the turn is over; the
    // sub is nudged with the reason, because the Stop hook already let this turn
    // end and nothing else would tell it.
    let own_dirty = transcript.as_deref().map(|t| super::git::own_uncommitted(t, &inst.cwd)).unwrap_or_default();
    if !own_dirty.is_empty() {
        log::info!("subchats: {sub_id} finish dropped, uncommitted edits: {}", list_files(&own_dirty));
        rt.set_nudge_text(sub_id, FINISH_DROPPED_DIRTY_NUDGE);
        rt.set_nudge_due(sub_id);
        return false;
    }
    // The same for the reviewer: a commit after the call can leave no dirty file
    // and still sit after the review.
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let review_required = super::project::review_required(super::project::check_mode(state, &inst.cwd), brief.as_ref());
    let risky = review_required && transcript.as_deref().is_some_and(|t| !super::facts::review_scope(t, &inst.cwd).risky.is_empty());
    if risky {
        if let Some(gap) = transcript.as_deref().and_then(|t| super::facts::review_gap(t, record.reviewer_tool_use_id.as_deref())) {
            log::info!("subchats: {sub_id} finish dropped, review gap: {gap:?}");
            rt.set_nudge_text(sub_id, FINISH_DROPPED_REVIEW_NUDGE);
            rt.set_nudge_due(sub_id);
            return false;
        }
    }
    let owned_root = root.map(Path::to_path_buf).or_else(|| crate::settings::paths::data_dir().ok());
    let previous = owned_root.as_deref().and_then(|r| read_record_in(r, sub_id));
    // The call's own repeat check ran mid-turn, so a follow-up that turned writes on after
    // it went unjudged. Judge it now, and tell the sub, since the Stop hook already let
    // this turn end.
    if let Some(refusal) = brief.as_ref().and_then(|b| repeat_refusal(b.writes_on_since_finish, &record.verdict, previous.as_ref())) {
        log::info!("subchats: {sub_id} finish dropped, writes came on after the call and the verdict repeats");
        rt.set_nudge_text(sub_id, &refusal);
        rt.set_nudge_due(sub_id);
        return false;
    }
    record.round = previous.map_or(0, |p| p.round) + 1;
    record.git_head_at_finish = super::git::head(&inst.cwd);
    record.finished_at = chrono::Utc::now().to_rfc3339();
    // A question recorded when its follow-up was held mid-turn is not this
    // finish's to answer while that text is still undelivered: the sub never saw
    // it, and its answer comes in the round the held text starts.
    let question_still_held = brief.as_ref().and_then(|b| b.question.as_deref()).is_some_and(|q| super::followup::holds_question(sub_id, q));
    record.question = if question_still_held { None } else { brief.as_ref().and_then(|b| b.question.clone()) };
    if let Some(r) = owned_root.as_deref() {
        if let Err(e) = write_record_in(r, &record) {
            log::warn!("subchats: could not store {sub_id}'s finish record: {e}");
        }
    }
    // One question, one answer: a later round answers it again only when a
    // follow-up hands it a new one.
    // The flip is told about once: from here the sub has finished with writes on.
    // Read again: a follow-up may have changed the brief since the read above, and the
    // whole brief is written back.
    // Only what this finish saw is cleared: a question or a flip that landed after the first
    // read belongs to the next round.
    let fresh = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let asked = brief.as_ref().and_then(|b| b.question.clone());
    let flipped = brief.as_ref().is_some_and(|b| b.writes_on_since_finish);
    let answered = |b: &super::SubchatBrief| asked.is_some() && !question_still_held && b.question == asked;
    if let Some(mut b) = fresh.filter(|b| answered(b) || (flipped && b.writes_on_since_finish)) {
        if answered(&b) {
            b.question = None;
        }
        if flipped {
            b.writes_on_since_finish = false;
        }
        crate::sessions::chat_config::set_subchat(sub_id, Some(b));
    }
    close_open_plan_steps(state, sub_id);
    state.registry.set_subchat_finished(sub_id, true);
    // Saved now, not at exit: the daemon is killed, never shut down cleanly, so
    // the exit save never runs and the sub would come back unfinished.
    save_registry_snapshot(root, state);
    rt.reset(sub_id);
    if let Some(session) = session {
        // Set before the kill: Windows stamps exit code 1 on a terminated
        // process, which would otherwise report itself as a crash.
        session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::util::kill::kill_tree(session.pid);
    }
    crate::daemon::machines::publish_instances_changed(state);
    log::info!("subchats: {sub_id} finished (round {}), verdict {:?}", record.round, record.verdict);
    super::on_finished(state, sub_id);
    true
}

/// Which thread each sub's commit ran on, so a test can tell the pump's thread
/// from a blocking-pool one.
#[cfg(test)]
pub(crate) mod commit_seam {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::thread::ThreadId;

    static THREADS: Mutex<Option<HashMap<String, ThreadId>>> = Mutex::new(None);

    pub(super) fn note_thread(sub_id: &str) {
        THREADS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(sub_id.to_string(), std::thread::current().id());
    }

    pub(crate) fn thread_of(sub_id: &str) -> Option<ThreadId> {
        THREADS.lock().unwrap_or_else(|p| p.into_inner()).as_ref()?.get(sub_id).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A parent and a sub whose cwd is `cwd`. Ids carry the test name so the
    /// process-wide runtime table never mixes two tests up.
    fn make_sub(st: &DaemonState, tag: &str, cwd: &Path) -> String {
        let (parent, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(parent));
        sub
    }

    /// Transcript lines, one JSON object each, added after what is already there.
    fn append_lines(path: &Path, lines: &[Value]) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        for l in lines {
            writeln!(f, "\n{l}").unwrap();
        }
    }

    fn agent_use(id: &str, tool: &str) -> Value {
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": tool, "input": {}}]}})
    }

    fn tool_result(id: &str, is_error: bool, text: &str) -> Value {
        json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": text}]}})
    }

    /// Where the sub's own edit sits in a scratch repo: a risky path (`facts::risk`) or a plain one.
    const RISKY_FILE: &str = "src-tauri/src/daemon/subchats/a.rs";
    const PLAIN_FILE: &str = "src/views/header.ts";

    /// A scratch repo whose one committed file `rel` is the sub's own edit, with a
    /// transcript of that single Write. Nothing is uncommitted, so only the reviewer
    /// rule can refuse a finish.
    fn committed_edit_of(rel: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (dir, root) = super::super::git::test_repo::init();
        let file = root.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "x").unwrap();
        super::super::git::test_repo::git(&root, &["add", rel]);
        super::super::git::test_repo::git(&root, &["commit", "-q", "-m", "a"]);
        let tp = super::super::git::test_repo::transcript(dir.path(), &[("Write", &file)]);
        (dir, root, tp)
    }

    /// The edit is on the risky list, so a reviewer is owed.
    fn committed_edit() -> (tempfile::TempDir, PathBuf, PathBuf) {
        committed_edit_of(RISKY_FILE)
    }

    fn with_reviewer(id: Option<&str>) -> FinishArgs {
        FinishArgs { reviewer_tool_use_id: id.map(str::to_string), ..args() }
    }

    fn state_with_check(root: &Path, check: &str) -> Arc<DaemonState> {
        let mut settings = Settings::default();
        let raw = json!({"id": "pj", "path": root, "name": "p", "created_at": "2026-11-05T00:00:00Z", "subchat_check": check});
        settings.projects.push(serde_json::from_value(raw).unwrap());
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    #[tokio::test]
    async fn a_sub_that_changed_files_cannot_finish_without_a_reviewer() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        let st = state();
        let sub = make_sub(&st, "rv-none", &root);
        let e = request_finish_with(&st, &sub, args(), Some(tp)).await.unwrap_err();
        assert!(e.contains("fresh subagent") && e.contains("after your last edit") && e.contains("Agent"), "{e}");
        assert!(e.contains("foreground"), "the result must land in the transcript: {e}");
        // A model cannot see a tool_use id, so the refusal never asks for one.
        assert!(!e.contains("Copy the id") && !e.contains("with reviewer_tool_use_id set"), "{e}");
        assert!(e.contains("without reviewer_tool_use_id"), "{e}");
        assert!(!super::super::runtime::runtime().finish_pending(&sub), "a refusal parks nothing");
        assert!(!e.contains('\u{2014}'));
    }

    /// The daemon finds the reviewer: the last subagent call whose review still stands.
    #[tokio::test]
    async fn the_daemon_finds_the_reviewer_without_an_id() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        append_lines(&tp, &[agent_use("some-id-the-model-never-sees", "Agent"), tool_result("some-id-the-model-never-sees", false, "No problems.")]);
        let st = state();
        let sub = make_sub(&st, "rv-auto", &root);
        assert!(request_finish_with(&st, &sub, args(), Some(tp)).await.is_ok());
        assert!(super::super::runtime::runtime().finish_pending(&sub));
    }

    /// First real run: a read-only sub's only Edit was refused by the write guard, and
    /// the gate still said "you changed files" and ran the sub through a reviewer.
    #[tokio::test]
    async fn a_refused_edit_does_not_make_a_read_only_sub_owe_a_reviewer() {
        let _data = super::super::TempDataDir::new();
        let (dir, root) = super::super::git::test_repo::init();
        let tp = super::super::git::test_repo::fixture_transcript(
            dir.path(),
            super::super::git::test_repo::REFUSED_EDIT_FIXTURE,
            &root.join("index.html"),
            2,
            &[],
            false,
        );
        let st = state();
        let sub = make_sub(&st, "rv-refused", &root);
        let r = request_finish_with(&st, &sub, args(), Some(tp)).await;
        assert!(r.is_ok(), "{r:?}");
        assert!(super::super::runtime::runtime().finish_pending(&sub));
    }

    /// A fix of a line or two in a file the reviewer saw, made after the review, does
    /// not send the sub back for a second reviewer; a fix in a file it never saw does.
    #[tokio::test]
    async fn a_small_fix_after_the_review_is_accepted_but_a_fix_in_an_unseen_file_is_not() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        let file = root.join(RISKY_FILE);
        append_lines(&tp, &[agent_use("rev-small", "Agent"), tool_result("rev-small", false, "No problems.")]);
        let fix = |id: &str, path: &Path| {
            json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": "Edit", "input": {"file_path": path.to_string_lossy(), "old_string": "x", "new_string": "y"}}]}})
        };
        append_lines(&tp, &[fix("small", &file)]);
        let st = state();
        let sub = make_sub(&st, "rv-small", &root);
        assert!(request_finish_with(&st, &sub, args(), Some(tp.clone())).await.is_ok(), "a one-line fix leaves the review standing");
        let st = state();
        let sub = make_sub(&st, "rv-unseen", &root);
        append_lines(&tp, &[fix("unseen", &root.join("never-reviewed.txt"))]);
        let e = request_finish_with(&st, &sub, args(), Some(tp)).await.unwrap_err();
        assert!(e.contains("started before an edit that is more than a small fix"), "{e}");
        assert!(e.contains("Run ONE reviewer") && e.contains(&super::super::facts::TRIVIAL_EDIT_LINES.to_string()), "{e}");
    }

    #[tokio::test]
    async fn a_reviewer_that_ran_before_the_last_edit_does_not_count() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        append_lines(&tp, &[agent_use("rev-early", "Agent"), tool_result("rev-early", false, "fine")]);
        // An edit after the review, committed so only the review rule can refuse.
        let late = root.join("b.txt");
        std::fs::write(&late, "y").unwrap();
        super::super::git::test_repo::git(&root, &["add", "b.txt"]);
        super::super::git::test_repo::git(&root, &["commit", "-q", "-m", "b"]);
        append_lines(
            &tp,
            &[json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "e2", "name": "Write", "input": {"file_path": late.to_string_lossy()}}]}})],
        );
        let st = state();
        let sub = make_sub(&st, "rv-early", &root);
        let e = request_finish_with(&st, &sub, with_reviewer(Some("rev-early")), Some(tp)).await.unwrap_err();
        assert!(e.contains("started before an edit that is more than a small fix"), "{e}");
    }

    #[tokio::test]
    async fn a_reviewer_id_that_is_not_a_subagent_call_is_refused() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        append_lines(&tp, &[agent_use("a-read", "Read"), tool_result("a-read", false, "file text")]);
        let st = state();
        let sub = make_sub(&st, "rv-notagent", &root);
        let e = request_finish_with(&st, &sub, with_reviewer(Some("a-read")), Some(tp.clone())).await.unwrap_err();
        assert!(e.contains("not a subagent") && e.contains("Read"), "{e}");
        // An id that matches nothing at all.
        let e = request_finish_with(&st, &sub, with_reviewer(Some("ghost")), Some(tp)).await.unwrap_err();
        assert!(e.contains("matches no tool call"), "{e}");
    }

    #[tokio::test]
    async fn a_reviewer_with_no_result_or_an_error_result_does_not_count() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        append_lines(&tp, &[agent_use("rev-run", "Agent")]);
        let st = state();
        let sub = make_sub(&st, "rv-noresult", &root);
        let e = request_finish_with(&st, &sub, with_reviewer(Some("rev-run")), Some(tp.clone())).await.unwrap_err();
        assert!(e.contains("has not returned a result"), "{e}");
        append_lines(&tp, &[tool_result("rev-run", true, "agent crashed")]);
        let e = request_finish_with(&st, &sub, with_reviewer(Some("rev-run")), Some(tp)).await.unwrap_err();
        assert!(e.contains("has not returned a result"), "an error result is not a review: {e}");
    }

    #[tokio::test]
    async fn a_reviewer_after_the_last_edit_lets_the_finish_through_with_either_tool_name() {
        let _data = super::super::TempDataDir::new();
        for (tag, tool) in [("rv-agent", "Agent"), ("rv-task", "Task")] {
            let (_dir, root, tp) = committed_edit();
            append_lines(&tp, &[agent_use("rev", tool), tool_result("rev", false, "Found nothing wrong.")]);
            let st = state();
            let sub = make_sub(&st, tag, &root);
            assert!(request_finish_with(&st, &sub, with_reviewer(Some("rev")), Some(tp)).await.is_ok(), "{tool}");
            assert!(super::super::runtime::runtime().finish_pending(&sub));
        }
    }

    /// A plain UI or docs change finishes with no reviewer, and the text it reads back says so.
    #[tokio::test]
    async fn a_sub_that_changed_only_plain_files_finishes_without_a_reviewer_and_is_told_so() {
        let _data = super::super::TempDataDir::new();
        for (tag, rel) in [("rv-plain-ui", PLAIN_FILE), ("rv-plain-doc", "docs/architecture/notes.md"), ("rv-plain-rust", "src-tauri/src/voice/dictation.rs")] {
            let (_dir, root, tp) = committed_edit_of(rel);
            let st = state();
            let sub = make_sub(&st, tag, &root);
            let said = request_finish_with(&st, &sub, args(), Some(tp)).await.unwrap_or_else(|e| panic!("{rel}: {e}"));
            assert!(said.starts_with("No reviewer needed") && said.contains("Finish accepted"), "{rel}: {said}");
            assert!(super::super::runtime::runtime().finish_pending(&sub), "{rel}");
        }
    }

    /// One risky file in a set of plain ones is enough: the whole diff is reviewed, and the
    /// refusal names the risky file.
    #[tokio::test]
    async fn a_mixed_set_owes_a_reviewer_and_the_refusal_names_the_risky_file() {
        let _data = super::super::TempDataDir::new();
        let (dir, root, _tp) = committed_edit_of(PLAIN_FILE);
        let risky = root.join(RISKY_FILE);
        std::fs::create_dir_all(risky.parent().unwrap()).unwrap();
        std::fs::write(&risky, "x").unwrap();
        super::super::git::test_repo::git(&root, &["add", RISKY_FILE]);
        super::super::git::test_repo::git(&root, &["commit", "-q", "-m", "b"]);
        let tp = super::super::git::test_repo::transcript(dir.path(), &[("Write", &root.join(PLAIN_FILE)), ("Write", &risky)]);
        let st = state();
        let sub = make_sub(&st, "rv-mixed", &root);
        let e = request_finish_with(&st, &sub, args(), Some(tp)).await.unwrap_err();
        assert!(e.contains("fresh subagent") && e.contains(RISKY_FILE) && !e.contains(PLAIN_FILE), "{e}");
    }

    /// A plain sub that ran a reviewer anyway is accepted too, and a risky one with the
    /// same reviewer is accepted (the review still counts where it is owed).
    #[tokio::test]
    async fn a_plain_sub_with_a_reviewer_anyway_is_accepted() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit_of(PLAIN_FILE);
        append_lines(&tp, &[agent_use("rev-extra", "Agent"), tool_result("rev-extra", false, "fine")]);
        let st = state();
        let sub = make_sub(&st, "rv-plain-extra", &root);
        assert!(request_finish_with(&st, &sub, args(), Some(tp)).await.is_ok());
    }

    #[tokio::test]
    async fn a_gate_sub_finishes_without_a_reviewer_whatever_it_edited() {
        let _data = super::super::TempDataDir::new();
        let (_dir, root, tp) = committed_edit();
        let st = state();
        let sub = make_sub(&st, "rv-gate", &root);
        // A gate's brief says writes with no files, and a reviewer has nothing of its own to read.
        let brief: super::super::SubchatBrief =
            serde_json::from_str(r#"{"parent":"rv-gate-main","gate":true,"writes":true,"files":[]}"#).unwrap();
        crate::sessions::chat_config::set_subchat(&sub, Some(brief));
        assert!(request_finish_with(&st, &sub, args(), Some(tp)).await.is_ok());
    }

    #[tokio::test]
    async fn a_sub_that_changed_no_files_needs_no_reviewer() {
        let _data = super::super::TempDataDir::new();
        let (dir, root) = super::super::git::test_repo::init();
        let tp = super::super::git::test_repo::transcript(dir.path(), &[("Read", &root.join("base.txt"))]);
        let st = state();
        let sub = make_sub(&st, "rv-noedit", &root);
        assert!(request_finish_with(&st, &sub, args(), Some(tp)).await.is_ok());
    }

    #[tokio::test]
    async fn facts_only_and_review_false_each_waive_the_reviewer() {
        let _data = super::super::TempDataDir::new();
        // The project says "Facts only".
        let (_dir, root, tp) = committed_edit();
        let st = state_with_check(&root, "facts_only");
        let sub = make_sub(&st, "rv-factsonly", &root);
        assert!(request_finish_with(&st, &sub, args(), Some(tp)).await.is_ok(), "facts only");
        // The brief says review: false, in a project that asks for a reviewer.
        let (_dir2, root2, tp2) = committed_edit();
        let st2 = state_with_check(&root2, "facts_and_reviewer");
        let sub2 = make_sub(&st2, "rv-nobrief", &root2);
        let mut brief: super::super::SubchatBrief =
            serde_json::from_str(r#"{"parent":"rv-nobrief-main","review":false}"#).unwrap();
        crate::sessions::chat_config::set_subchat(&sub2, Some(brief.clone()));
        assert!(request_finish_with(&st2, &sub2, args(), Some(tp2.clone())).await.is_ok(), "review false");
        // With the brief back on, the same project asks again.
        brief.review = true;
        crate::sessions::chat_config::set_subchat(&sub2, Some(brief));
        super::super::runtime::runtime().reset(&sub2);
        assert!(request_finish_with(&st2, &sub2, args(), Some(tp2)).await.is_err());
    }

    fn args() -> FinishArgs {
        FinishArgs {
            verdict: Some("Built, not pushed".into()),
            text: Some("Header done".into()),
            decided: vec!["nothing".into()],
            ruled_out: vec!["nothing".into()],
            learned: vec!["nothing".into()],
            ..FinishArgs::default()
        }
    }

    #[test]
    fn parse_requires_decided_and_ruled_out_and_names_the_fix() {
        let e = FinishArgs::parse(&json!({"verdict": "v", "text": "t"})).unwrap_err();
        assert!(e.contains("decided is required") && e.contains("[\"nothing\"]"), "{e}");
        let e = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": [], "learned": ["nothing"]})).unwrap_err();
        assert!(e.contains("ruled_out is required"), "{e}");
        let ok = FinishArgs::parse(&json!({"decided": ["nothing"], "ruled_out": ["nothing"], "learned": ["nothing"]})).unwrap();
        assert_eq!(ok.decided, ["nothing"]);
    }

    #[test]
    fn parse_requires_learned_and_accepts_nothing_and_enforces_the_row_limits() {
        let base = json!({"decided": ["a"], "ruled_out": ["b"]});
        let e = FinishArgs::parse(&base).unwrap_err();
        assert!(e.contains("learned is required") && e.contains("[\"nothing\"]"), "{e}");
        let mut body = base.clone();
        body["learned"] = json!([]);
        assert!(FinishArgs::parse(&body).unwrap_err().contains("learned is required"));
        body["learned"] = json!(["nothing"]);
        assert_eq!(FinishArgs::parse(&body).unwrap().learned, ["nothing"]);
        body["learned"] = json!(["Rule saved to feedback_x.md", "todo pc-0007 filed"]);
        assert_eq!(FinishArgs::parse(&body).unwrap().learned.len(), 2);
        body["learned"] = json!(["x".repeat(201)]);
        assert!(FinishArgs::parse(&body).unwrap_err().contains("a learned row is 201 chars, over 200"));
        body["learned"] = json!(["x".repeat(200)]);
        assert!(FinishArgs::parse(&body).is_ok(), "200 chars is the limit, not over it");
        body["learned"] = json!(vec!["x"; 9]);
        assert!(FinishArgs::parse(&body).unwrap_err().contains("learned has 9 rows, over 8"));
        body["learned"] = json!(vec!["x"; 8]);
        assert!(FinishArgs::parse(&body).is_ok());
    }

    #[test]
    fn missing_fields_names_learned_among_the_fields_a_call_left_out() {
        let e = missing_fields(&json!({})).unwrap();
        assert!(e.contains("learned") && e.contains("decided, ruled_out, learned"), "{e}");
        assert!(missing_fields(&json!({"verdict": "v", "text": "t", "decided": ["a"], "ruled_out": ["b"]})).unwrap().contains("missing learned."));
        assert!(missing_fields(&json!({"verdict": "v", "text": "t", "decided": ["a"], "ruled_out": ["b"], "learned": ["nothing"]})).is_none());
    }

    #[test]
    fn a_finish_record_written_before_learned_existed_loads_with_an_empty_list() {
        let old = r#"{"sub_id":"s1","verdict":"Built","text":"t","decided":["a"],"ruled_out":["nothing"]}"#;
        let record: FinishRecord = serde_json::from_str(old).unwrap();
        assert!(record.learned.is_empty());
        assert_eq!(record.decided, ["a"]);
    }

    #[test]
    fn parse_names_the_fix_for_a_wrong_shape_instead_of_failing_to_decode() {
        let e = FinishArgs::parse(&json!({"decided": "just text", "ruled_out": ["nothing"]})).unwrap_err();
        assert!(e.contains("decided must be a list of strings"), "{e}");
        let e = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "learned": ["c"], "done": [1]})).unwrap_err();
        assert!(e.contains("done must be a list of strings"), "{e}");
        let e = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "learned": ["c"], "verdict": 3})).unwrap_err();
        assert!(e.contains("verdict must be a string"), "{e}");
    }

    #[test]
    fn parse_keeps_the_reviewer_id_and_drops_a_blank_one() {
        let a = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "learned": ["c"], "reviewer_tool_use_id": " toolu_1 "})).unwrap();
        assert_eq!(a.reviewer_tool_use_id.as_deref(), Some("toolu_1"));
        let b = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "learned": ["c"], "reviewer_tool_use_id": "  "})).unwrap();
        assert_eq!(b.reviewer_tool_use_id, None);
    }

    #[test]
    fn record_path_refuses_an_id_that_could_leave_the_folder() {
        let root = Path::new("/data");
        assert!(record_path(root, "../x").is_none());
        assert!(record_path(root, "a/b").is_none());
        assert!(record_path(root, "").is_none());
        assert!(record_path(root, "0a1b-2c").is_some());
    }

    #[tokio::test]
    async fn a_chat_that_is_not_a_sub_cannot_finish() {
        let st = state();
        st.registry.upsert_interactive("plain-1", Path::new("."), "proj", "2026-11-05T00:00:00Z");
        let e = request_finish(&st, "plain-1", args()).await.unwrap_err();
        assert!(e.contains("only for a sub"), "{e}");
    }

    /// The verdict at the call is the last Stop hook's, a turn old: a sub woken by its
    /// finished build still read "working" and was refused on every retry. The call is
    /// accepted and parked; the commit at turn end reads the fresh verdict and decides.
    #[tokio::test]
    async fn finish_is_accepted_whatever_a_stale_background_verdict_says_and_the_commit_judges() {
        let st = state();
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let sub = make_sub(&st, "bg", dir.path());
        for a in [TurnActivity::Working, TurnActivity::WaitingOnProcess, TurnActivity::WaitingOnSchedule] {
            st.registry.set_turn_activity(&sub, a);
            let text = request_finish(&st, &sub, args()).await.expect("accepted, never refused for background work");
            assert!(text.contains("woken") && text.contains("again"), "{text}");
            assert!(super::super::runtime::runtime().finish_pending(&sub), "{a:?}: parked");
            // Still running when the turn ends: dropped, nothing finished, nothing killed.
            assert!(!commit_finish_at(Some(data.path()), &st, &sub, None, None), "{a:?}");
            assert!(!st.registry.get(&sub).unwrap().subchat_finished);
        }
        // The work ended and the Stop hook read it: the same call now commits.
        st.registry.set_turn_activity(&sub, TurnActivity::Idle);
        assert!(request_finish(&st, &sub, args()).await.is_ok());
        assert!(commit_finish_at(Some(data.path()), &st, &sub, None, None));
        assert!(st.registry.get(&sub).unwrap().subchat_finished);
    }

    #[tokio::test]
    async fn finish_with_unknown_background_state_is_not_refused() {
        let st = state();
        let dir = tempfile::tempdir().unwrap();
        let sub = make_sub(&st, "unk", dir.path());
        assert_eq!(st.registry.turn_activity(&sub), TurnActivity::Unknown);
        assert!(request_finish(&st, &sub, args()).await.is_ok());
    }

    #[tokio::test]
    async fn finish_is_refused_over_the_subs_own_uncommitted_file() {
        let (dir, root) = super::super::git::test_repo::init();
        let mine = root.join("mine.txt");
        std::fs::write(&mine, "x").unwrap();
        let tp = super::super::git::test_repo::transcript(dir.path(), &[("Write", &mine)]);
        let st = state();
        let sub = make_sub(&st, "own", &root);
        let e = request_finish_with(&st, &sub, args(), Some(tp)).await.unwrap_err();
        assert!(e.contains("uncommitted edits to your own files") && e.contains("mine.txt"), "{e}");
        assert!(!super::super::runtime::runtime().finish_pending(&sub));
    }

    #[tokio::test]
    async fn finish_succeeds_with_a_peers_dirty_file_in_the_tree() {
        let (dir, root) = super::super::git::test_repo::init();
        let mine = root.join("mine.txt");
        std::fs::write(&mine, "x").unwrap();
        super::super::git::test_repo::git(&root, &["add", "mine.txt"]);
        super::super::git::test_repo::git(&root, &["commit", "-q", "-m", "mine"]);
        // A peer chat's uncommitted work sharing the tree.
        std::fs::write(root.join("peers.txt"), "y").unwrap();
        std::fs::write(root.join("base.txt"), "peer edit\n").unwrap();
        let tp = super::super::git::test_repo::transcript(dir.path(), &[("Write", &mine)]);
        append_lines(&tp, &[agent_use("rev-peer", "Agent"), tool_result("rev-peer", false, "No problems found.")]);
        let st = state();
        let sub = make_sub(&st, "peer", &root);
        let mut a = args();
        a.reviewer_tool_use_id = Some("rev-peer".into());
        assert!(
            request_finish_with(&st, &sub, a, Some(tp)).await.is_ok(),
            "a peer's dirty file must not refuse the finish"
        );
        assert!(super::super::runtime::runtime().finish_pending(&sub));
    }

    #[test]
    fn commit_leaves_the_row_not_ended_with_subchat_finished_set_and_stores_the_record() {
        let (_dir, root) = super::super::git::test_repo::init();
        let st = state();
        let sub = make_sub(&st, "commit", &root);
        let data = tempfile::tempdir().unwrap();
        super::super::runtime::runtime().set_pending_finish(
            &sub,
            FinishRecord {
                sub_id: sub.clone(),
                parent_id: Some("commit-main".into()),
                verdict: "Built, not pushed".into(),
                decided: vec!["use a flex row".into()],
                ruled_out: vec!["nothing".into()],
                reviewer_tool_use_id: Some("toolu_9".into()),
                ..FinishRecord::default()
            },
        );
        st.registry.set_plan(
            &sub,
            Some(vec![
                crate::types::PlanStepSnapshot { text: "Ship it".into(), status: "active".into() },
                crate::types::PlanStepSnapshot { text: "Dropped".into(), status: "skipped".into() },
            ]),
        );
        assert!(commit_finish_at(Some(data.path()), &st, &sub, None, None));
        let row = st.registry.get(&sub).unwrap();
        let steps: Vec<&str> = row.progress.plan.as_ref().unwrap().iter().map(|s| s.status.as_str()).collect();
        assert_eq!(steps, ["done", "skipped"], "the commit ticks the open plan steps");
        assert!(row.subchat_finished, "the row is marked finished");
        assert!(row.ended_at.is_none() && row.end_reason.is_none(), "finish is not an end");
        let rec = read_record_in(data.path(), &sub).expect("record stored");
        assert_eq!(rec.round, 1);
        assert_eq!(rec.verdict, "Built, not pushed");
        assert_eq!(rec.decided, ["use a flex row"]);
        assert_eq!(rec.reviewer_tool_use_id.as_deref(), Some("toolu_9"));
        assert_eq!(rec.git_head_at_finish, super::super::git::head(&root), "head at finish recorded");
        assert!(!rec.finished_at.is_empty());
        assert!(super::super::test_support::finished_calls().contains(&sub), "on_finished fired");
        assert!(!super::super::runtime::runtime().finish_pending(&sub), "the request is consumed");
    }

    /// A read-only sub (`writes` false) that already finished once with a "needs writes" verdict.
    fn finished_needing_writes(tag: &str) -> (super::super::TempDataDir, Arc<DaemonState>, String) {
        let data = super::super::TempDataDir::new();
        let st = state();
        let sub = make_sub(&st, tag, Path::new("."));
        super::super::store_sub_brief(&sub, &format!("{tag}-main"));
        let root = crate::settings::paths::data_dir().unwrap();
        let first = FinishRecord {
            sub_id: sub.clone(),
            parent_id: Some(format!("{tag}-main")),
            round: 1,
            verdict: "Approved, not posted yet (needs writes)".into(),
            text: "resend me with writes true".into(),
            ..FinishRecord::default()
        };
        write_record_in(&root, &first).unwrap();
        (data, st, sub)
    }

    fn verdict_args(verdict: &str) -> FinishArgs {
        FinishArgs { verdict: Some(verdict.into()), ..args() }
    }

    #[tokio::test]
    async fn a_sub_whose_writes_came_on_cannot_finish_again_with_a_needs_writes_verdict() {
        let (_data, st, sub) = finished_needing_writes("rf-needs");
        // Writes still off: the same verdict is a true report and goes through.
        assert!(request_finish_with(&st, &sub, verdict_args("Approved, not posted yet (needs writes)"), None).await.is_ok());
        assert!(super::super::runtime::runtime().take_pending_finish(&sub).is_some(), "the first finish was parked");
        assert!(super::super::tool::record_writes(&sub), "the follow-up turns writes on");
        for v in ["Approved, not posted yet (needs writes)", "Still needs writes", "Blocked: Edit refused, resend me with writes true"] {
            let e = request_finish_with(&st, &sub, verdict_args(v), None).await.unwrap_err();
            assert!(e.contains("Your writes are on now. Do the job, or name the exact error"), "{v}: {e}");
            assert!(!super::super::runtime::runtime().finish_pending(&sub), "a refusal parks nothing");
        }
        let named = verdict_args("Write refused: EACCES on C:/tmp/reply.md");
        assert!(request_finish_with(&st, &sub, named, None).await.is_ok(), "naming the exact error is allowed");
    }

    #[tokio::test]
    async fn a_sub_whose_writes_came_on_cannot_repeat_its_unmet_verdict_even_without_the_writes_words() {
        let (_data, st, sub) = finished_needing_writes("rf-same");
        let root = crate::settings::paths::data_dir().unwrap();
        let mut prev = read_record_in(&root, &sub).unwrap();
        prev.verdict = "Not posted, blocked".into();
        write_record_in(&root, &prev).unwrap();
        assert!(super::super::tool::record_writes(&sub));
        let e = request_finish_with(&st, &sub, verdict_args("Not posted,  BLOCKED"), None).await.unwrap_err();
        assert!(e.contains("Your writes are on now"), "{e}");
    }

    #[tokio::test]
    async fn a_met_verdict_repeated_after_writes_came_on_is_not_refused_and_the_flag_clears_at_finish() {
        let (_data, st, sub) = finished_needing_writes("rf-met");
        let root = crate::settings::paths::data_dir().unwrap();
        let mut prev = read_record_in(&root, &sub).unwrap();
        prev.verdict = "Done".into();
        write_record_in(&root, &prev).unwrap();
        assert!(super::super::tool::record_writes(&sub));
        assert!(request_finish_with(&st, &sub, verdict_args("Done"), None).await.is_ok(), "a clean verdict is not a repeat of an unmet one");
        assert!(commit_finish_at(Some(&root), &st, &sub, None, None));
        let brief = crate::sessions::chat_config::get(&sub).unwrap().subchat.unwrap();
        assert!(brief.writes && !brief.writes_on_since_finish, "the flip is spent once the sub has finished with writes on");
    }

    #[test]
    fn which_verdicts_count_as_unmet() {
        for v in ["Approved, not posted yet (needs writes)", "Blocked on auth", "NOT POSTED", "needs writes", "Could not post, needs writes", "Not done (needs writes)", "Did not post, blocked"] {
            assert!(is_unmet_verdict(v), "{v}");
        }
        for v in ["Approved, not posted (needs writes)", "Could not post, needs writes", "Resend me with writes true"] {
            assert!(is_needs_writes_verdict(v), "{v}");
        }
        for v in ["Built, not pushed", "Posted as comment 56853", "Done", "Unblocked the build", "No findings, nothing blocked", "Not blocked", "It isn't blocked", "Nothing was blocked", "No longer blocked", "Posted comment 5, no longer needs writes", "Done, needs written follow-up", "Non-blocked build"] {
            assert!(!is_unmet_verdict(v), "{v}");
            assert!(!is_needs_writes_verdict(v), "{v}");
        }
    }

    #[tokio::test]
    async fn writes_turned_on_after_the_call_are_judged_when_the_finish_commits() {
        let (_data, st, sub) = finished_needing_writes("rf-race");
        let root = crate::settings::paths::data_dir().unwrap();
        let rt = super::super::runtime::runtime();
        // Writes were still off at the call, so the repeat verdict was parked.
        assert!(request_finish_with(&st, &sub, verdict_args("Approved, not posted yet (needs writes)"), None).await.is_ok());
        // A follow-up turns writes on before the turn ends.
        assert!(super::super::tool::record_writes(&sub));
        assert!(!commit_finish_at(Some(&root), &st, &sub, None, None), "the stale needs-writes finish is dropped");
        assert!(rt.take_nudge_text(&sub).is_some_and(|t| t.contains("Your writes are on now")), "the sub is told why");
        assert!(!st.registry.get(&sub).unwrap().subchat_finished);
        let brief = crate::sessions::chat_config::get(&sub).unwrap().subchat.unwrap();
        assert!(brief.writes_on_since_finish, "the flip is not spent by a dropped finish");
    }

    #[test]
    fn a_question_on_the_brief_moves_onto_the_finish_record_and_off_the_brief() {
        let _data_dir = super::super::TempDataDir::new();
        let st = state();
        let sub = make_sub(&st, "fq", Path::new("."));
        super::super::store_sub_brief(&sub, "fq-main");
        let mut brief = crate::sessions::chat_config::get(&sub).unwrap().subchat.unwrap();
        brief.question = Some("Why does Gboard swipe fail?".into());
        crate::sessions::chat_config::set_subchat(&sub, Some(brief));
        let data = tempfile::tempdir().unwrap();
        for expected in [Some("Why does Gboard swipe fail?"), None] {
            super::super::runtime::runtime()
                .set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
            assert!(commit_finish_at(Some(data.path()), &st, &sub, None, None));
            assert_eq!(read_record_in(data.path(), &sub).unwrap().question.as_deref(), expected, "one question, one answer");
        }
        let brief = crate::sessions::chat_config::get(&sub).unwrap().subchat.unwrap();
        assert!(brief.question.is_none(), "the brief is cleared once a finish carries the question");
    }

    /// A follow-up question held mid-turn is on the brief from the moment it was
    /// held, but its text has not reached the sub. A finish already pending in that
    /// turn is not the answer to it: it stays for the round the held text starts.
    #[test]
    fn a_question_whose_text_is_still_held_waits_for_the_round_that_gets_it() {
        let (_data_dir, st, sub) = sub_asking("fqheld", "Is the design too far behind to build now?");
        super::super::followup::add(&sub, &format!("also the footer\n\n{}Is the design too far behind to build now?", super::super::brief::QUESTION_JOB));
        let data = tempfile::tempdir().unwrap();
        finish_once(&st, &sub, data.path());
        assert!(read_record_in(data.path(), &sub).unwrap().question.is_none(), "this finish is not its answer");
        assert_eq!(question_on_brief(&sub).as_deref(), Some("Is the design too far behind to build now?"), "it stays for the round the held text starts");
        // The held text is delivered (its line settles): the next finish answers it.
        super::super::followup::take_all_in(&crate::daemon::subchats::decisions::data_root().unwrap(), &sub);
        finish_once(&st, &sub, data.path());
        assert_eq!(read_record_in(data.path(), &sub).unwrap().question.as_deref(), Some("Is the design too far behind to build now?"));
        assert!(question_on_brief(&sub).is_none());
    }

    #[test]
    fn held_text_that_is_not_the_question_does_not_keep_it_back() {
        let (_data_dir, st, sub) = sub_asking("fqplain", "Why does Gboard swipe fail?");
        super::super::followup::add(&sub, "also check the footer");
        super::super::followup::add(&sub, &format!("x\n\n{}A different question?", super::super::brief::QUESTION_JOB));
        let data = tempfile::tempdir().unwrap();
        finish_once(&st, &sub, data.path());
        assert_eq!(read_record_in(data.path(), &sub).unwrap().question.as_deref(), Some("Why does Gboard swipe fail?"));
        assert!(question_on_brief(&sub).is_none());
    }

    /// A sub whose brief carries `question`, with its own data dir.
    fn sub_asking(tag: &str, question: &str) -> (super::super::TempDataDir, Arc<DaemonState>, String) {
        let data_dir = super::super::TempDataDir::new();
        let st = state();
        let sub = make_sub(&st, tag, Path::new("."));
        super::super::store_sub_brief(&sub, &format!("{tag}-main"));
        let mut brief = crate::sessions::chat_config::get(&sub).unwrap().subchat.unwrap();
        brief.question = Some(question.into());
        crate::sessions::chat_config::set_subchat(&sub, Some(brief));
        (data_dir, st, sub)
    }

    fn question_on_brief(sub: &str) -> Option<String> {
        crate::sessions::chat_config::get(sub).unwrap().subchat.unwrap().question
    }

    fn finish_once(st: &Arc<DaemonState>, sub: &str, root: &Path) {
        super::super::runtime::runtime().set_pending_finish(sub, FinishRecord { sub_id: sub.to_string(), ..FinishRecord::default() });
        assert!(commit_finish_at(Some(root), st, sub, None, None));
    }

    /// The daemon is killed, never shut down, so the exit save never runs: the
    /// snapshot must already say finished when the commit returns.
    #[test]
    fn the_saved_registry_snapshot_already_says_finished_when_the_commit_returns() {
        let st = state();
        let sub = make_sub(&st, "snapfin", Path::new("."));
        let data = tempfile::tempdir().unwrap();
        super::super::runtime::runtime()
            .set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        assert!(commit_finish_at(Some(data.path()), &st, &sub, None, None));
        let live = crate::settings::paths::interactive_sessions_file().unwrap();
        let saved = crate::sessions::persistence::load_snapshot(&data.path().join(live.file_name().unwrap()));
        let row = saved.iter().find(|s| s.session_id == sub).expect("the sub is in the saved snapshot");
        assert!(row.subchat_finished, "a kill right after the finish must not bring the sub back unfinished");
    }

    #[test]
    fn a_second_finish_after_continuing_is_round_two() {
        let st = state();
        let sub = make_sub(&st, "round", Path::new("."));
        let data = tempfile::tempdir().unwrap();
        for expected in [1u32, 2] {
            super::super::runtime::runtime()
                .set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
            assert!(commit_finish_at(Some(data.path()), &st, &sub, None, None));
            assert_eq!(read_record_in(data.path(), &sub).unwrap().round, expected);
        }
    }

    #[test]
    fn commit_drops_the_finish_when_background_work_started_after_the_call() {
        let st = state();
        let sub = make_sub(&st, "latebg", Path::new("."));
        let data = tempfile::tempdir().unwrap();
        super::super::runtime::runtime()
            .set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        st.registry.set_turn_activity(&sub, TurnActivity::Working);
        assert!(!commit_finish_at(Some(data.path()), &st, &sub, None, None));
        assert!(!st.registry.get(&sub).unwrap().subchat_finished);
        assert!(read_record_in(data.path(), &sub).is_none());
    }

    /// A record that will not decode reads as "no record" (unknown never blocks),
    /// but the bytes stay on disk as `.bad` for whoever has to find out why.
    #[test]
    fn a_damaged_finish_record_reads_as_none_and_is_kept_aside() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(data.path().join("subchats")).unwrap();
        let path = data.path().join("subchats").join("dmg-sub.finish.json");
        std::fs::write(&path, r#"{"round": "one"}"#).unwrap();
        assert!(read_record_in(data.path(), "dmg-sub").is_none());
        assert_eq!(std::fs::read_to_string(path.with_file_name("dmg-sub.finish.json.bad")).unwrap(), r#"{"round": "one"}"#);
    }

    #[test]
    fn commit_without_a_pending_request_does_nothing() {
        let st = state();
        let sub = make_sub(&st, "nopending", Path::new("."));
        assert!(!commit_finish_at(None, &st, &sub, None, None));
        assert!(!st.registry.get(&sub).unwrap().subchat_finished);
    }

    #[tokio::test]
    async fn finish_is_refused_while_the_sub_has_its_own_question_card_open() {
        let st = state();
        let dir = tempfile::tempdir().unwrap();
        let sub = make_sub(&st, "openq", dir.path());
        st.add_prompt("q-open", "question-requested", json!({"session_id": sub, "seq": 1}), true).await;
        let e = request_finish(&st, &sub, args()).await.unwrap_err();
        assert!(e.contains("still open") && e.contains("end your turn"), "names the fix: {e}");
        assert!(!super::super::runtime::runtime().finish_pending(&sub), "a refusal parks nothing");
        // A permission card waiting on Joe is the same.
        st.remove_prompt("q-open").await;
        st.add_prompt("p-open", "permission-requested", json!({"session_id": sub}), false).await;
        assert!(request_finish(&st, &sub, args()).await.is_err());
        // Once it is answered the finish goes through, and a daemon card ABOUT the
        // sub (its session_id is the main chat's) never blocks it.
        st.remove_prompt("p-open").await;
        st.add_prompt("stall", "question-requested", json!({"session_id": "openq-main", "sub_id": sub, "daemon_card": true}), true).await;
        assert!(request_finish(&st, &sub, args()).await.is_ok());
    }

    #[test]
    fn a_finish_with_an_edit_in_the_same_message_is_dropped_at_commit_and_the_sub_is_told() {
        let (dir, root) = super::super::git::test_repo::init();
        let late = root.join(RISKY_FILE);
        std::fs::create_dir_all(late.parent().unwrap()).unwrap();
        std::fs::write(&late, "x").unwrap();
        // The transcript now holds the Write, which the call-time check did not see.
        let tp = super::super::git::test_repo::transcript(dir.path(), &[("Write", &late)]);
        let st = state();
        let sub = make_sub(&st, "lateedit", &root);
        let data = tempfile::tempdir().unwrap();
        let rt = super::super::runtime::runtime();
        rt.set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        assert!(!commit_finish_at(Some(data.path()), &st, &sub, None, Some(tp.clone())));
        assert!(!st.registry.get(&sub).unwrap().subchat_finished);
        assert!(read_record_in(data.path(), &sub).is_none());
        assert!(rt.take_nudge_due(&sub), "the sub is told, since nothing else will");
        assert_eq!(rt.take_nudge_text(&sub).as_deref(), Some(FINISH_DROPPED_DIRTY_NUDGE));
        // Committed, the same finish goes through.
        super::super::git::test_repo::git(&root, &["add", RISKY_FILE]);
        super::super::git::test_repo::git(&root, &["commit", "-q", "-m", "late"]);
        // Committed, but no reviewer ran after that edit: dropped for that, and the
        // sub is told so with the review wording, not the dirty one.
        rt.set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        assert!(!commit_finish_at(Some(data.path()), &st, &sub, None, Some(tp.clone())));
        assert_eq!(rt.take_nudge_text(&sub).as_deref(), Some(FINISH_DROPPED_REVIEW_NUDGE));
        rt.take_nudge_due(&sub);
        append_lines(&tp, &[agent_use("rev-late", "Agent"), tool_result("rev-late", false, "Looks right.")]);
        rt.set_pending_finish(
            &sub,
            FinishRecord { sub_id: sub.clone(), reviewer_tool_use_id: Some("rev-late".into()), ..FinishRecord::default() },
        );
        assert!(commit_finish_at(Some(data.path()), &st, &sub, None, Some(tp)));
    }

    #[test]
    fn the_dirty_nudge_text_says_the_sub_did_call_finish_and_carries_no_dash() {
        assert!(FINISH_DROPPED_DIRTY_NUDGE.contains("was not accepted") && FINISH_DROPPED_DIRTY_NUDGE.contains("finish_subchat"));
        assert!(!FINISH_DROPPED_DIRTY_NUDGE.contains('\u{2014}'));
    }

    /// Item 12: a finish dropped because background work started after the call
    /// tells the sub nothing at that moment, and the sub recovers through the
    /// Stop sequence once the work ends and wakes it, not by sitting finished-looking.
    #[test]
    fn a_finish_dropped_for_background_work_leaves_the_sub_unfinished_with_no_stale_nudge() {
        let st = state();
        let sub = make_sub(&st, "bgdrop", Path::new("."));
        let rt = super::super::runtime::runtime();
        rt.set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        st.registry.set_turn_activity(&sub, TurnActivity::WaitingOnProcess);
        st.registry.set_plan(&sub, Some(vec![crate::types::PlanStepSnapshot { text: "Ship it".into(), status: "active".into() }]));
        assert!(!commit_finish_at(None, &st, &sub, None, None));
        let plan = st.registry.get(&sub).unwrap().progress.plan.unwrap();
        assert_eq!(plan[0].status, "active", "a dropped finish leaves the sub working, so its plan stays open");
        assert!(!rt.take_nudge_due(&sub), "the woken turn's own Stop hook does the telling");
        assert_eq!(rt.stage(&sub), super::super::runtime::SubStage::Fresh, "the next unfinished end starts the block-nudge-card sequence");
    }
}
