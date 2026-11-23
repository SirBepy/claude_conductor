//! "Turn into a project" (pc-1806 step 8): a chat started in the No project folder
//! becomes a project's main chat. The chat's own cwd never changes: Claude keys a
//! transcript by cwd, so a moved chat would lose its history. Instead the project is
//! created, a successor main chat starts in it, and the family follows the successor
//! the way a `respawn` hands it over (`closing::move_family`).
//!
//! The successor FORKS the old conversation (`--resume <old> --fork-session` from the
//! new cwd). Spiked 2026-11-22 with a real claude: a plain `--resume <id>` from another
//! cwd finds the transcript by id across project folders and writes nothing under the
//! new cwd, so it would leave the successor's history in the old folder; the fork lands
//! in a transcript under the NEW cwd with the whole context ("PELICAN" came back from
//! both). A chat with no transcript yet starts fresh instead.
//!
//! Order: nothing moves until the successor's child exists; the family then moves and the
//! first message goes out, and a failed send puts the family back and ends the successor,
//! so a failure leaves the old chat exactly as it was (only the project and its folder remain).

use super::closing;
use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::state::DaemonState;
use crate::sessions::kinds::InstanceKind;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Why a chat cannot be turned into a project; every refusal comes before anything changes.
#[derive(Debug, thiserror::Error)]
pub enum PromoteError {
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Failed(String),
}

fn refused(text: impl Into<String>) -> PromoteError {
    PromoteError::Refused(text.into())
}

/// What the move carried over and what it left, for the toast and the dialog's result.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Promoted {
    pub project_id: String,
    pub project_path: String,
    pub successor_id: String,
    /// The successor started from a copy of the old conversation (false: a chat with no
    /// conversation yet, so the successor started fresh).
    pub forked: bool,
    pub moved: Moved,
    pub stays_behind: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Moved {
    pub subs: usize,
    pub remote_subs: usize,
    pub cards: usize,
}

/// What a promote would carry, read before it runs (the dialog's summary).
pub fn preview(state: &DaemonState, chat_id: &str) -> Moved {
    Moved {
        subs: state.registry.list().iter().filter(|i| i.subchat_of.as_deref() == Some(chat_id)).count(),
        remote_subs: super::remote::records::of_main(chat_id).len(),
        cards: super::card_log::read(chat_id).len(),
    }
}

/// The lines that name what a promote does NOT move, so Joe is never surprised later.
pub fn stays_behind(moved: &Moved, forked: bool) -> Vec<String> {
    let mut rows = vec![
        if forked {
            "This chat's own transcript stays in the No project folder; the new main chat starts from a copy of it.".to_string()
        } else {
            "This chat had no conversation yet, so the new main chat starts empty.".to_string()
        },
        "This chat ends here. Any file it wrote in the No project folder stays there.".to_string(),
    ];
    if moved.subs + moved.remote_subs > 0 {
        rows.push("Each sub keeps its own folder and worktree; only who it reports to changes.".to_string());
    }
    rows
}

/// The first message the successor gets. Written by the app, never the old chat.
fn handoff(path: &Path, name: &str, moved: &Moved, forked: bool) -> String {
    let carried = if moved.subs + moved.remote_subs == 0 {
        String::new()
    } else {
        format!(
            " Its {} sub{}, cards, decisions log, Answers and previews moved to you.",
            moved.subs + moved.remote_subs,
            if moved.subs + moved.remote_subs == 1 { "" } else { "s" }
        )
    };
    let history = if forked {
        "The conversation above is the earlier chat's, copied: it ran in the No project folder, so any relative path it used pointed there, not here."
    } else {
        "The earlier chat had no conversation yet."
    };
    format!(
        "Joe turned the earlier chat into the project \"{name}\" ({}). You are now its main chat and run in that folder. {history}{carried} Carry on from where it stopped; do not start over or redo finished work.",
        path.display()
    )
}

