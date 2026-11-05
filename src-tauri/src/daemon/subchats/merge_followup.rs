//! What a refused worktree merge sets in motion, beyond the `blocker` card.
//!
//! A refusal is one of two kinds of problem. The sub can fix a conflict between
//! its commits and the target, so it is told at once, through [`super::continue_sub`],
//! to rebase, resolve and finish again. Nothing the sub does can fix the main
//! checkout (uncommitted changes in a file the merge would change, or a switched
//! branch), so that one goes to Joe on a card whose answers the code carries out:
//! "Merge again" retries the merge by code, with no sub turn and no main-agent
//! turn. Nothing here wakes the main agent.
//!
//! A second conflict in a row means telling the sub did not work, and goes to
//! Joe the same way. The raised cards are never persisted (see `cards`), so after
//! a restart the finish card's "not merged" chip is what is left of a refusal.
//!
//! Off the runtime: the merge runs on its own thread. [`super::worktree::defer`]
//! enters the runtime that called `on_finished` on that thread, which is what lets
//! the spawns below (and the ones in `held`, `closing` and `wake`) find one.

use super::brief::WorktreeInfo;
use super::card_log::{self, BlockerCard};
use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use super::worktree::{self, Blocked, Cause, Landing};
use crate::daemon::state::DaemonState;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

/// `card_kind` of the card for a conflict the sub did not resolve.
pub const CONFLICT_KIND: &str = "subchat_conflict";
/// `card_kind` of the card for a refusal only Joe can clear.
pub const REFUSED_KIND: &str = "subchat_merge_refused";
pub const TRY_AGAIN: &str = "Have it try again";
pub const MERGE_AGAIN: &str = "Merge again";
pub const LEAVE_IT: &str = "Leave it";

/// Refused merges in a row per sub, counted from the first conflict until a
/// landing, Joe's "Leave it" or the sub ending.
static CONFLICTS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// Subs whose commits are not in the target and whose refusal is still being
/// handled (told, or a card open). A sub waiting on one of these with `after`
/// keeps waiting: starting on a base that did not land would build on the wrong code.
static UNRESOLVED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn bump_conflicts(sub_id: &str) -> u32 {
    let mut g = CONFLICTS.lock().unwrap_or_else(|p| p.into_inner());
    let n = g.get_or_insert_with(HashMap::new).entry(sub_id.to_string()).or_insert(0);
    *n += 1;
    *n
}

fn set_unresolved(sub_id: &str, on: bool) {
    let mut g = UNRESOLVED.lock().unwrap_or_else(|p| p.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if on {
        set.insert(sub_id.to_string());
    } else {
        set.remove(sub_id);
    }
}

/// Whether `sub_id`'s refused merge is still being handled.
pub fn unresolved(sub_id: &str) -> bool {
    UNRESOLVED.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

/// Forgets a sub's refusal: its commits landed, Joe left it, or the sub ended.
pub fn forget(sub_id: &str) {
    if let Some(m) = CONFLICTS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        m.remove(sub_id);
    }
    set_unresolved(sub_id, false);
}

/// A landing that was not refused.
pub(super) fn on_landed(sub_id: &str) {
    forget(sub_id);
}

/// What a sub is told when its commits conflict with the target. Built here from
/// the branch names and file paths git reported, never from anything a sub wrote.
pub fn tell_text(info: &WorktreeInfo, files: &[String]) -> String {
    let list = if files.is_empty() { "the files git named".to_string() } else { files.join(", ") };
    format!(
        "Your commits could not be merged into {t}: branch {b} conflicts with it in {list}. In your worktree run git rebase {t}, resolve the conflicts, finish the rebase, commit, and call finish_subchat again: it merges when you finish. This is routine, so resolve it yourself and do not ask Joe unless a conflict is a real choice.",
        t = info.target,
        b = info.branch,
    )
}

/// The sentence the `blocker` card carries once the sub has been told.
fn told_card_text(info: &WorktreeInfo) -> String {
    format!(
        "Its commits conflict with {t}. Nothing was merged, and its worktree keeps every commit. The sub was told to rebase branch {b} on {t}, resolve the conflict, commit and finish again, and is handling it: it merges when it finishes.",
        t = info.target,
        b = info.branch,
    )
}

/// Sends `text` to the sub as a new turn. In tests it records the call and the
/// text instead, so no `claude` is started.
async fn send_to_sub(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        let _ = state;
        return test_support::send(sub_id, text);
    }
    #[cfg(not(test))]
    super::resume::continue_sub(state, sub_id, text).await.map_err(|e| e.to_string())
}

