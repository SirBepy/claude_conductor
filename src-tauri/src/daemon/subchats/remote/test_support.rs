//! Fixtures the remote-sub tests share: a home repo, a clone standing in for the
//! host's checkout (both with the same origin URL, which is how a host project is
//! matched), a daemon state that has the clone registered as a project, and a
//! router call made as a given transport.

use crate::daemon::rpc::{ConnectionContext, Request, Response, Router, Transport};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::Settings;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The origin both clones carry, in a form `normalize_origin` reads.
pub const ORIGIN: &str = "https://github.com/sirbepy/scratch.git";

pub fn git(dir: &Path, args: &[&str]) {
    super::super::git::test_repo::git(dir, args);
}

/// Commits `file` with `body` in `root` and returns the new commit.
pub fn commit(root: &Path, file: &str, body: &str) -> String {
    std::fs::write(root.join(file), body).unwrap();
    git(root, &["add", file]);
    git(root, &["commit", "-q", "-m", file]);
    super::git_sync::resolve_commit(root, "HEAD").unwrap()
}

pub struct Pair {
    _home_dir: tempfile::TempDir,
    pub home: PathBuf,
    _host_dir: tempfile::TempDir,
    pub host: PathBuf,
}

/// A home repo and a clone of it: the host starts behind by whatever the home commits next.
pub fn pair() -> Pair {
    let (home_dir, home) = super::super::git::test_repo::init();
    git(&home, &["remote", "add", "origin", ORIGIN]);
    let host_dir = tempfile::tempdir().unwrap();
    let host = std::fs::canonicalize(host_dir.path()).unwrap().join("clone");
    // `canonicalize` gives `\\?\C:\...` on Windows, which `git clone` cannot read as a source.
    let plain = home.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    git(host_dir.path(), &["clone", "-q", &plain, "clone"]);
    git(&host, &["remote", "set-url", "origin", ORIGIN]);
    git(&host, &["config", "user.email", "t@example.com"]);
    git(&host, &["config", "user.name", "t"]);
    git(&host, &["config", "commit.gpgsign", "false"]);
    Pair { _home_dir: home_dir, home, _host_dir: host_dir, host }
}

pub fn project_at(path: &Path) -> crate::types::ProjectConfig {
    crate::types::ProjectConfig {
        id: format!("proj-{}", path.display()),
        path: path.to_path_buf(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "proj".into()),
        avatar: crate::types::Avatar::None,
        created_at: "2026-11-15T00:00:00Z".into(),
        last_active_at: None,
        whitelist: Default::default(),
        preferred_account_id: None,
        last_worktree_path: None,
        last_start_folder_rel: None,
        claude_ai_connectors: false,
        mcp_servers: Vec::new(),
        tracker: None,
        keep_running_in_gaming_mode: false,
        default_model: None,
        default_effort: None,
        subchat_check: Default::default(),
        subchat_writers: Default::default(),
        main_chat_id: None,
        broker_services: None,
    }
}

/// A daemon state whose settings register `projects`.
pub fn state_with_projects(projects: &[&Path]) -> Arc<DaemonState> {
    let mut settings = Settings::default();
    settings.projects = projects.iter().map(|p| project_at(p)).collect();
    DaemonState::new(new_session_map(), SettingsCache::new(settings))
}

/// One router call made as `transport` (`None` is the desktop pipe).
pub async fn call(router: &Router, transport: Option<Transport>, method: &str, params: Value) -> Response {
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let ctx = match transport {
        Some(t) => crate::daemon::rpc::TRANSPORT.scope(t, async { ConnectionContext::new(tx) }).await,
        None => ConnectionContext::new(tx),
    };
    router.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) }, ctx).await
}

pub fn peer(id: &str) -> Option<Transport> {
    Some(Transport::PeerMachine(id.into()))
}

/// A stored-brief JSON for a sub the way the home's `plan` would compose it.
pub fn brief(writes: bool, parent: &str) -> Value {
    json!({
        "parent": parent, "task": "Build the thing", "goal": "Because", "done_when": "It works",
        "writes": writes, "files": if writes { vec!["a.txt"] } else { vec![] },
        "report_back": false, "review": true
    })
}