/// The project's name: the folder's own name.
fn project_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// Every check that needs no I/O, so a refusal changes nothing.
fn check(state: &DaemonState, chat_id: &str, target: &Path) -> Result<crate::types::Instance, PromoteError> {
    let inst = state.registry.get(chat_id).ok_or_else(|| refused(format!("unknown session: {chat_id}")))?;
    if !matches!(inst.kind, InstanceKind::Interactive) || inst.machine.is_some() {
        return Err(refused("Only a chat on this machine can be turned into a project."));
    }
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(refused("This chat has ended."));
    }
    if super::is_sub(&inst) {
        return Err(refused("A sub cannot be turned into a project. Move it to the sidebar first."));
    }
    if inst.jarvis || inst.worker_of.is_some() {
        return Err(refused("A Jarvis chat cannot be turned into a project."));
    }
    if inst.busy || inst.closing {
        return Err(refused("This chat is in the middle of a turn. Turn it into a project once it is idle."));
    }
    if inst.local_task_running {
        return Err(refused("This chat has a background task running, which ending the chat would stop. Turn it into a project once that is done."));
    }
    if super::put_away::is_gated(state, chat_id) {
        return Err(refused(super::put_away::refusal(chat_id)));
    }
    if crate::settings::identity::project_key(&inst.cwd) == crate::settings::identity::project_key(target) {
        return Err(refused("That is the folder this chat already runs in. Pick another folder."));
    }
    Ok(inst)
}

/// Chats with a promote under way. The spawn and the first send are awaits, so a second
/// call for the same chat would pass `check` too and start a second successor.
static IN_FLIGHT: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Flight(String);

impl Flight {
    fn take(chat_id: &str) -> Option<Flight> {
        let mut held = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
        if held.iter().any(|id| id == chat_id) {
            return None;
        }
        held.push(chat_id.to_string());
        Some(Flight(chat_id.to_string()))
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).retain(|id| id != &self.0);
    }
}

/// The title of the live main chat `folder` already has, when it is an existing project
/// with one. A second main chat there would be unpointed: the pointer keeps the first.
fn existing_main_chat(state: &DaemonState, folder: &Path) -> Option<String> {
    let key = crate::settings::identity::project_key(folder);
    let project = state.settings.snapshot().projects.into_iter().find(|p| crate::settings::identity::project_key(&p.path) == key)?;
    let main = project.main_chat_id?;
    let row = state.registry.get(&main).filter(|i| i.ended_at.is_none() && i.end_reason.is_none())?;
    Some(row.name.filter(|n| !n.trim().is_empty()).unwrap_or(main))
}

/// Every refusal that needs no I/O, so one changes nothing: the chat's state, the target
/// project's main chat and the account.
fn admit(
    state: &DaemonState,
    chat_id: &str,
    folder: &Path,
    accounts: &[crate::accounts::Account],
) -> Result<(crate::types::Instance, crate::sessions::chat_config::ChatConfig, Option<String>), PromoteError> {
    let inst = check(state, chat_id, folder)?;
    if let Some(title) = existing_main_chat(state, folder) {
        return Err(refused(format!(
            "That project already has a main chat, \"{title}\". Pick another folder, or move this chat into that main chat."
        )));
    }
    let inherited = crate::sessions::chat_config::get(chat_id).unwrap_or_default();
    // A main chat never runs on an API-credit account: every sub it starts would spend the credit.
    let account = Some(inherited.account_id.clone()).filter(|a| !a.is_empty()).or_else(|| inst.account_id.clone());
    if let Some(reason) = super::refusal_for_account(account.as_deref(), accounts) {
        return Err(refused(reason));
    }
    Ok((inst, inherited, account))
}

/// Whether the dialog should say the successor starts from a copy of the conversation:
/// the transcript is looked up by id across Claude's project folders, since a chat that
/// was resumed from another folder keeps writing under its first one.
pub fn forks(state: &DaemonState, chat_id: &str) -> bool {
    state.registry.get(chat_id).is_some_and(|i| crate::chat::history::locate_transcript(chat_id, i.cwd.to_str()).is_ok())
}