/// Handles a refused landing. Returns the `blocker` card to draw, or `None` when
/// a real card took its place. With no runtime to run the follow-up on (a plain
/// test thread), the refusal is the old passive card.
pub(super) fn on_blocked(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo, b: &Blocked) -> Option<Blocked> {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return Some(b.clone()) };
    let (state, id, info_owned) = (state.clone(), sub_id.to_string(), info.clone());
    match b.cause {
        Cause::Conflict => {
            let files = b.points.clone();
            set_unresolved(sub_id, true);
            if bump_conflicts(sub_id) == 1 {
                // Out of "finished" now, not when the message lands: the next lines of
                // finishing (a close waiting on its last sub, the "all finished" card)
                // read the row, and this sub is working again.
                state.registry.set_subchat_finished(sub_id, false);
                crate::daemon::machines::publish_instances_changed(&state);
                handle.spawn(async move { tell(&state, &id, &info_owned, &files).await });
                return Some(Blocked { text: told_card_text(info), ..b.clone() });
            }
            handle.spawn(async move { raise_conflict(state, id, info_owned, files, None).await });
            None
        }
        Cause::DirtyOverlap | Cause::BranchSwitched => {
            set_unresolved(sub_id, true);
            let b = b.clone();
            handle.spawn(async move { raise_refused(state, id, info_owned, b).await });
            None
        }
        Cause::Other => Some(b.clone()),
    }
}

/// Tells the sub, and asks Joe if that did not work.
async fn tell(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo, files: &[String]) {
    if let Err(e) = send_to_sub(state, sub_id, &tell_text(info, files)).await {
        log::warn!("subchats: could not tell {sub_id} to resolve its conflict: {e}");
        state.registry.set_subchat_finished(sub_id, true);
        crate::daemon::machines::publish_instances_changed(state);
        raise_conflict(state.clone(), sub_id.to_string(), info.clone(), files.to_vec(), Some(e)).await;
    }
}

fn sub_label(state: &DaemonState, sub_id: &str) -> String {
    state
        .registry
        .get(sub_id)
        .and_then(|i| i.name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "A sub".to_string())
}

fn files_line(files: &[String]) -> String {
    if files.is_empty() {
        return String::new();
    }
    format!("\n\nFiles: {}", files.join(", "))
}

/// The passive card, for a refusal whose real card could not be raised.
fn fallback_card(state: &Arc<DaemonState>, sub_id: &str, b: &Blocked) {
    card_log::on_blocker(
        state,
        sub_id,
        BlockerCard { text: b.text.clone(), verdict: b.verdict.to_string(), tone: Some("bad".into()), points: b.points.clone() },
    );
}

/// A second conflict in a row, or a sub that could not be told. Boxed because the
/// answer can raise this card again, which makes the future contain itself.
fn raise_conflict(
    state: Arc<DaemonState>,
    sub_id: String,
    info: WorktreeInfo,
    files: Vec<String>,
    why: Option<String>,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        if cards::open_card_for(&state, CONFLICT_KIND, &sub_id).await.is_some() {
            return;
        }
        let Some(parent) = state.registry.get(&sub_id).and_then(|i| i.subchat_of) else { return };
        let name = sub_label(&state, &sub_id);
        let lead = match &why {
            Some(e) => format!("**{name}** could not be told to resolve its conflict with {t}: {e}.", t = info.target),
            None => format!("**{name}** still conflicts with {t} after it was told to resolve it.", t = info.target),
        };
        let card = RaisedCard {
            kind: CONFLICT_KIND,
            display_session_id: parent,
            sub_id: Some(sub_id.clone()),
            header: "Merge conflict".to_string(),
            question: format!(
                "{lead}{}\n\nNothing was merged and its commits are safe on branch {}. Have it try again, or leave it?",
                files_line(&files),
                info.branch
            ),
            options: vec![
                CardOption::new(TRY_AGAIN, "Tell it again to rebase, resolve and finish"),
                CardOption::new(LEAVE_IT, "Do nothing; the commits stay on its branch"),
            ],
            domain: None,
        };
        match cards::raise_card(&state, card).await {
            Ok(handle) => {
                let (state, sub) = (state.clone(), sub_id.clone());
                handle.on_answer(move |answer| async move { answer_conflict(state, sub, info, files, answer).await });
            }
            Err(e) => {
                log::warn!("subchats: could not raise the conflict card for {sub_id}: {e}");
                let b = Blocked {
                    verdict: "Merge conflict",
                    text: format!("Its commits still conflict with {}. Nothing was merged and its worktree keeps every commit.", info.target),
                    points: files,
                    cause: Cause::Conflict,
                };
                fallback_card(&state, &sub_id, &b);
            }
        }
    })
}

