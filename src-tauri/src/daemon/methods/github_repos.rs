//! RPCs behind "add a project from GitHub" in the new-chat project picker:
//! `github_search_repos` (the dev's own repos first, then all public) and
//! `github_clone_repo` (clone into the projects root and register it).
//!
//! Everything goes through the `gh` CLI, so there is no token handling of our
//! own. Each signed-in `gh` account is queried with its own `GH_TOKEN` set on
//! the child process, never via `gh auth switch`: the active account is shared
//! machine state other tools and sessions read, and flipping it for a search
//! would race them.
//!
//! The phone reaches both RPCs (`P` in `remote_transport_table`). It sends a
//! `full_name` and never a path: the destination is `<projects root>/<repo>`,
//! resolved server-side the same way `create_project_folder` does it.

use crate::daemon::methods::create_project::{is_valid_project_name, resolve_projects_root};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Same key `create_project.rs` and `projects-root.ts` use, so a root set on
/// the desktop is the root a clone lands in.
const PROJECTS_ROOT_SETTINGS_KEY: &str = "newProjectLastParent";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(40);
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);
/// A typed-ahead search re-runs on every Enter; the per-account repo listing is
/// the slow part (paginated, one process per account), so it is kept briefly.
const LISTING_TTL: Duration = Duration::from_secs(60);
const MAX_RESULTS: usize = 30;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct RepoHit {
    pub full_name: String,
    pub description: String,
    pub private: bool,
    /// The `gh` login that can see this repo; empty for a public-search hit.
    pub account: String,
    pub stars: Option<u64>,
    /// Existing checkout of this repo under the projects root, if any.
    pub on_disk: Option<String>,
}

/// `owner/repo`, each half limited to what GitHub allows. Rejects anything
/// that could be read as a flag (`-x/y`) or a path piece before it reaches a
/// command line.
pub(crate) fn split_full_name(full: &str) -> Option<(&str, &str)> {
    let (owner, repo) = full.split_once('/')?;
    let ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (ok(owner) && ok(repo)).then_some((owner, repo))
}