/// Ends a successor whose child started but whose family never moved.
async fn abandon(state: &Arc<DaemonState>, new_id: &str) {
    let _ = lifecycle::end_session(&state.sessions, new_id).await;
    crate::sessions::chat_config::set_subchats_on(new_id, false);
}

/// Turns `chat_id` into a project's main chat. `folder` is an absolute path; it is
/// created when missing and registered as a project when new.
pub async fn promote_to_project(state: &Arc<DaemonState>, chat_id: &str, folder: &Path) -> Result<Promoted, PromoteError> {
    let _flight = Flight::take(chat_id).ok_or_else(|| refused("This chat is already being turned into a project."))?;
    // Two chats turned into one new folder at once would both pass `admit` (it has no main
    // chat yet) and leave a second, unpointed main chat.
    let _folder = Flight::take(&format!("folder:{}", crate::settings::identity::project_key(folder)))
        .ok_or_else(|| refused("Another chat is being turned into a project in that folder."))?;
    let (inst, inherited, account) = admit(state, chat_id, folder, &crate::accounts::load_registry())?;
    let done = crate::daemon::session_registration::ensure_project_folder(state, folder).await.map_err(refused)?;
    let forked = forks(state, chat_id);
    let new_id = uuid::Uuid::new_v4().to_string();
    // Before the child exists: spawn reads the mode when it builds argv, and a flip
    // made after would leave the successor without the main chat's prompt.
    crate::sessions::chat_config::set_subchats_on(&new_id, true);
    // An unrecorded pair falls back to the spawn default like every respawn does; the
    // spawn refuses an empty model.
    let (model, effort) = super::main_launch(
        &Some(pick(&inherited.model, &inst.model)).filter(|m| !m.is_empty()).unwrap_or_else(|| lifecycle::SPAWN_DEFAULT_MODEL.to_string()),
        &pick(&inherited.effort, &inst.effort),
    );
    let params = StartSessionParams {
        cwd: folder.to_path_buf(),
        model,
        effort,
        resume_id: forked.then(|| chat_id.to_string()),
        account_id: account.clone(),
        fork: forked,
        new_session_id: Some(new_id.clone()),
    };
    let session = match lifecycle::spawn_session(state, params).await {
        Ok(s) => s,
        Err(e) => {
            crate::sessions::chat_config::set_subchats_on(&new_id, false);
            return Err(PromoteError::Failed(e.to_string()));
        }
    };
    // The awaits above can outlast the chat's idleness: a sub finishing wakes it, and
    // ending a busy chat would cut its turn after the fork was taken.
    if let Err(e) = check(state, chat_id, folder).and_then(|_| match existing_main_chat(state, folder) {
        Some(title) => Err(refused(format!("That project got a main chat meanwhile, \"{title}\"."))),
        None => Ok(()),
    }) {
        abandon(state, &new_id).await;
        return Err(e);
    }
    let moved = preview(state, chat_id);
    let text = handoff(folder, &project_name(folder), &moved, forked);
    let send = {
        let session = session.clone();
        async move { lifecycle::send_message(&session, &text, false).await.map_err(|e| e.to_string()) }
    };
    let ctx = Handover { chat_id, new_id: &new_id, folder, project_id: &done.project_id, forked, model: &session.model, effort: &session.effort, account_id: &session.account_id };
    hand_over(state, &inst, &ctx, moved, send).await
}

/// The chat's own choice, else the registry row's.
fn pick(stored: &str, row: &str) -> String {
    if stored.is_empty() { row.to_string() } else { stored.to_string() }
}

struct Handover<'a> {
    chat_id: &'a str,
    new_id: &'a str,
    folder: &'a Path,
    project_id: &'a str,
    forked: bool,
    model: &'a str,
    effort: &'a str,
    /// The account the child actually runs on, which the row must record too: a later
    /// respawn reads it back, and an empty string is not an account.
    account_id: &'a str,
}

