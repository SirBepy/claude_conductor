//! `dashboard_snapshot`: everything the dashboard paints except the transcript
//! mining. Kept fast on purpose: git runs concurrently across repos, and no
//! transcript is replayed (the recent-chats list reads titles from the cached
//! history scan only).

use super::cards;
use super::gather::{gather, Gathered, LiveChat};
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::history_scan::project_dir_slug;
use crate::project_dashboard::plan::{read_plan, PLAN_CAP};
use crate::project_dashboard::snapshot_parts::{
    draft_is_open, draft_item, newest_note, scheduled_row, soonest_scheduled,
};
use crate::project_dashboard::targets::{chat_in_repo, resolve_target};
use crate::project_dashboard::{
    store, CommitRow, DashChatRow, DashTodo, DashboardSnapshot, DashboardTarget, DashboardTargetRef, NeedsYouItem,
    PlanItem, RepoRef, RepoShip, Scope, ScheduledRow, ServerRow,
};
use crate::sessions::user_todos::TodoState;
use crate::sessions::{message_drafts, repo_channel, scheduled_items, user_todos};
use std::collections::HashSet;
use std::sync::Arc;

const RECENT_CHATS: usize = 6;
const RECENT_COMMITS: u32 = 4;

/// Sort key for the running list: what needs the dev first.
fn status_rank(status: &str) -> u8 {
    match status {
        "question" => 0,
        "working" => 1,
        "waiting" => 2,
        _ => 3,
    }
}

/// Which repo of the target a live chat belongs to, if any.
fn repo_of<'a>(chat: &LiveChat, repos: &'a [RepoRef]) -> Option<&'a RepoRef> {
    repos.iter().find(|r| chat_in_repo(&chat.inst.project_id, &chat.inst.cwd.to_string_lossy(), r))
}

/// Running chats and the questions among them, in one pass over the registry.
fn live_rows(repos: &[RepoRef], live: &[LiveChat]) -> (Vec<DashChatRow>, Vec<NeedsYouItem>) {
    let mut running = Vec::new();
    let mut questions = Vec::new();
    for chat in live {
        let Some(repo) = repo_of(chat, repos) else { continue };
        running.push(DashChatRow {
            session_id: chat.inst.session_id.clone(),
            title: chat.title(),
            status: chat.status.to_string(),
            repo_cwd: repo.cwd.clone(),
            at_ms: chat.at_ms(),
        });
        if chat.status == "question" {
            questions.push(NeedsYouItem {
                kind: "question".into(),
                title: chat.title(),
                detail: chat.prompt_detail.clone().unwrap_or_else(|| "Asked you a question".to_string()),
                session_id: Some(chat.inst.session_id.clone()),
                draft_id: None,
                repo_cwd: repo.cwd.clone(),
                at_ms: chat.at_ms(),
            });
        }
    }
    running.sort_by(|a, b| status_rank(&a.status).cmp(&status_rank(&b.status)).then(b.at_ms.cmp(&a.at_ms)));
    questions.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    (running, questions)
}

/// The stored, file-backed rows. Plain blocking reads, so the caller runs this
/// on the blocking pool.
struct StoredRows {
    todos: Vec<DashTodo>,
    drafts: Vec<NeedsYouItem>,
    plan: Vec<PlanItem>,
    scheduled: Vec<ScheduledRow>,
    note: Option<crate::project_dashboard::ChannelNote>,
    recent: Vec<DashChatRow>,
}

fn read_stored(repos: &[RepoRef], live_ids: &HashSet<String>, live_in_target: usize, now_ms: i64) -> StoredRows {
    let mut todos = Vec::new();
    let mut drafts = Vec::new();
    let mut plan = Vec::new();
    let mut channel = Vec::new();
    for repo in repos {
        plan.extend(read_plan(&repo.cwd));
        let Some(pid) = &repo.project_id else { continue };
        for t in user_todos::list(pid).into_iter().filter(|t| t.state == TodoState::Open) {
            todos.push(DashTodo {
                id: t.id,
                project_id: pid.clone(),
                text: t.text,
                origin_session_id: Some(t.origin_session_id).filter(|s| !s.is_empty()),
                repo_cwd: repo.cwd.clone(),
                by_ai: t.by_ai,
            });
        }
        drafts.extend(
            message_drafts::list(pid)
                .iter()
                .filter(|d| draft_is_open(d, now_ms))
                .map(|d| draft_item(d, &repo.cwd)),
        );
        channel.extend(repo_channel::list_all(pid));
    }
    drafts.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    // Priority items first across repos; `sort_by_key` is stable so each
    // repo's own file order survives within a band.
    plan.sort_by_key(|p| !p.priority);
    plan.truncate(PLAN_CAP);
    let scheduled = soonest_scheduled(
        scheduled_items::list().iter().filter_map(|i| scheduled_row(i, repos)).collect(),
    );
    StoredRows {
        todos,
        drafts,
        plan,
        scheduled,
        note: newest_note(channel),
        recent: recent_chats(repos, live_ids, live_in_target),
    }
}