async fn answer_conflict(state: Arc<DaemonState>, sub_id: String, info: WorktreeInfo, files: Vec<String>, answer: CardAnswer) {
    match answer {
        CardAnswer::Picked(pick) if pick == TRY_AGAIN => {
            state.registry.set_subchat_finished(&sub_id, false);
            crate::daemon::machines::publish_instances_changed(&state);
            tell(&state, &sub_id, &info, &files).await;
        }
        CardAnswer::Picked(pick) if pick == LEAVE_IT => leave(&state, &sub_id),
        _ => {}
    }
}

/// Joe left it: nothing is pending for this sub, so whatever waited on it goes on.
fn leave(state: &Arc<DaemonState>, sub_id: &str) {
    forget(sub_id);
    super::held::on_target_done(state);
}

/// A refusal only Joe can clear: the main checkout is dirty in a file the merge
/// would change, or it is on another branch.
async fn raise_refused(state: Arc<DaemonState>, sub_id: String, info: WorktreeInfo, b: Blocked) {
    if cards::open_card_for(&state, REFUSED_KIND, &sub_id).await.is_some() {
        return;
    }
    let Some(parent) = state.registry.get(&sub_id).and_then(|i| i.subchat_of) else { return };
    let name = sub_label(&state, &sub_id);
    let why = match b.cause {
        Cause::DirtyOverlap => format!(
            "The main checkout has uncommitted changes in files **{name}** also changed, so its commits were not merged into {t} and nothing there was touched.{}\n\nCommit or move those changes, then merge again.",
            files_line(&b.points),
            t = info.target,
        ),
        _ => format!(
            "The main checkout is not on {t} any more, so **{name}**'s commits were not merged and nothing there was touched.\n\nSwitch it back to {t}, then merge again.",
            t = info.target,
        ),
    };
    let card = RaisedCard {
        kind: REFUSED_KIND,
        display_session_id: parent,
        sub_id: Some(sub_id.clone()),
        header: "Not merged".to_string(),
        question: format!("{why}\n\nIts commits are safe on branch {}.", info.branch),
        options: vec![
            CardOption::new(MERGE_AGAIN, "Try the merge again now, without the sub"),
            CardOption::new(LEAVE_IT, "Do nothing; the commits stay on its branch"),
        ],
        domain: None,
    };
    match cards::raise_card(&state, card).await {
        Ok(handle) => {
            let (state, sub) = (state.clone(), sub_id.clone());
            handle.on_answer(move |answer| async move { answer_refused(state, sub, answer).await });
        }
        Err(e) => {
            log::warn!("subchats: could not raise the merge card for {sub_id}: {e}");
            fallback_card(&state, &sub_id, &b);
        }
    }
}

async fn answer_refused(state: Arc<DaemonState>, sub_id: String, answer: CardAnswer) {
    match answer {
        CardAnswer::Picked(pick) if pick == MERGE_AGAIN => merge_again(&state, &sub_id).await,
        CardAnswer::Picked(pick) if pick == LEAVE_IT => leave(&state, &sub_id),
        _ => {}
    }
}