/// Everything after the successor's child exists: its row, the family, the first
/// message, the link, the old chat's close. Split from the spawn so the order and the
/// failed-send undo can be tested without a real `claude`.
async fn hand_over(
    state: &Arc<DaemonState>,
    old: &crate::types::Instance,
    c: &Handover<'_>,
    moved: Moved,
    first_send: impl std::future::Future<Output = Result<(), String>>,
) -> Result<Promoted, PromoteError> {
    let now = chrono::Utc::now().to_rfc3339();
    let inherited = crate::sessions::chat_config::get(c.chat_id).unwrap_or_default();
    let character = state.settings.snapshot().session_characters.get(c.chat_id).cloned();
    crate::daemon::session_registration::register_new_session(
        state,
        c.new_id,
        c.folder,
        c.model,
        c.effort,
        c.account_id,
        &now,
        inherited.auto_accept,
        character.as_deref(),
        false,
    );
    if let Some(name) = old.name.clone().filter(|n| !n.trim().is_empty()) {
        state.registry.set_name(c.new_id, name);
    }
    // The mode is already on in chat-config; clients hold the set in memory.
    super::publish_mode_changed(state);
    closing::carry_window_stores(state, c.chat_id, c.new_id);
    closing::move_family(state, c.chat_id, c.new_id).await;

    if let Err(e) = first_send.await {
        // The family goes back before the successor goes, so nothing is ever left
        // pointing at a row that is ending.
        closing::move_family(state, c.new_id, c.chat_id).await;
        closing::carry_window_stores(state, c.new_id, c.chat_id);
        let _ = lifecycle::end_session(&state.sessions, c.new_id).await;
        state.registry.mark_ended(c.new_id, crate::types::EndReason::Manual, &chrono::Utc::now().to_rfc3339());
        crate::sessions::chat_config::set_subchats_on(c.new_id, false);
        super::publish_mode_changed(state);
        crate::daemon::machines::publish_instances_changed(state);
        crate::sessions::persistence::save_snapshot_default(&state.registry);
        return Err(PromoteError::Failed(e));
    }

    if state.draft_store.move_held(c.chat_id, c.new_id) > 0 {
        crate::daemon::methods::drafts::sync_held_count(state, c.chat_id);
        crate::daemon::methods::drafts::sync_held_count(state, c.new_id);
    }
    // The pane follows this link, and `live_successor` is what lets the close below
    // settle the family onto the successor instead of moving the subs to the sidebar.
    state.registry.set_successor_of(c.new_id, c.chat_id);
    // A fork already holds the whole conversation; a predecessor link would make the
    // history continue into the old transcript and show it twice.
    if !c.forked {
        crate::sessions::chat_config::set_predecessor(c.new_id, c.chat_id);
    }
    state.registry.set_awaiting(c.new_id, None);
    state.registry.set_busy(c.new_id, true);
    crate::sessions::chat_state::set_busy(c.new_id, true);
    crate::daemon::subchats::joe_message::forget(c.new_id);
    // The old chat ends: its conversation lives on in the fork, and a chat left open in
    // the No project folder would be a second copy of the same work.
    closing::complete(state, c.chat_id).await;
    super::main_pointer::reconcile(state);
    Ok(Promoted {
        project_id: c.project_id.to_string(),
        project_path: c.folder.to_string_lossy().into_owned(),
        successor_id: c.new_id.to_string(),
        forked: c.forked,
        stays_behind: stays_behind(&moved, c.forked),
        moved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{store_sub_brief, TempDataDir};
    use crate::settings::identity::test_support::non_ephemeral_tempdir;
    use crate::types::Settings;

    const AT: &str = "2026-11-22T09:00:00Z";

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// The "No project" chat's folder: the repo's own folder, a stand-in that is a real project.
    fn vault() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    /// A main chat in the vault project with two subs, one finished.
    fn scratch_family(st: &DaemonState, id: &str) -> (String, Vec<String>) {
        let (vault_project, _) = crate::daemon::session_registration::register_project(st, &vault(), AT);
        st.registry.upsert_interactive(id, &vault(), &vault_project, AT);
        st.registry.set_name(id, "Scratch work".to_string());
        crate::sessions::chat_config::set_subchats_on(id, true);
        st.settings.set_project_main_chat(&vault_project, Some(id));
        let mut subs = Vec::new();
        for (n, finished) in [("a", false), ("b", true)] {
            let sid = format!("{id}-{n}");
            st.registry.upsert_interactive(&sid, &vault(), &vault_project, AT);
            st.registry.set_subchat_of(&sid, Some(id.to_string()));
            st.registry.set_subchat_finished(&sid, finished);
            store_sub_brief(&sid, id);
            subs.push(sid);
        }
        (vault_project, subs)
    }

    fn handover<'a>(chat: &'a str, new: &'a str, folder: &'a Path, project: &'a str) -> Handover<'a> {
        Handover { chat_id: chat, new_id: new, folder, project_id: project, forked: true, model: "sonnet", effort: "high", account_id: "acct" }
    }

    fn pointer(st: &DaemonState, project: &str) -> Option<String> {
        st.settings.snapshot().projects.into_iter().find(|p| p.id == project).and_then(|p| p.main_chat_id)
    }

    #[tokio::test]
    async fn the_family_the_stores_and_the_pointer_follow_the_chat_into_the_new_project() {
        let _data = TempDataDir::new();
        let st = state();
        let (vault_project, subs) = scratch_family(&st, "pj-main");
        let folder = non_ephemeral_tempdir();
        let old = st.registry.get("pj-main").unwrap();

        // The caller switches the mode on before the spawn (the child reads it for its prompt).
        crate::sessions::chat_config::set_subchats_on("pj-next", true);
        let done = hand_over(&st, &old, &handover("pj-main", "pj-next", folder.path(), "ignored"), preview(&st, "pj-main"), async { Ok(()) })
            .await
            .unwrap();

        assert_eq!(done.moved.subs, 2);
        for s in &subs {
            assert_eq!(st.registry.get(s).unwrap().subchat_of.as_deref(), Some("pj-next"), "{s} reports to the successor");
        }
        let new_row = st.registry.get("pj-next").unwrap();
        assert_eq!(new_row.name.as_deref(), Some("Scratch work"), "the pane shows the same title");
        assert_ne!(new_row.project_id, vault_project, "the successor lives in the new project");
        assert_eq!(new_row.successor_of.as_deref(), Some("pj-main"), "the pane follows the link");
        assert_eq!(new_row.account_id.as_deref(), Some("acct"), "the row records the account the child runs on");
        assert_eq!(crate::sessions::chat_config::predecessor_of("pj-next"), None, "a fork holds the history: no continuation link");
        assert!(st.registry.get("pj-main").unwrap().ended_at.is_some(), "the old chat ends: its work lives in the fork");
        assert_eq!(pointer(&st, &new_row.project_id).as_deref(), Some("pj-next"), "the new project's main chat is the successor");
        assert_ne!(pointer(&st, &vault_project).as_deref(), Some("pj-main"), "the vault no longer points at an ended chat");
    }

    #[tokio::test]
    async fn a_fresh_start_successor_continues_its_history_from_the_old_chat() {
        let _data = TempDataDir::new();
        let st = state();
        scratch_family(&st, "pj-fresh");
        let folder = non_ephemeral_tempdir();
        let old = st.registry.get("pj-fresh").unwrap();
        crate::sessions::chat_config::set_subchats_on("pj-fresh-next", true);
        let mut c = handover("pj-fresh", "pj-fresh-next", folder.path(), "p");
        c.forked = false;
        hand_over(&st, &old, &c, Moved::default(), async { Ok(()) }).await.unwrap();
        assert_eq!(crate::sessions::chat_config::predecessor_of("pj-fresh-next").as_deref(), Some("pj-fresh"));
    }

    #[tokio::test]
    async fn the_decisions_log_moves_with_the_family() {
        let _data = TempDataDir::new();
        let st = state();
        scratch_family(&st, "pj-stores");
        let root = crate::settings::paths::data_dir().unwrap().join("subchats");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pj-stores.decisions.md"), "- D1 use sqlite\n").unwrap();
        let folder = non_ephemeral_tempdir();
        let old = st.registry.get("pj-stores").unwrap();

        hand_over(&st, &old, &handover("pj-stores", "pj-stores-next", folder.path(), "p"), Moved::default(), async { Ok(()) })
            .await
            .unwrap();

        assert!(root.join("pj-stores-next.decisions.md").exists(), "the decisions log follows");
        assert!(!root.join("pj-stores.decisions.md").exists());
    }

    #[tokio::test]
    async fn a_failed_first_send_puts_everything_back_and_ends_the_successor() {
        let _data = TempDataDir::new();
        let st = state();
        let (vault_project, subs) = scratch_family(&st, "pj-fail");
        let root = crate::settings::paths::data_dir().unwrap().join("subchats");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pj-fail.decisions.md"), "- D1 keep\n").unwrap();
        let folder = non_ephemeral_tempdir();
        let old = st.registry.get("pj-fail").unwrap();
        // The caller switches the mode on before the spawn; the undo must switch it off.
        crate::sessions::chat_config::set_subchats_on("pj-fail-next", true);

        let e = hand_over(&st, &old, &handover("pj-fail", "pj-fail-next", folder.path(), "p"), preview(&st, "pj-fail"), async {
            Err("the child died".to_string())
        })
        .await
        .unwrap_err();

        assert!(matches!(e, PromoteError::Failed(_)), "{e:?}");
        for s in &subs {
            assert_eq!(st.registry.get(s).unwrap().subchat_of.as_deref(), Some("pj-fail"), "{s} is back under the old chat");
        }
        assert!(root.join("pj-fail.decisions.md").exists(), "the decisions log is back");
        assert!(st.registry.get("pj-fail").unwrap().ended_at.is_none(), "the old chat is untouched");
        let next = st.registry.get("pj-fail-next").unwrap();
        assert!(next.ended_at.is_some(), "the successor does not linger");
        assert_ne!(pointer(&st, &next.project_id).as_deref(), Some("pj-fail-next"), "the new project does not point at the ended successor");
        assert_eq!(pointer(&st, &vault_project).as_deref(), Some("pj-fail"), "the vault keeps its main chat");
        assert!(!crate::sessions::chat_config::get("pj-fail-next").is_some_and(|c| c.subchats_on), "the successor is not left a main chat");
    }

    #[tokio::test]
    async fn only_an_idle_open_chat_in_another_folder_can_be_turned_into_a_project() {
        let _data = TempDataDir::new();
        let st = state();
        scratch_family(&st, "pj-check");
        let elsewhere = non_ephemeral_tempdir();

        assert!(check(&st, "pj-check", elsewhere.path()).is_ok());
        let same = check(&st, "pj-check", &vault()).unwrap_err().to_string();
        assert!(same.contains("already runs in"), "{same}");
        let sub = check(&st, "pj-check-a", elsewhere.path()).unwrap_err().to_string();
        assert!(sub.contains("sub"), "{sub}");
        assert!(check(&st, "ghost", elsewhere.path()).is_err());
        st.registry.set_busy("pj-check", true);
        let busy = check(&st, "pj-check", elsewhere.path()).unwrap_err().to_string();
        assert!(busy.contains("middle of a turn"), "{busy}");
        st.registry.set_busy("pj-check", false);
        st.registry.mark_ended("pj-check", crate::types::EndReason::Manual, AT);
        assert!(check(&st, "pj-check", elsewhere.path()).is_err(), "an ended chat has nothing to promote");
    }

    #[tokio::test]
    async fn a_put_away_main_chat_is_refused() {
        let _data = TempDataDir::new();
        let st = state();
        scratch_family(&st, "pj-away");
        super::super::put_away::put_away(&st, "pj-away", Vec::new(), AT).unwrap();
        let e = check(&st, "pj-away", non_ephemeral_tempdir().path()).unwrap_err().to_string();
        assert!(e.starts_with(super::super::put_away::REFUSAL_PREFIX), "{e}");
    }

    #[test]
    fn a_second_promote_of_the_same_chat_is_refused_while_the_first_runs() {
        let first = Flight::take("fl-chat").unwrap();
        assert!(Flight::take("fl-chat").is_none());
        assert!(Flight::take("fl-other").is_some(), "another chat is free");
        drop(first);
        assert!(Flight::take("fl-chat").is_some(), "the slot opens when the first ends, however it ended");
    }

    #[tokio::test]
    async fn a_project_that_already_has_a_live_main_chat_is_refused_and_one_without_is_not() {
        let _data = TempDataDir::new();
        let st = state();
        scratch_family(&st, "pj-has");
        // The vault folder is itself a project whose pointer names pj-has.
        assert_eq!(existing_main_chat(&st, &vault()).as_deref(), Some("Scratch work"));
        let other = non_ephemeral_tempdir();
        st.registry.upsert_interactive("pj-visitor", other.path(), "elsewhere", AT);
        let refusal = admit(&st, "pj-visitor", &vault(), &[]).unwrap_err().to_string();
        assert!(refusal.contains("already has a main chat"), "{refusal}");
        assert_eq!(existing_main_chat(&st, other.path()), None, "a folder that is no project yet has none");
        st.registry.mark_ended("pj-has", crate::types::EndReason::Manual, AT);
        assert_eq!(existing_main_chat(&st, &vault()), None, "an ended main chat does not count");
    }

    #[tokio::test]
    async fn an_api_credit_chat_is_refused_before_anything_starts() {
        use crate::accounts::{Account, AccountKind};
        let _data = TempDataDir::new();
        let st = state();
        scratch_family(&st, "pj-credit");
        st.registry.set_account("pj-credit", "credit");
        let account = |kind| Account {
            id: "credit".into(),
            label: "credit".into(),
            colour: "#fff".into(),
            icon: "key".into(),
            config_dir: std::path::PathBuf::from("C:/home/.claude-x"),
            chrome_profile_dir: std::path::PathBuf::from("C:/appdata/chrome-profiles/x"),
            email: String::new(),
            org_uuid: "ORG".into(),
            subscription_tier: String::new(),
            created_at: "2026-11-04T00:00:00Z".into(),
            fleet_eligible: false,
            kind,
            endpoint: None,
        };
        let elsewhere = non_ephemeral_tempdir();
        let refusal = admit(&st, "pj-credit", elsewhere.path(), &[account(AccountKind::ApiCredit)]).unwrap_err().to_string();
        assert!(refusal.contains("API-credit"), "{refusal}");
        assert!(admit(&st, "pj-credit", elsewhere.path(), &[account(AccountKind::Subscription)]).is_ok());
    }

    #[test]
    fn the_handoff_names_the_project_the_old_folder_and_what_moved() {
        let moved = Moved { subs: 2, remote_subs: 1, cards: 4 };
        let text = handoff(Path::new("C:/code/shop"), "shop", &moved, true);
        assert!(text.contains("\"shop\"") && text.contains("C:/code/shop"), "{text}");
        assert!(text.contains("3 subs"), "{text}");
        assert!(text.contains("No project folder"), "{text}");
        let plain = handoff(Path::new("C:/code/shop"), "shop", &Moved::default(), false);
        assert!(!plain.contains("moved to you") && plain.contains("no conversation yet"), "{plain}");
    }

    #[test]
    fn what_stays_behind_is_named_and_a_sub_less_chat_says_nothing_about_subs() {
        let with_subs = stays_behind(&Moved { subs: 1, remote_subs: 0, cards: 0 }, true).join(" ");
        assert!(with_subs.contains("transcript stays") && with_subs.contains("own folder"), "{with_subs}");
        let none = stays_behind(&Moved::default(), false).join(" ");
        assert!(!none.contains("sub") && none.contains("no conversation yet"), "{none}");
    }
}