/// The newest ended chats across the repos. Asks each repo for extra rows to
/// cover the live chats that will be filtered back out.
fn recent_chats(repos: &[RepoRef], live_ids: &HashSet<String>, live_in_target: usize) -> Vec<DashChatRow> {
    let Some(projects_dir) = crate::tokens::claude_projects_dir() else { return Vec::new() };
    let limit = (RECENT_CHATS + live_in_target).min(40) as u32;
    let mut rows: Vec<DashChatRow> = Vec::new();
    for repo in repos {
        let slug = project_dir_slug(&projects_dir, &repo.cwd);
        let entries = crate::ipc::chat::history::collect_history(&projects_dir, Some(slug), None, limit, 0, None, None, None);
        rows.extend(entries.into_iter().filter(|e| !live_ids.contains(&e.session_id)).map(|e| DashChatRow {
            session_id: e.session_id,
            title: e.title,
            status: "ended".into(),
            repo_cwd: repo.cwd.clone(),
            at_ms: e.ended_at.unwrap_or(e.started_at) * 1000,
        }));
    }
    rows.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    rows.truncate(RECENT_CHATS);
    rows
}

/// Maps git's answers onto one ship row. A folder that is not a repo answers
/// with `None`/empty everywhere, which becomes an empty branch and zeros.
fn ship_row(
    repo: &RepoRef,
    info: crate::ipc::git::GitInfo,
    dirty: Vec<String>,
    history: crate::ipc::git::CommitHistory,
) -> RepoShip {
    RepoShip {
        cwd: repo.cwd.clone(),
        name: repo.name.clone(),
        branch: info.branch.unwrap_or_default(),
        ahead: info.ahead.unwrap_or(0),
        behind: info.behind.unwrap_or(0),
        has_upstream: history.has_upstream,
        dirty_count: dirty.len() as u32,
        recent_commits: history
            .entries
            .into_iter()
            .map(|c| CommitRow {
                short_sha: c.short_sha,
                message: c.message,
                timestamp_ms: c.timestamp * 1000,
                pushed: c.pushed,
            })
            .collect(),
    }
}

async fn ship_for_repo(repo: RepoRef) -> RepoShip {
    use crate::ipc::git::{get_commit_history_local, get_git_dirty_local, get_git_info_local};
    let (info, dirty, history) = tokio::join!(
        get_git_info_local(repo.cwd.clone()),
        get_git_dirty_local(repo.cwd.clone()),
        get_commit_history_local(repo.cwd.clone(), 0, RECENT_COMMITS),
    );
    ship_row(&repo, info, dirty, history)
}

async fn servers_for_repo(repo: RepoRef) -> Vec<ServerRow> {
    crate::ipc::servers::list_project_servers(repo.cwd.clone())
        .await
        .into_iter()
        .map(|s| ServerRow { name: s.name, port: s.port, repo_cwd: repo.cwd.clone() })
        .collect()
}

fn scope_of(target: &DashboardTarget) -> Scope {
    match target.kind.as_str() {
        "group" => Scope::Group { id: target.id.clone() },
        _ => Scope::Project { cwd: target.id.clone() },
    }
}

/// A project's dashboard shows its own cards plus those of every group that
/// lists it; a group shows only its own.
fn cards_for_target(target: &DashboardTarget, st: &store::DashboardStore) -> Vec<crate::project_dashboard::CardView> {
    let mut scopes = vec![scope_of(target)];
    if target.kind == "project" {
        scopes.extend(
            st.groups
                .iter()
                .filter(|g| store::contains_path(&g.repos, &target.id))
                .map(|g| Scope::Group { id: g.id.clone() }),
        );
    }
    let mut seen = HashSet::new();
    let cards = scopes
        .iter()
        .flat_map(|s| st.cards_for(s))
        .filter(|c| seen.insert(c.id.clone()))
        .collect();
    cards::views(cards, &store::all_results())
}