/// "Merge again": the same landing the finish ran, by code. A refusal raises its
/// own card again (inside `land_and_report`); a landing says so in the main chat.
async fn merge_again(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(info) = worktree::info_of(sub_id) else { return };
    let (st, id) = (state.clone(), sub_id.to_string());
    let landing = tokio::task::spawn_blocking(move || worktree::land_counted(&st, &id, &info)).await;
    match landing {
        Ok(Landing::Merged) => {
            let target = worktree::info_of(sub_id).map(|i| i.target).unwrap_or_default();
            card_log::on_blocker(
                state,
                sub_id,
                BlockerCard {
                    text: format!("Its commits are now in {target}."),
                    verdict: "Merged".to_string(),
                    tone: Some("good".into()),
                    points: Vec::new(),
                },
            );
            super::held::on_target_done(state);
        }
        Ok(Landing::Nothing) => super::held::on_target_done(state),
        Ok(Landing::Blocked(_)) => {}
        Err(e) => log::warn!("subchats: the merge retry for {sub_id} panicked: {e}"),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashSet;
    use std::sync::Mutex;

    static SENT: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    static FAILING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    pub fn send(sub_id: &str, text: &str) -> Result<(), String> {
        if FAILING.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id)) {
            return Err("it has been ended and cannot continue".to_string());
        }
        SENT.lock().unwrap_or_else(|p| p.into_inner()).push((sub_id.to_string(), text.to_string()));
        Ok(())
    }

    /// Every text sent to `sub_id` so far, oldest first.
    pub fn sent_to(sub_id: &str) -> Vec<String> {
        SENT.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|(s, _)| s == sub_id).map(|(_, t)| t.clone()).collect()
    }

    pub fn fail_for(sub_id: &str) {
        FAILING.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashSet::new).insert(sub_id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::methods::permission::respond_question_inner;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::git::test_repo;
    use crate::daemon::subchats::worktree::Prepare;
    use crate::daemon::subchats::{SubchatBrief, TempDataDir};
    use crate::sessions::chat_config;
    use crate::types::Settings;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    const TS: &str = "2026-11-05T00:00:00Z";

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn g(dir: &Path, args: &[&str]) {
        test_repo::git(dir, args);
    }

    fn commit_file(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
        g(dir, &["add", name]);
        g(dir, &["commit", "-q", "-m", &format!("edit {name}")]);
    }

    /// A finished worktree sub of a main chat at `root`: its row, its brief, a real
    /// worktree, and the finished flag the way a committed finish leaves it.
    fn finished_sub(st: &Arc<DaemonState>, tag: &str, root: &Path) -> (String, String, WorktreeInfo) {
        let sid = uuid::Uuid::new_v4().to_string();
        let Ok(Prepare::Ready(p)) = worktree::prepare(root, &sid) else { panic!("a scratch repo can have a worktree") };
        let main = format!("{tag}-main");
        st.registry.upsert_interactive(&main, root, "proj", TS);
        st.registry.upsert_interactive(&sid, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&sid, Some(main.clone()));
        st.registry.set_name(&sid, tag.to_string());
        let mut brief: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t","goal":"g","done_when":"d","writes":true,"files":["a.txt"]}"#).unwrap();
        brief.parent = main.clone();
        brief.worktree_at = Some(p.info.clone());
        brief.git_head_at_spawn = crate::daemon::subchats::git::head(Path::new(&p.info.cwd));
        chat_config::set_subchat(&sid, Some(brief));
        st.registry.set_subchat_finished(&sid, true);
        (main, sid, p.info)
    }

    /// `land_and_report` the way `defer` runs it: on a thread that is not the runtime's,
    /// with the runtime entered.
    async fn land(st: &Arc<DaemonState>, id: &str, info: &WorktreeInfo) -> Landing {
        let (st, id, info) = (st.clone(), id.to_string(), info.clone());
        tokio::task::spawn_blocking(move || worktree::land_and_report(&st, &id, &info)).await.unwrap()
    }

    async fn until(mut done: impl FnMut() -> bool) -> bool {
        for _ in 0..400 {
            if done() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        false
    }

    async fn card(st: &Arc<DaemonState>, kind: &str, sub: &str) -> Option<String> {
        for _ in 0..400 {
            if let Some(id) = cards::open_card_for(st, kind, sub).await {
                return Some(id);
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        None
    }

    async fn pick(st: &Arc<DaemonState>, id: &str, label: &str) {
        let prompts = st.list_prompts().await;
        let question = prompts.iter().find(|p| p["id"].as_str() == Some(id)).unwrap()["payload"]["questions"][0]["question"].as_str().unwrap().to_string();
        let mut answers = serde_json::Map::new();
        answers.insert(question, json!(label));
        respond_question_inner(st, id, serde_json::Value::Object(answers), false).await;
    }

    async fn card_json(st: &Arc<DaemonState>, id: &str) -> serde_json::Value {
        st.list_prompts().await.into_iter().find(|p| p["id"].as_str() == Some(id)).unwrap()["payload"].clone()
    }

    fn blockers(main: &str) -> Vec<crate::daemon::subchats::card_log::CardEntry> {
        card_log::read(main).into_iter().filter(|c| c.kind == card_log::KIND_BLOCKER).collect()
    }

    fn conflicting(root: &Path, info: &WorktreeInfo) {
        commit_file(Path::new(&info.path), "base.txt", "sub's line\n");
        commit_file(root, "base.txt", "peer's line\n");
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
    }

    /// The first real run: the card said "Tell the sub to ..." and nobody did.
    #[test]
    fn a_conflict_tells_the_sub_at_once_and_the_card_says_so() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "told", &root);
            conflicting(&root, &info);

            let landing = land(&st, &id, &info).await;
            assert!(matches!(landing, Landing::Blocked(ref b) if b.cause == Cause::Conflict));
            assert!(until(|| !test_support::sent_to(&id).is_empty()).await, "the sub was never told");
            let sent = test_support::sent_to(&id);
            assert_eq!(sent.len(), 1);
            for needle in [info.branch.as_str(), info.target.as_str(), "base.txt", "git rebase", "finish_subchat"] {
                assert!(sent[0].contains(needle), "{needle:?} missing: {}", sent[0]);
            }
            assert!(!st.registry.get(&id).unwrap().subchat_finished, "it is working on it again");
            assert!(unresolved(&id));
            let cards = blockers(&main);
            assert_eq!(cards.len(), 1);
            assert!(cards[0].text.contains("was told") && cards[0].text.contains("handling it"), "{}", cards[0].text);
            assert_eq!(cards[0].points, vec!["base.txt".to_string()]);
            assert!(cards::open_card_for(&st, CONFLICT_KIND, &id).await.is_none(), "no question yet");
        });
    }

    /// The sub resolves it and finishes again: that lands, and the memory of the conflict goes.
    #[test]
    fn a_resolved_conflict_lands_on_the_next_finish_and_clears_the_count() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "resolved", &root);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            assert!(unresolved(&id));
            let wt = PathBuf::from(&info.path);
            let target = format!("refs/heads/{}", info.target);
            assert!(crate::daemon::subchats::git::run_git(&wt, &["rebase", &target]).is_some_and(|(ok, _)| !ok));
            std::fs::write(wt.join("base.txt"), "resolved\n").unwrap();
            g(&wt, &["add", "base.txt"]);
            g(&wt, &["-c", "core.editor=true", "rebase", "--continue"]);
            assert_eq!(land(&st, &id, &info).await, Landing::Merged);
            assert!(!unresolved(&id));
            // A later conflict starts the count again: the sub is told, not asked about.
            commit_file(&wt, "base.txt", "again\n");
            commit_file(&root, "base.txt", "peer again\n");
            land(&st, &id, &info).await;
            assert!(until(|| test_support::sent_to(&id).len() == 2).await);
            assert!(cards::open_card_for(&st, CONFLICT_KIND, &id).await.is_none());
        });
    }

    #[test]
    fn a_second_conflict_in_a_row_raises_a_real_card_and_try_again_tells_it_once_more() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "twice", &root);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            assert!(until(|| test_support::sent_to(&id).len() == 1).await);
            // It finishes again without having fixed it.
            st.registry.set_subchat_finished(&id, true);
            land(&st, &id, &info).await;

            let card_id = card(&st, CONFLICT_KIND, &id).await.expect("the second conflict is a real card");
            let payload = card_json(&st, &card_id).await;
            assert_eq!(payload["display_session_id"], main.as_str());
            let labels: Vec<&str> = payload["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
            assert_eq!(labels, [TRY_AGAIN, LEAVE_IT]);
            assert!(payload["questions"][0]["question"].as_str().unwrap().contains("base.txt"));
            assert_eq!(blockers(&main).len(), 1, "only the first conflict drew the passive card");

            pick(&st, &card_id, TRY_AGAIN).await;
            assert!(until(|| test_support::sent_to(&id).len() == 2).await, "it was told again");
            assert!(!st.registry.get(&id).unwrap().subchat_finished);
        });
    }

    #[test]
    fn leave_it_does_nothing_more_and_lets_a_sub_waiting_behind_it_go() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "leave", &root);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            st.registry.set_subchat_finished(&id, true);
            land(&st, &id, &info).await;
            assert!(unresolved(&id));
            let card_id = card(&st, CONFLICT_KIND, &id).await.unwrap();
            pick(&st, &card_id, LEAVE_IT).await;
            assert!(until(|| !unresolved(&id)).await);
            assert_eq!(test_support::sent_to(&id).len(), 1, "the sub is not told again");
            assert!(st.registry.get(&id).unwrap().subchat_finished);
        });
    }

    #[test]
    fn a_sub_that_cannot_be_told_gets_a_real_card_instead_and_stays_finished() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "untold", &root);
            test_support::fail_for(&id);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            let card_id = card(&st, CONFLICT_KIND, &id).await.expect("a card, since telling failed");
            let q = card_json(&st, &card_id).await["questions"][0]["question"].as_str().unwrap().to_string();
            assert!(q.contains("could not be told") && q.contains("cannot continue"), "{q}");
            assert!(st.registry.get(&id).unwrap().subchat_finished, "it did not start working");
        });
    }

    /// Nothing the sub does can clear the main checkout, so the sub is not told and the
    /// card is Joe's, with a retry by code.
    #[test]
    fn a_dirty_overlap_raises_a_card_naming_the_file_and_merge_again_lands_it_with_no_sub_turn() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "dirty", &root);
            commit_file(Path::new(&info.path), "base.txt", "the sub's version\n");
            std::fs::write(root.join("base.txt"), "mine, not committed\n").unwrap();

            let landing = land(&st, &id, &info).await;
            assert!(matches!(landing, Landing::Blocked(ref b) if b.cause == Cause::DirtyOverlap));
            let card_id = card(&st, REFUSED_KIND, &id).await.expect("a real card");
            let payload = card_json(&st, &card_id).await;
            let labels: Vec<&str> = payload["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
            assert_eq!(labels, [MERGE_AGAIN, LEAVE_IT]);
            assert!(payload["questions"][0]["question"].as_str().unwrap().contains("base.txt"));
            assert!(test_support::sent_to(&id).is_empty(), "the sub cannot fix this and is not woken");
            assert!(blockers(&main).is_empty(), "the real card replaced the passive one");
            assert!(unresolved(&id));
            assert!(st.registry.get(&id).unwrap().subchat_finished);

            // Still dirty: merging again is refused again, and asks again.
            pick(&st, &card_id, MERGE_AGAIN).await;
            let again = loop_until_new_card(&st, &id, &card_id).await;
            assert_eq!(std::fs::read(root.join("base.txt")).unwrap(), b"mine, not committed\n", "not a byte of it was touched");

            // Joe commits his change elsewhere; merge again lands.
            std::fs::write(root.join("base.txt"), "base\n").unwrap();
            g(&root, &["checkout", "-q", "--", "base.txt"]);
            pick(&st, &again, MERGE_AGAIN).await;
            assert!(until(|| root.join("base.txt").is_file() && std::fs::read_to_string(root.join("base.txt")).unwrap().replace("\r\n", "\n") == "the sub's version\n").await, "merged into the main checkout");
            assert!(until(|| !unresolved(&id)).await);
            assert!(test_support::sent_to(&id).is_empty(), "no sub turn at any point");
            assert!(until(|| blockers(&main).iter().any(|b| b.verdict == "Merged")).await, "the main chat is told it landed");
        });
    }

    async fn loop_until_new_card(st: &Arc<DaemonState>, sub: &str, old: &str) -> String {
        for _ in 0..600 {
            if let Some(id) = cards::open_card_for(st, REFUSED_KIND, sub).await {
                if id != old {
                    return id;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("no new card after merging again");
    }

    #[test]
    fn a_switched_branch_raises_a_card_and_merge_again_lands_once_it_is_switched_back() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "switched", &root);
            commit_file(Path::new(&info.path), "a.txt", "sub\n");
            g(&root, &["checkout", "-q", "-b", "elsewhere"]);
            let landing = land(&st, &id, &info).await;
            assert!(matches!(landing, Landing::Blocked(ref b) if b.cause == Cause::BranchSwitched));
            let card_id = card(&st, REFUSED_KIND, &id).await.expect("a real card");
            let q = card_json(&st, &card_id).await["questions"][0]["question"].as_str().unwrap().to_string();
            assert!(q.contains(&info.target), "{q}");
            assert!(test_support::sent_to(&id).is_empty());
            g(&root, &["checkout", "-q", &info.target]);
            pick(&st, &card_id, MERGE_AGAIN).await;
            assert!(until(|| root.join("a.txt").is_file()).await, "merged after switching back");
        });
    }

    /// A sub that waits for this one must not start on a base that did not land.
    #[test]
    fn a_sub_with_an_unresolved_refusal_is_not_a_clean_target_for_after() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "after-target", &root);
            crate::daemon::subchats::held::test_support::finish_record(&id, "Done", None);
            assert_eq!(crate::daemon::subchats::held::after_state(&st, &id), crate::daemon::subchats::held::AfterState::Clean);
            commit_file(Path::new(&info.path), "base.txt", "sub\n");
            std::fs::write(root.join("base.txt"), "dirty\n").unwrap();
            land(&st, &id, &info).await;
            assert_eq!(crate::daemon::subchats::held::after_state(&st, &id), crate::daemon::subchats::held::AfterState::Pending);
            forget(&id);
            assert_eq!(crate::daemon::subchats::held::after_state(&st, &id), crate::daemon::subchats::held::AfterState::Clean);
        });
    }

    /// The first end-to-end run: `after` started 52 seconds after its target finished,
    /// when the 60 second tick caught it. A worktree sub finishes through the merge
    /// thread, which had no runtime to spawn the start on. Here the real order runs:
    /// the finish, the merge on its thread, the rest of finishing, and the sweep.
    #[test]
    fn finishing_a_worktree_sub_starts_the_sub_waiting_for_it_at_once() {
        use crate::daemon::subchats::held::{self, Held, LaunchSpec};
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, target, info) = finished_sub(&st, "after-1", &root);
            commit_file(Path::new(&info.path), "a.txt", "from after-1\n");
            // after-2 is registered and held behind it, with a folder that does not exist
            // so the start it is given fails before any child is spawned: the card it
            // raises is the proof that the start was attempted.
            let waiting = "after-2".to_string();
            st.registry.upsert_interactive(&waiting, &root, "proj", TS);
            st.registry.set_subchat_of(&waiting, Some(main.clone()));
            st.registry.set_name(&waiting, "after-2".to_string());
            crate::daemon::subchats::store_sub_brief(&waiting, &main);
            held::hold(
                &st,
                Held {
                    sub_id: waiting.clone(),
                    reason: "waiting for after-1".into(),
                    after: Some(target.clone()),
                    after_name: "after-1".into(),
                    launch: LaunchSpec {
                        cwd: root.join("does-not-exist"),
                        model: "sonnet".into(),
                        effort: "medium".into(),
                        account_id: None,
                        first_message: "go".into(),
                    },
                },
            )
            .unwrap();
            assert!(held::is_held(&waiting));

            // The sweep is the only thing that can raise this card here, and the 60 second
            // tick is not running: if it shows up at all it came from the finish.
            crate::daemon::subchats::on_finished(&st, &target);
            assert!(
                card(&st, held::CARD_KIND, &waiting).await.is_some(),
                "the waiting sub was not started by the finish"
            );
            assert_eq!(crate::daemon::subchats::git::head(&root), crate::daemon::subchats::git::head(Path::new(&info.path)), "and what it waited for had landed");
        });
    }

    /// Without a runtime to run the follow-up on, the refusal is the old passive card.
    #[test]
    fn with_no_runtime_a_refusal_still_draws_the_passive_blocker_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (main, id, info) = finished_sub(&st, "plain-thread", &root);
        conflicting(&root, &info);
        worktree::land_and_report(&st, &id, &info);
        assert_eq!(blockers(&main).len(), 1);
        assert!(test_support::sent_to(&id).is_empty());
    }
}
