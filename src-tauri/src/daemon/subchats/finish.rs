//! `finish_subchat`: how a sub ends its job. Finished means idle and hidden:
//! the process stops, the row stays, and a follow-up wakes it with its context
//! (spec section 9). It is `finalize_close` without `mark_ended`, plus the
//! activity checks that one lacks.
//!
//! Two halves, because the tool call lands mid-turn:
//! - [`request_finish`] runs at the call. It refuses (naming the fix) while the
//!   sub has its own uncommitted edits or background work, and otherwise parks
//!   the request in [`super::runtime`].
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
    #[serde(default)]
    pub done: Vec<String>,
    #[serde(default)]
    pub not_done: Vec<String>,
    #[serde(default)]
    pub waiting_on: Vec<String>,
    #[serde(default)]
    pub your_move: Vec<String>,
    /// The `tool_use` id of the reviewer subagent run, when the sub ran one.
    /// Stored as given; the reviewer requirement that reads it is a later step.
    #[serde(default)]
    pub reviewer_tool_use_id: Option<String>,
    /// `HEAD` of the sub's repo when it finished. The head at spawn is recorded
    /// by the spawn path, so commits-since-spawn is the pair.
    #[serde(default)]
    pub git_head_at_finish: Option<String>,
    #[serde(default)]
    pub finished_at: String,
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