pub(super) async fn snapshot(state: &Arc<DaemonState>, target_ref: DashboardTargetRef) -> Result<DashboardSnapshot, RpcError> {
    let Gathered { groups, projects, live, now_ms } = gather(state).await;
    let target = resolve_target(&target_ref, &groups, &projects)
        .ok_or_else(|| RpcError::invalid_params(format!("unknown {} dashboard: {}", target_ref.kind, target_ref.id)))?;

    let (chats_running, questions) = live_rows(&target.repos, &live);
    let live_ids: HashSet<String> = live.iter().map(|c| c.inst.session_id.clone()).collect();

    let stored = {
        let repos = target.repos.clone();
        let live_in_target = chats_running.len();
        tokio::task::spawn_blocking(move || read_stored(&repos, &live_ids, live_in_target, now_ms))
    };
    let ship = futures_util::future::join_all(target.repos.iter().cloned().map(ship_for_repo));
    let servers = futures_util::future::join_all(target.repos.iter().cloned().map(servers_for_repo));
    let (stored, ship, servers) = tokio::join!(stored, ship, servers);
    let stored = stored.map_err(|e| RpcError::internal(format!("join: {e}")))?;

    let st = store::load();
    let mut needs_you = questions;
    needs_you.extend(stored.drafts);
    Ok(DashboardSnapshot {
        needs_you,
        your_todos: stored.todos,
        peers_active: chats_running.len() as u32,
        chats_running,
        chats_recent: stored.recent,
        plan: stored.plan,
        scheduled: stored.scheduled,
        ship,
        servers: servers.into_iter().flatten().collect(),
        last_channel_message: stored.note,
        cards: cards_for_target(&target, &st),
        hidden_builtins: st.hidden_builtins.get(&scope_of(&target).scope_key()).cloned().unwrap_or_default(),
        target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::git::{CommitHistory, CommitHistoryEntry, GitInfo};
    use crate::project_dashboard::{CardConfig, GroupDef};

    fn repo(cwd: &str) -> RepoRef {
        RepoRef { cwd: cwd.into(), name: "app".into(), project_id: Some("p1".into()) }
    }

    fn chat(sid: &str, project_id: &str, cwd: &str, awaiting: Option<&str>, busy: bool, prompt: Option<&str>) -> LiveChat {
        let mut inst = blank_instance(sid, project_id, cwd);
        inst.awaiting = awaiting.map(str::to_string);
        inst.busy = busy;
        let status = crate::project_dashboard::snapshot_parts::chat_status(awaiting, busy, prompt.is_some());
        LiveChat { inst, status, prompt_detail: prompt.map(str::to_string) }
    }

    fn blank_instance(sid: &str, project_id: &str, cwd: &str) -> crate::types::Instance {
        let reg = crate::sessions::registry::Registry::new();
        reg.upsert_interactive(sid, std::path::Path::new(cwd), project_id, "2026-10-22T10:00:00Z");
        reg.get(sid).expect("just upserted")
    }

    #[test]
    fn running_chats_sort_questions_first_and_questions_feed_needs_you() {
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let c = uuid::Uuid::new_v4().to_string();
        let live = vec![
            chat(&a, "p1", "C:/w/app", None, false, None),
            chat(&b, "p1", "C:/w/app", None, true, None),
            chat(&c, "p1", "C:/w/app", Some("question"), false, Some("Ship it?")),
        ];
        let (running, questions) = live_rows(&[repo("C:/w/app")], &live);
        let order: Vec<&str> = running.iter().map(|r| r.status.as_str()).collect();
        assert_eq!(order, ["question", "working", "your_turn"]);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].detail, "Ship it?");
        assert_eq!(questions[0].session_id.as_deref(), Some(c.as_str()));
    }

    #[test]
    fn chats_outside_the_target_are_left_out() {
        let a = uuid::Uuid::new_v4().to_string();
        let live = vec![chat(&a, "p9", "C:/elsewhere", None, true, None)];
        let (running, questions) = live_rows(&[repo("C:/w/app")], &live);
        assert!(running.is_empty() && questions.is_empty());
    }

    #[test]
    fn a_question_without_a_prompt_still_gets_a_generic_detail() {
        let a = uuid::Uuid::new_v4().to_string();
        let live = vec![chat(&a, "p1", "C:/w/app", Some("question"), false, None)];
        let (_, questions) = live_rows(&[repo("C:/w/app")], &live);
        assert_eq!(questions[0].detail, "Asked you a question");
    }

    #[test]
    fn ship_row_maps_git_answers_and_converts_seconds_to_ms() {
        let info = GitInfo {
            branch: Some("main".into()),
            repo: None,
            ahead: Some(2),
            behind: Some(1),
            sha: None,
            insertions: None,
            deletions: None,
        };
        let history = CommitHistory {
            entries: vec![CommitHistoryEntry { short_sha: "abc1234".into(), message: "FIX: x".into(), pushed: false, timestamp: 1_700_000_000 }],
            has_more: false,
            has_upstream: true,
        };
        let row = ship_row(&repo("C:/w/app"), info, vec!["a".into(), "b".into(), "c".into()], history);
        assert_eq!((row.branch.as_str(), row.ahead, row.behind, row.dirty_count), ("main", 2, 1, 3));
        assert!(row.has_upstream);
        assert_eq!(row.recent_commits[0].timestamp_ms, 1_700_000_000_000);
        assert!(!row.recent_commits[0].pushed);
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_git_repo_yields_an_empty_branch_and_zeros() {
        let dir = tempfile::tempdir().unwrap();
        let r = RepoRef { cwd: dir.path().to_string_lossy().into_owned(), name: "scratch".into(), project_id: None };
        let row = ship_for_repo(r).await;
        assert_eq!(row.branch, "");
        assert_eq!((row.ahead, row.behind, row.dirty_count), (0, 0, 0));
        assert!(!row.has_upstream);
        assert!(row.recent_commits.is_empty());
    }

    #[tokio::test]
    async fn a_missing_folder_is_not_an_error_either() {
        let r = RepoRef { cwd: "C:/definitely/not/here".into(), name: "ghost".into(), project_id: None };
        let row = ship_for_repo(r).await;
        assert_eq!(row.branch, "");
        assert_eq!(row.dirty_count, 0);
    }

    fn target(kind: &str, id: &str) -> DashboardTarget {
        DashboardTarget { kind: kind.into(), id: id.into(), name: "t".into(), repos: vec![] }
    }

    fn card(id: &str, scope: Scope) -> CardConfig {
        CardConfig { id: id.into(), scope, title: id.into(), enabled: true, ..Default::default() }
    }

    #[test]
    fn a_project_sees_its_own_cards_plus_its_groups_but_a_group_sees_only_its_own() {
        let mut st = store::DashboardStore::default();
        st.groups.push(GroupDef { id: "g1".into(), repos: vec!["C:\\w\\app".into()], ..Default::default() });
        st.groups.push(GroupDef { id: "g2".into(), repos: vec!["C:/w/other".into()], ..Default::default() });
        st.cards.push(card("mine", Scope::Project { cwd: "C:/w/app".into() }));
        st.cards.push(card("shared", Scope::Group { id: "g1".into() }));
        st.cards.push(card("foreign-group", Scope::Group { id: "g2".into() }));
        st.cards.push(card("foreign-project", Scope::Project { cwd: "C:/w/other".into() }));

        let ids = |v: Vec<crate::project_dashboard::CardView>| {
            let mut ids: Vec<String> = v.into_iter().map(|c| c.config.id).collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(cards_for_target(&target("project", "c:/w/app"), &st)), ["mine", "shared"]);
        assert_eq!(ids(cards_for_target(&target("group", "g1"), &st)), ["shared"]);
    }

    #[test]
    fn scope_of_a_target_matches_its_kind() {
        assert_eq!(scope_of(&target("group", "g1")), Scope::Group { id: "g1".into() });
        assert_eq!(scope_of(&target("project", "C:/w")), Scope::Project { cwd: "C:/w".into() });
    }

    /// Real git, plan, servers and transcripts for the repo named by `DASH_REPO`,
    /// against an empty app-data dir (so the stores are untouched). Run by hand
    /// with `--ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_snapshot() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", tmp.path());
        let cwd = std::env::var("DASH_REPO").unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        let (pid, _) = state.settings.upsert_project_for_cwd(std::path::Path::new(&cwd), "2026-10-22T00:00:00Z");
        state.registry.upsert_interactive("live-1", std::path::Path::new(&cwd), &pid, "2026-10-22T00:00:00Z");
        let t = std::time::Instant::now();
        let snap = snapshot(&state, DashboardTargetRef { kind: "project".into(), id: cwd.clone() }).await.unwrap();
        println!("snapshot took {:?}", t.elapsed());
        println!("{}", serde_json::to_string_pretty(&snap).unwrap());
    }
}