/// Logins with a working token, in `gh auth status` order (the active one
/// first, which is the one a duplicate repo should be attributed to).
pub(crate) fn parse_accounts(status_json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(status_json) else { return Vec::new() };
    let mut out: Vec<(bool, String)> = v["hosts"]["github.com"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|e| e["state"] == "success")
                .filter_map(|e| Some((e["active"] == true, e["login"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|(active, _)| !*active);
    out.into_iter().map(|(_, l)| l).collect()
}

/// Case-insensitive match of every whitespace-separated word of `query`
/// against the full name, so "hub" finds `acme/hubbub` and "acme hub" too.
pub(crate) fn matches_query(full_name: &str, query: &str) -> bool {
    let hay = full_name.to_lowercase();
    query.split_whitespace().all(|w| hay.contains(&w.to_lowercase()))
}

/// 0 exact repo name, 1 repo name starts with, 2 repo name contains, 3 owner
/// part only. Stable within a rank, so the API's recently-updated order holds.
fn rank(full_name: &str, query: &str) -> u8 {
    let q = query.trim().to_lowercase();
    let repo = full_name.rsplit('/').next().unwrap_or(full_name).to_lowercase();
    if repo == q {
        0
    } else if repo.starts_with(&q) {
        1
    } else if repo.contains(&q) {
        2
    } else {
        3
    }
}

/// Where `full_name` is already checked out: `<root>/<repo>`, or a known
/// project whose folder is named like the repo, when that folder's git config
/// names `full_name` as a remote. Reading `.git/config` as text avoids a
/// process per candidate; a worktree's `.git` file or an unrelated folder of
/// the same name is not a match, so a clone is never skipped for the wrong repo.
pub(crate) fn find_on_disk(root: Option<&Path>, project_paths: &[PathBuf], full_name: &str) -> Option<String> {
    let (_, repo) = split_full_name(full_name)?;
    let named_like_repo = |p: &&PathBuf| {
        p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(repo)).unwrap_or(false)
    };
    let needle = format!("github.com/{}", full_name.to_lowercase());
    let needle_ssh = format!("github.com:{}", full_name.to_lowercase());
    root.map(|r| r.join(repo))
        .into_iter()
        .chain(project_paths.iter().filter(named_like_repo).cloned())
        .find(|dir| {
            std::fs::read_to_string(dir.join(".git").join("config"))
                .map(|cfg| {
                    let lower = cfg.to_lowercase();
                    lower.contains(&needle) || lower.contains(&needle_ssh)
                })
                .unwrap_or(false)
        })
        .map(|d| d.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
struct ApiRepo {
    full_name: String,
    private: bool,
    description: Option<String>,
}

/// One JSON object per line, as `gh api --paginate --jq '.[] | {...}'` prints.
fn parse_listing(stdout: &str, account: &str) -> Vec<RepoHit> {
    stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<ApiRepo>(l.trim()).ok())
        .map(|r| RepoHit {
            full_name: r.full_name,
            description: r.description.unwrap_or_default(),
            private: r.private,
            account: account.to_string(),
            stars: None,
            on_disk: None,
        })
        .collect()
}

#[derive(Deserialize)]
struct SearchRepo {
    #[serde(rename = "fullName")]
    full_name: String,
    description: Option<String>,
    #[serde(rename = "isPrivate", default)]
    is_private: bool,
    #[serde(rename = "stargazersCount", default)]
    stars: u64,
}

fn parse_public(stdout: &str) -> Vec<RepoHit> {
    serde_json::from_str::<Vec<SearchRepo>>(stdout)
        .unwrap_or_default()
        .into_iter()
        .map(|r| RepoHit {
            full_name: r.full_name,
            description: r.description.unwrap_or_default(),
            private: r.is_private,
            account: String::new(),
            stars: Some(r.stars),
            on_disk: None,
        })
        .collect()
}

enum GhError {
    Missing,
    Failed(String),
}

/// Runs `gh` with prompts off. A `token` pins this one call to that login
/// without touching the active account.
async fn run_gh(args: &[&str], token: Option<&str>, timeout: Duration) -> Result<String, GhError> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(t) = token {
        cmd.env("GH_TOKEN", t);
    }
    crate::util::process::hide_console_tokio(&mut cmd);
    let out = match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => return Err(GhError::Failed("GitHub did not answer in time".into())),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => return Err(GhError::Missing),
        Ok(Err(e)) => return Err(GhError::Failed(e.to_string())),
        Ok(Ok(o)) => o,
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(GhError::Failed(err.lines().last().unwrap_or("gh failed").trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Logins that can be searched. `Err(Missing)` is "gh is not installed";
/// an empty list is "installed, nobody signed in".
async fn signed_in_accounts() -> Result<Vec<String>, GhError> {
    // `gh auth status` exits non-zero when ANY stored account is broken yet
    // still prints the working ones, so this reads stdout without checking the
    // exit status (which `run_gh` would turn into an error).
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(["auth", "status", "--json", "hosts"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::util::process::hide_console_tokio(&mut cmd);
    match tokio::time::timeout(Duration::from_secs(15), cmd.output()).await {
        Err(_) => Err(GhError::Failed("gh did not answer in time".into())),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(GhError::Missing),
        Ok(Err(e)) => Err(GhError::Failed(e.to_string())),
        Ok(Ok(o)) => Ok(parse_accounts(&String::from_utf8_lossy(&o.stdout))),
    }
}

type Listings = Mutex<HashMap<String, (Instant, Vec<RepoHit>)>>;
fn listing_cache() -> &'static Listings {
    static C: OnceLock<Listings> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every repo `login` can see: owned, collaborator and organisation-member
/// (private included), newest activity first.
async fn list_account_repos(login: &str) -> Result<Vec<RepoHit>, GhError> {
    if let Some((at, hits)) = listing_cache().lock().unwrap().get(login) {
        if at.elapsed() < LISTING_TTL {
            return Ok(hits.clone());
        }
    }
    let token = run_gh(&["auth", "token", "--hostname", "github.com", "--user", login], None, Duration::from_secs(10))
        .await?
        .trim()
        .to_string();
    let stdout = run_gh(
        &[
            "api",
            "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
            "--paginate",
            "--jq",
            ".[] | {full_name, private, description}",
        ],
        Some(&token),
        SEARCH_TIMEOUT,
    )
    .await?;
    let hits = parse_listing(&stdout, login);
    listing_cache().lock().unwrap().insert(login.to_string(), (Instant::now(), hits.clone()));
    Ok(hits)
}

fn projects_root(state: &DaemonState) -> Option<PathBuf> {
    let settings = state.settings.snapshot();
    let stored = settings.extra.get(PROJECTS_ROOT_SETTINGS_KEY).and_then(|v| v.as_str());
    let paths: Vec<String> = settings.projects.iter().map(|p| p.path.to_string_lossy().into_owned()).collect();
    resolve_projects_root(stored, &paths).map(PathBuf::from)
}

fn project_paths(state: &DaemonState) -> Vec<PathBuf> {
    state.settings.snapshot().projects.iter().map(|p| p.path.clone()).collect()
}

fn mark_on_disk(hits: &mut [RepoHit], state: &DaemonState) {
    let root = projects_root(state);
    let known = project_paths(state);
    for h in hits {
        h.on_disk = find_on_disk(root.as_deref(), &known, &h.full_name);
    }
}

fn status_reply(status: &str, items: Vec<RepoHit>, failed: usize) -> Value {
    json!({ "status": status, "items": items, "failed_accounts": failed })
}

async fn search_mine(state: &DaemonState, query: &str) -> Result<Value, RpcError> {
    let accounts = match signed_in_accounts().await {
        Err(GhError::Missing) => return Ok(status_reply("gh_missing", vec![], 0)),
        Err(GhError::Failed(e)) => return Err(RpcError::internal(e)),
        Ok(a) if a.is_empty() => return Ok(status_reply("not_signed_in", vec![], 0)),
        Ok(a) => a,
    };
    let results = futures_util::future::join_all(accounts.iter().map(|a| list_account_repos(a))).await;
    let mut failed = 0;
    let mut seen = std::collections::HashSet::new();
    let mut hits: Vec<RepoHit> = Vec::new();
    for r in results {
        match r {
            Ok(list) => {
                for h in list {
                    if matches_query(&h.full_name, query) && seen.insert(h.full_name.to_lowercase()) {
                        hits.push(h);
                    }
                }
            }
            Err(_) => failed += 1,
        }
    }
    // Every account failing is an error to show, not an empty answer.
    if failed == accounts.len() {
        return Err(RpcError::internal("could not list repos for any signed-in GitHub account".to_string()));
    }
    hits.sort_by_key(|h| rank(&h.full_name, query));
    hits.truncate(MAX_RESULTS);
    mark_on_disk(&mut hits, state);
    Ok(status_reply("ok", hits, failed))
}

async fn search_public(state: &DaemonState, query: &str) -> Result<Value, RpcError> {
    let stdout = match run_gh(
        &["search", "repos", "--limit", "25", "--json", "fullName,description,isPrivate,stargazersCount", "--", query],
        None,
        SEARCH_TIMEOUT,
    )
    .await
    {
        Err(GhError::Missing) => return Ok(status_reply("gh_missing", vec![], 0)),
        Err(GhError::Failed(e)) => return Err(RpcError::internal(e)),
        Ok(s) => s,
    };
    let mut hits = parse_public(&stdout);
    mark_on_disk(&mut hits, state);
    Ok(status_reply("ok", hits, 0))
}

pub fn register_github_repos(router: &mut Router, state: Arc<DaemonState>) {
    router.register("github_search_repos", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P {
                    query: String,
                    scope: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let query = p.query.trim();
                if query.is_empty() || query.len() > 100 || query.chars().any(|c| c.is_control()) {
                    return Err(RpcError::invalid_params("invalid search".to_string()));
                }
                match p.scope.as_str() {
                    "mine" => search_mine(&state, query).await,
                    "public" => search_public(&state, query).await,
                    _ => Err(RpcError::invalid_params("scope must be mine or public".to_string())),
                }
            }
        }
    });

    router.register("github_clone_repo", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P {
                    full_name: String,
                    #[serde(default)]
                    account: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let (_, repo) = split_full_name(&p.full_name)
                    .ok_or_else(|| RpcError::invalid_params("invalid repo name".to_string()))?;
                if !is_valid_project_name(repo) {
                    return Err(RpcError::invalid_params("invalid repo name".to_string()));
                }
                let root = projects_root(&state).ok_or_else(|| {
                    RpcError::invalid_params("no projects root configured - set one on the desktop first".to_string())
                })?;
                if !root.is_dir() {
                    return Err(RpcError::invalid_params(format!("projects root {} is not accessible", root.display())));
                }
                // Already checked out (the picker marks these "on disk"): hand
                // the existing folder back instead of cloning a second copy.
                // Registered like a fresh clone, because the phone's cwd-gated
                // RPCs reject a folder the daemon does not know.
                if let Some(existing) = find_on_disk(Some(&root), &project_paths(&state), &p.full_name) {
                    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                    crate::daemon::session_registration::register_project(&state, Path::new(&existing), &now);
                    return Ok(json!({ "path": existing, "name": repo, "existing": true }));
                }
                let dest = root.join(repo);
                if dest.exists() {
                    return Err(RpcError::invalid_params(format!("{} already exists", dest.display())));
                }

                // The login comes from the client, so it is only ever used to
                // look up that account's own stored token - never as a command
                // argument that is not already a known `gh` login.
                let token = if p.account.is_empty() {
                    None
                } else {
                    let known = match signed_in_accounts().await {
                        Ok(a) => a,
                        Err(GhError::Missing) => return Err(RpcError::invalid_params("gh is not installed".to_string())),
                        Err(GhError::Failed(e)) => return Err(RpcError::internal(e)),
                    };
                    if !known.iter().any(|a| a == &p.account) {
                        return Err(RpcError::invalid_params("that GitHub account is not signed in".to_string()));
                    }
                    let t = run_gh(
                        &["auth", "token", "--hostname", "github.com", "--user", &p.account],
                        None,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|e| match e {
                        GhError::Missing => RpcError::invalid_params("gh is not installed".to_string()),
                        GhError::Failed(m) => RpcError::internal(m),
                    })?;
                    Some(t.trim().to_string())
                };

                let dest_str = dest.to_string_lossy().into_owned();
                run_gh(&["repo", "clone", &p.full_name, &dest_str], token.as_deref(), CLONE_TIMEOUT)
                    .await
                    .map_err(|e| match e {
                        GhError::Missing => RpcError::invalid_params("gh is not installed".to_string()),
                        GhError::Failed(m) => RpcError::internal(format!("clone failed: {m}")),
                    })?;

                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                crate::daemon::session_registration::register_project(&state, &dest, &now);
                Ok(json!({ "path": dest_str, "name": repo }))
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_name_accepts_owner_slash_repo() {
        assert_eq!(split_full_name("SirBepy/claude_conductor"), Some(("SirBepy", "claude_conductor")));
        assert_eq!(split_full_name("a-b/c.d"), Some(("a-b", "c.d")));
    }

    #[test]
    fn full_name_rejects_flags_paths_and_extra_segments() {
        for bad in ["", "x", "-o/r", "o/-r", "o/r/extra", "../x", "o/..", "o/r;calc", "o/r name", "o\\r", "/r", "o/"] {
            assert_eq!(split_full_name(bad), None, "{bad:?} must be rejected");
        }
    }

    #[test]
    fn accounts_keep_working_logins_active_first() {
        let j = r#"{"hosts":{"github.com":[
            {"state":"success","active":false,"login":"two"},
            {"state":"error","active":false,"login":"broken"},
            {"state":"success","active":true,"login":"one"}]}}"#;
        assert_eq!(parse_accounts(j), vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn accounts_empty_on_garbage_or_no_hosts() {
        assert!(parse_accounts("").is_empty());
        assert!(parse_accounts("{}").is_empty());
        assert!(parse_accounts(r#"{"hosts":{}}"#).is_empty());
    }

    #[test]
    fn query_matches_every_word_anywhere_in_the_full_name() {
        assert!(matches_query("SirBepy/hubbub-api", "hub"));
        assert!(matches_query("SirBepy/hubbub-api", "sirbepy api"));
        assert!(!matches_query("SirBepy/hubbub-api", "hub web"));
    }

    #[test]
    fn rank_prefers_exact_then_prefix_then_contains_then_owner() {
        assert!(rank("o/hub", "hub") < rank("o/hubbub", "hub"));
        assert!(rank("o/hubbub", "hub") < rank("o/my-hub", "hub"));
        assert!(rank("o/my-hub", "hub") < rank("hub/other", "hub"));
    }

    #[test]
    fn listing_lines_become_hits_and_skip_noise() {
        let out = "{\"full_name\":\"a/b\",\"private\":true,\"description\":null}\nnot json\n{\"full_name\":\"c/d\",\"private\":false,\"description\":\"x\"}\n";
        let hits = parse_listing(out, "me");
        assert_eq!(hits.len(), 2);
        assert!(hits[0].private && hits[0].description.is_empty() && hits[0].account == "me");
        assert_eq!(hits[1].description, "x");
    }

    #[test]
    fn public_search_output_maps_stars_and_has_no_account() {
        let out = r#"[{"description":"d","fullName":"o/r","isPrivate":false,"stargazersCount":7}]"#;
        let hits = parse_public(out);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].stars, Some(7));
        assert!(hits[0].account.is_empty());
        assert!(parse_public("garbage").is_empty());
    }

    fn checkout(root: &Path, name: &str, remote: &str) {
        let git = root.join(name).join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("config"), format!("[remote \"origin\"]\n\turl = {remote}\n")).unwrap();
    }

    #[test]
    fn on_disk_needs_the_remote_to_name_the_repo() {
        let dir = tempfile::tempdir().unwrap();
        checkout(dir.path(), "hubbub", "https://github.com/SirBepy/hubbub.git");
        checkout(dir.path(), "other", "git@github.com:Someone/other.git");
        let root = Some(dir.path());
        assert!(find_on_disk(root, &[], "SirBepy/hubbub").is_some(), "case-insensitive https remote");
        assert!(find_on_disk(root, &[], "someone/other").is_some(), "ssh remote");
        // A same-named folder that is a different repo is NOT this repo.
        assert!(find_on_disk(root, &[], "Evil/hubbub").is_none());
        assert!(find_on_disk(root, &[], "SirBepy/missing").is_none());
    }

    #[test]
    fn on_disk_also_finds_a_known_project_outside_the_root() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        checkout(elsewhere.path(), "hubbub-api", "https://github.com/SirBepy/hubbub-api.git");
        let known = vec![elsewhere.path().join("hubbub-api")];
        assert_eq!(
            find_on_disk(Some(root.path()), &known, "SirBepy/hubbub-api"),
            Some(known[0].to_string_lossy().into_owned())
        );
        // A known project of a different name is never consulted.
        assert!(find_on_disk(Some(root.path()), &known, "SirBepy/hubbub").is_none());
    }

    // ── RPC validation: rejected before any process starts ────────────────

    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    async fn call(settings: Settings, method: &str, params: Value) -> crate::daemon::rpc::Response {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        let mut r = Router::new();
        register_github_repos(&mut r, state);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
            ConnectionContext::new(tx),
        )
        .await
    }

    #[tokio::test]
    async fn search_rejects_a_bad_scope_and_an_empty_query() {
        let r = call(Settings::default(), "github_search_repos", json!({"query": "x", "scope": "all"})).await;
        assert!(r.error.is_some());
        let r = call(Settings::default(), "github_search_repos", json!({"query": "  ", "scope": "mine"})).await;
        assert!(r.error.is_some());
    }

    #[tokio::test]
    async fn clone_rejects_a_traversal_shaped_full_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.extra.insert("newProjectLastParent".into(), json!(dir.path().to_string_lossy()));
        let r = call(s, "github_clone_repo", json!({"full_name": "o/.."})).await;
        assert!(r.error.is_some());
    }

    #[tokio::test]
    async fn clone_refuses_to_clone_over_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("repo")).unwrap();
        let mut s = Settings::default();
        s.extra.insert("newProjectLastParent".into(), json!(dir.path().to_string_lossy()));
        let r = call(s, "github_clone_repo", json!({"full_name": "o/repo"})).await;
        assert!(r.error.expect("must error").message.contains("already exists"));
    }

    #[tokio::test]
    async fn clone_of_an_existing_checkout_returns_it_instead_of_cloning() {
        let dir = crate::settings::identity::test_support::non_ephemeral_tempdir();
        checkout(dir.path(), "repo", "https://github.com/o/repo.git");
        let mut s = Settings::default();
        s.extra.insert("newProjectLastParent".into(), json!(dir.path().to_string_lossy()));
        let r = call(s, "github_clone_repo", json!({"full_name": "o/repo"})).await;
        assert!(r.error.is_none(), "got {:?}", r.error);
        let v = r.result.unwrap();
        assert_eq!(v["existing"], true);
        assert_eq!(Path::new(v["path"].as_str().unwrap()), dir.path().join("repo"));
    }

    #[tokio::test]
    async fn clone_without_a_projects_root_errors_instead_of_guessing() {
        let r = call(Settings::default(), "github_clone_repo", json!({"full_name": "o/repo"})).await;
        assert!(r.error.is_some());
    }
}