/// `decided` / `ruled_out`: required, at least one row, and `["nothing"]` is how
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
    let raw = std::fs::read_to_string(record_path(root, sub_id)?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// A sub's latest finish record from the real data dir.
pub fn read_record(sub_id: &str) -> Option<FinishRecord> {
    read_record_in(&crate::settings::paths::data_dir().ok()?, sub_id)
}

fn write_record_in(root: &Path, record: &FinishRecord) -> std::io::Result<()> {
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

fn list_files(files: &[String]) -> String {
    let shown: Vec<&str> = files.iter().take(MAX_NAMED_FILES).map(String::as_str).collect();
    let more = files.len().saturating_sub(MAX_NAMED_FILES);
    if more > 0 {
        format!("{} and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
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
    // Last Stop hook's verdict: the only ground truth for background work the
    // daemon has (`classify` reads the CLI's own task list). It can be a turn
    // old, so `commit_finish` re-reads it at turn end before anything is killed.
    if has_background_work(state.registry.turn_activity(sub_id)) {
        return Err("your own background work is still running (a build, a subagent, a watcher or a scheduled wake). Stopping now would kill it. Wait for it to finish, or stop it, then call finish_subchat again.".to_string());
    }
    // A sub that finishes with its own question card still open leaves Joe a
    // card whose asker has declared itself done. `ask_user_question` can return
    // to the sub unconfirmed while the durable card stays queued for the main
    // chat, so this is reachable, and the right move is to end the turn and wait.
    if crate::daemon::lifecycle::has_open_prompt(state, sub_id).await {
        return Err("you have a question or permission card still open for Joe, and finishing now would leave it with nobody to answer. Do not call finish_subchat: end your turn and carry on when his answer arrives, then call finish_subchat.".to_string());
    }
    let cwd = inst.cwd.clone();
    let own_dirty = match transcript {
        Some(t) => tokio::task::spawn_blocking(move || super::git::own_uncommitted(&t, &cwd))
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    if !own_dirty.is_empty() {
        return Err(format!(
            "you have uncommitted edits to your own files: {}. Commit them (by path, only these files, in the repo each one belongs to: a submodule is its own repo), then call finish_subchat again.",
            list_files(&own_dirty)
        ));
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
        done: rows(args.done),
        not_done: rows(args.not_done),
        waiting_on: rows(args.waiting_on),
        your_move: rows(args.your_move),
        reviewer_tool_use_id: args.reviewer_tool_use_id,
        ..FinishRecord::default()
    };
    super::runtime::runtime().set_pending_finish(sub_id, record);
    Ok("Finish accepted. End your turn now without calling more tools; the daemon stops this chat once the turn ends.".to_string())
}

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

/// [`commit_finish`] with the data dir and the transcript injected, so tests
/// write to a tempdir and read a scratch transcript.
pub(crate) fn commit_finish_at(
    root: Option<&Path>,
    state: &Arc<DaemonState>,
    sub_id: &str,
    session: Option<&Arc<Session>>,
    transcript: Option<PathBuf>,
) -> bool {
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
    let own_dirty = transcript.map(|t| super::git::own_uncommitted(&t, &inst.cwd)).unwrap_or_default();
    if !own_dirty.is_empty() {
        log::info!("subchats: {sub_id} finish dropped, uncommitted edits: {}", list_files(&own_dirty));
        rt.set_nudge_text(sub_id, FINISH_DROPPED_DIRTY_NUDGE);
        rt.set_nudge_due(sub_id);
        return false;
    }
    let owned_root = root.map(Path::to_path_buf).or_else(|| crate::settings::paths::data_dir().ok());
    let previous_round = owned_root.as_deref().and_then(|r| read_record_in(r, sub_id)).map_or(0, |p| p.round);
    record.round = previous_round + 1;
    record.git_head_at_finish = super::git::head(&inst.cwd);
    record.finished_at = chrono::Utc::now().to_rfc3339();
    if let Some(r) = owned_root.as_deref() {
        if let Err(e) = write_record_in(r, &record) {
            log::warn!("subchats: could not store {sub_id}'s finish record: {e}");
        }
    }
    state.registry.set_subchat_finished(sub_id, true);
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

    fn args() -> FinishArgs {
        FinishArgs {
            verdict: Some("Built, not pushed".into()),
            text: Some("Header done".into()),
            decided: vec!["nothing".into()],
            ruled_out: vec!["nothing".into()],
            ..FinishArgs::default()
        }
    }

    #[test]
    fn parse_requires_decided_and_ruled_out_and_names_the_fix() {
        let e = FinishArgs::parse(&json!({"verdict": "v", "text": "t"})).unwrap_err();
        assert!(e.contains("decided is required") && e.contains("[\"nothing\"]"), "{e}");
        let e = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": []})).unwrap_err();
        assert!(e.contains("ruled_out is required"), "{e}");
        let ok = FinishArgs::parse(&json!({"decided": ["nothing"], "ruled_out": ["nothing"]})).unwrap();
        assert_eq!(ok.decided, ["nothing"]);
    }

    #[test]
    fn parse_names_the_fix_for_a_wrong_shape_instead_of_failing_to_decode() {
        let e = FinishArgs::parse(&json!({"decided": "just text", "ruled_out": ["nothing"]})).unwrap_err();
        assert!(e.contains("decided must be a list of strings"), "{e}");
        let e = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "done": [1]})).unwrap_err();
        assert!(e.contains("done must be a list of strings"), "{e}");
        let e = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "verdict": 3})).unwrap_err();
        assert!(e.contains("verdict must be a string"), "{e}");
    }

    #[test]
    fn parse_keeps_the_reviewer_id_and_drops_a_blank_one() {
        let a = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "reviewer_tool_use_id": " toolu_1 "})).unwrap();
        assert_eq!(a.reviewer_tool_use_id.as_deref(), Some("toolu_1"));
        let b = FinishArgs::parse(&json!({"decided": ["a"], "ruled_out": ["b"], "reviewer_tool_use_id": "  "})).unwrap();
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

    #[tokio::test]
    async fn finish_is_refused_while_the_sub_has_background_work() {
        let st = state();
        let dir = tempfile::tempdir().unwrap();
        let sub = make_sub(&st, "bg", dir.path());
        for a in [TurnActivity::Working, TurnActivity::WaitingOnProcess, TurnActivity::WaitingOnSchedule] {
            st.registry.set_turn_activity(&sub, a);
            let e = request_finish(&st, &sub, args()).await.unwrap_err();
            assert!(e.contains("background work is still running"), "{a:?}: {e}");
            assert!(!super::super::runtime::runtime().finish_pending(&sub), "a refusal parks nothing");
        }
        st.registry.set_turn_activity(&sub, TurnActivity::Idle);
        assert!(request_finish(&st, &sub, args()).await.is_ok());
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
        let st = state();
        let sub = make_sub(&st, "peer", &root);
        assert!(
            request_finish_with(&st, &sub, args(), Some(tp)).await.is_ok(),
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
        assert!(commit_finish_at(Some(data.path()), &st, &sub, None, None));
        let row = st.registry.get(&sub).unwrap();
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
        let late = root.join("late.txt");
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
        assert_eq!(rt.take_nudge_text(&sub), Some(FINISH_DROPPED_DIRTY_NUDGE));
        // Committed, the same finish goes through.
        super::super::git::test_repo::git(&root, &["add", "late.txt"]);
        super::super::git::test_repo::git(&root, &["commit", "-q", "-m", "late"]);
        rt.set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
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
        assert!(!commit_finish_at(None, &st, &sub, None, None));
        assert!(!rt.take_nudge_due(&sub), "the woken turn's own Stop hook does the telling");
        assert_eq!(rt.stage(&sub), super::super::runtime::SubStage::Fresh, "the next unfinished end starts the block-nudge-card sequence");
    }
}
