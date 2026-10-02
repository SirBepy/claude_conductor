//! Ticket links in chat: which tracker a project's tickets live in (its own
//! `ProjectConfig.tracker`, else inferred from the git remote's org, the same
//! mapping the `/ticket` skill uses), and a cached read-only summary of one
//! ticket for the hover card. Tokens come from `~/.claude/.env`, the one place
//! every tool already reads them from; they never leave this process.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum TrackerKind {
    Shortcut,
    Linear,
    /// Explicitly no tracker, overriding whatever the remote would infer.
    Off,
}

/// Per-project tracker choice. `workspace` is the URL slug: `zirtue` in
/// `app.shortcut.com/zirtue/story/1`, `revaire` in `linear.app/revaire/issue/X-1`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TicketTracker {
    pub kind: TrackerKind,
    #[serde(default)]
    pub workspace: String,
}

/// What the renderer needs to linkify a chat's ticket ids. `team_keys` is
/// Linear's id prefixes (`MOB` in `MOB-123`), fetched so `UTF-8` never links.
#[derive(Serialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TrackerInfo {
    pub kind: TrackerKind,
    pub workspace: String,
    pub team_keys: Vec<String>,
    /// True when no project setting exists and the git remote decided.
    pub inferred: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TicketSummary {
    pub id: String,
    pub title: String,
    pub state: String,
    pub owner: Option<String>,
    pub ticket_type: String,
    pub url: String,
}

// git remote owner -> tracker. Mirrors `~/.claude/skills/ticket/SKILL.md`'s table.
const KNOWN_ORGS: &[(&str, TrackerKind, &str)] = &[
    ("zirtue-corp", TrackerKind::Shortcut, "zirtue"),
    ("revaire", TrackerKind::Linear, "revaire"),
];

/// The owner segment of a GitHub-style remote: `git@github.com:org/repo.git`
/// and `https://github.com/org/repo` both yield `org`.
fn remote_owner(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://").map(|(_, r)| r).unwrap_or(url.trim());
    let path = rest.split_once(':').filter(|(host, _)| !host.contains('/')).map(|(_, p)| p);
    let path = path.unwrap_or_else(|| rest.split_once('/').map(|(_, p)| p).unwrap_or(""));
    let owner = path.trim_start_matches('/').split('/').next()?.to_ascii_lowercase();
    (!owner.is_empty()).then_some(owner)
}

pub fn infer_from_remote(url: &str) -> Option<TicketTracker> {
    let owner = remote_owner(url)?;
    KNOWN_ORGS
        .iter()
        .find(|(org, _, _)| *org == owner)
        .map(|(_, kind, ws)| TicketTracker { kind: *kind, workspace: ws.to_string() })
}

/// The tracker for chats under `cwd`: the project's own setting (with the same
/// worktree-to-main-repo fallback as the account binding), else the remote.
/// `Off` and an empty workspace both mean no tracker.
pub fn effective_tracker(projects: &[crate::types::ProjectConfig], cwd: &std::path::Path) -> Option<(TicketTracker, bool)> {
    let (t, inferred) = match crate::settings::identity::resolve_project_tracker(projects, cwd) {
        Some(t) => (t, false),
        None => {
            let url = remote_url(cwd)?;
            (infer_from_remote(&url)?, true)
        }
    };
    (t.kind != TrackerKind::Off && !t.workspace.trim().is_empty()).then_some((t, inferred))
}

fn remote_url(cwd: &std::path::Path) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(["remote", "get-url", "origin"]);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    String::from_utf8(out.stdout).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Appended to the chat's system prompt so new mentions arrive already linked.
pub fn prompt_line(t: &TicketTracker) -> Option<String> {
    let ws = &t.workspace;
    match t.kind {
        TrackerKind::Shortcut => Some(format!(
            "This project's tickets are Shortcut stories. Whenever you mention one, write it as a markdown link: [sc-12345](https://app.shortcut.com/{ws}/story/12345)."
        )),
        TrackerKind::Linear => Some(format!(
            "This project's tickets are Linear issues. Whenever you mention one, write it as a markdown link: [ABC-123](https://linear.app/{ws}/issue/ABC-123)."
        )),
        TrackerKind::Off => None,
    }
}

// ── tokens ──────────────────────────────────────────────────────────────

/// Reads one `KEY=value` from `~/.claude/.env`. The line parse (BOM, CRLF,
/// optional quotes) is shared with `api_keys::is_key_set` via
/// `crate::env_file::read_value` (todo 1049).
fn env_token(key: &str) -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".env");
    parse_env_value(&std::fs::read_to_string(path).ok()?, key)
}

fn parse_env_value(text: &str, key: &str) -> Option<String> {
    crate::env_file::read_value(text, key)
}

fn token_for(kind: TrackerKind) -> Result<String, String> {
    let key = match kind {
        TrackerKind::Shortcut => "SHORTCUT_API_TOKEN",
        TrackerKind::Linear => "LINEAR_API_KEY",
        TrackerKind::Off => return Err("no tracker".into()),
    };
    env_token(key).ok_or_else(|| format!("{key} is not set in ~/.claude/.env"))
}

// ── caches ──────────────────────────────────────────────────────────────

// A ticket's state/owner changes on a human timescale; five minutes keeps a
// hovered card current enough without an API call per hover.
const SUMMARY_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Caches {
    summaries: HashMap<String, (Instant, TicketSummary)>,
    // Shortcut ids -> names, fetched once per process: stories carry only ids.
    sc_states: HashMap<String, HashMap<i64, String>>,
    sc_members: HashMap<String, HashMap<String, String>>,
    linear_keys: HashMap<String, Vec<String>>,
}

static CACHES: std::sync::LazyLock<Mutex<Caches>> = std::sync::LazyLock::new(Default::default);

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default()
}

async fn shortcut_get(token: &str, path: &str) -> Result<serde_json::Value, String> {
    let resp = http()
        .get(format!("https://api.app.shortcut.com/api/v3/{path}"))
        .header("Shortcut-Token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Shortcut returned {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

async fn linear_query(token: &str, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let resp = http()
        .post("https://api.linear.app/graphql")
        .header("Authorization", token)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Linear returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = body.pointer("/errors/0/message").and_then(|m| m.as_str()) {
        return Err(err.to_string());
    }
    Ok(body["data"].clone())
}

async fn linear_team_keys(workspace: &str) -> Vec<String> {
    if let Some(keys) = CACHES.lock().unwrap().linear_keys.get(workspace) {
        return keys.clone();
    }
    let Ok(token) = token_for(TrackerKind::Linear) else { return vec![] };
    let Ok(data) = linear_query(&token, "{ teams { nodes { key } } }", serde_json::json!({})).await else {
        return vec![];
    };
    let keys: Vec<String> = data
        .pointer("/teams/nodes")
        .and_then(|n| n.as_array())
        .map(|a| a.iter().filter_map(|t| t["key"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    CACHES.lock().unwrap().linear_keys.insert(workspace.to_string(), keys.clone());
    keys
}

async fn shortcut_names(token: &str, workspace: &str) -> Result<(), String> {
    let have = {
        let c = CACHES.lock().unwrap();
        c.sc_states.contains_key(workspace) && c.sc_members.contains_key(workspace)
    };
    if have {
        return Ok(());
    }
    let workflows = shortcut_get(token, "workflows").await?;
    let members = shortcut_get(token, "members").await?;
    let states: HashMap<i64, String> = workflows
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|w| w["states"].as_array().cloned().unwrap_or_default())
        .filter_map(|s| Some((s["id"].as_i64()?, s["name"].as_str()?.to_string())))
        .collect();
    let people: HashMap<String, String> = members
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m["id"].as_str()?.to_string(), m.pointer("/profile/name")?.as_str()?.to_string())))
        .collect();
    let mut c = CACHES.lock().unwrap();
    c.sc_states.insert(workspace.to_string(), states);
    c.sc_members.insert(workspace.to_string(), people);
    Ok(())
}

fn shortcut_summary(story: &serde_json::Value, workspace: &str) -> Result<TicketSummary, String> {
    let id = story["id"].as_i64().ok_or("story has no id")?;
    let c = CACHES.lock().unwrap();
    let state = story["workflow_state_id"]
        .as_i64()
        .and_then(|s| c.sc_states.get(workspace)?.get(&s).cloned())
        .unwrap_or_default();
    let owner = story["owner_ids"]
        .as_array()
        .and_then(|o| o.first()?.as_str())
        .and_then(|o| c.sc_members.get(workspace)?.get(o).cloned());
    Ok(TicketSummary {
        id: format!("sc-{id}"),
        title: story["name"].as_str().unwrap_or_default().to_string(),
        state,
        owner,
        ticket_type: story["story_type"].as_str().unwrap_or("story").to_string(),
        url: story["app_url"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://app.shortcut.com/{workspace}/story/{id}")),
    })
}

fn linear_summary(issue: &serde_json::Value) -> Result<TicketSummary, String> {
    if issue.is_null() {
        return Err("no such issue".into());
    }
    let label = issue.pointer("/labels/nodes/0/name").and_then(|l| l.as_str());
    Ok(TicketSummary {
        id: issue["identifier"].as_str().unwrap_or_default().to_string(),
        title: issue["title"].as_str().unwrap_or_default().to_string(),
        state: issue.pointer("/state/name").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
        owner: issue.pointer("/assignee/name").and_then(|a| a.as_str()).map(str::to_string),
        ticket_type: label.unwrap_or("issue").to_string(),
        url: issue["url"].as_str().unwrap_or_default().to_string(),
    })
}

pub async fn fetch_summary(kind: TrackerKind, workspace: &str, id: &str) -> Result<TicketSummary, String> {
    let cache_key = format!("{kind:?}/{workspace}/{id}");
    if let Some((at, s)) = CACHES.lock().unwrap().summaries.get(&cache_key) {
        if at.elapsed() < SUMMARY_TTL {
            return Ok(s.clone());
        }
    }
    let token = token_for(kind)?;
    let summary = match kind {
        TrackerKind::Shortcut => {
            let n: u64 = id.trim_start_matches("sc-").parse().map_err(|_| format!("bad story id {id}"))?;
            shortcut_names(&token, workspace).await?;
            let story = shortcut_get(&token, &format!("stories/{n}")).await?;
            shortcut_summary(&story, workspace)?
        }
        TrackerKind::Linear => {
            let q = "query($id: String!) { issue(id: $id) { identifier title url state { name } assignee { name } labels(first: 1) { nodes { name } } } }";
            let data = linear_query(&token, q, serde_json::json!({ "id": id })).await?;
            linear_summary(&data["issue"])?
        }
        TrackerKind::Off => return Err("no tracker".into()),
    };
    CACHES.lock().unwrap().summaries.insert(cache_key, (Instant::now(), summary.clone()));
    Ok(summary)
}

pub async fn tracker_info(projects: Vec<crate::types::ProjectConfig>, cwd: String) -> Option<TrackerInfo> {
    let (t, inferred) = tokio::task::spawn_blocking(move || effective_tracker(&projects, std::path::Path::new(&cwd)))
        .await
        .ok()??;
    let team_keys = if t.kind == TrackerKind::Linear { linear_team_keys(&t.workspace).await } else { vec![] };
    Some(TrackerInfo { kind: t.kind, workspace: t.workspace, team_keys, inferred })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_owner_reads_ssh_and_https_forms() {
        assert_eq!(remote_owner("git@github.com:zirtue-corp/app.git").as_deref(), Some("zirtue-corp"));
        assert_eq!(remote_owner("https://github.com/Revaire/mobile").as_deref(), Some("revaire"));
        assert_eq!(remote_owner("ssh://git@github.com/SirBepy/x.git").as_deref(), Some("sirbepy"));
        assert_eq!(remote_owner("").as_deref(), None);
    }

    #[test]
    fn known_orgs_infer_their_tracker_and_others_none() {
        let sc = infer_from_remote("git@github.com:zirtue-corp/web.git").unwrap();
        assert_eq!((sc.kind, sc.workspace.as_str()), (TrackerKind::Shortcut, "zirtue"));
        let li = infer_from_remote("https://github.com/revaire/api").unwrap();
        assert_eq!((li.kind, li.workspace.as_str()), (TrackerKind::Linear, "revaire"));
        assert!(infer_from_remote("https://github.com/SirBepy/claude_usage_in_taskbar").is_none());
    }

    #[test]
    fn env_values_survive_bom_crlf_and_quotes() {
        let text = "\u{feff}FOO=1\r\nSHORTCUT_API_TOKEN=\"abc-123\"\r\nLINEAR_API_KEY=\r\n";
        assert_eq!(parse_env_value(text, "SHORTCUT_API_TOKEN").as_deref(), Some("abc-123"));
        assert_eq!(parse_env_value(text, "FOO").as_deref(), Some("1"));
        assert_eq!(parse_env_value(text, "LINEAR_API_KEY"), None, "an empty value is unset");
        assert_eq!(parse_env_value(text, "MISSING"), None);
    }

    #[test]
    fn prompt_line_names_the_workspace_url_and_off_adds_nothing() {
        let t = TicketTracker { kind: TrackerKind::Shortcut, workspace: "zirtue".into() };
        assert!(prompt_line(&t).unwrap().contains("https://app.shortcut.com/zirtue/story/12345"));
        let off = TicketTracker { kind: TrackerKind::Off, workspace: String::new() };
        assert!(prompt_line(&off).is_none());
    }

    #[test]
    fn shortcut_story_maps_state_and_owner_names_from_the_caches() {
        {
            let mut c = CACHES.lock().unwrap();
            c.sc_states.insert("ws-test".into(), HashMap::from([(7, "In Review".to_string())]));
            c.sc_members.insert("ws-test".into(), HashMap::from([("u1".to_string(), "Joe".to_string())]));
        }
        let story = serde_json::json!({
            "id": 55411, "name": "Fix DOB", "story_type": "bug", "workflow_state_id": 7,
            "owner_ids": ["u1"], "app_url": "https://app.shortcut.com/ws-test/story/55411"
        });
        let s = shortcut_summary(&story, "ws-test").unwrap();
        assert_eq!(s.id, "sc-55411");
        assert_eq!(s.state, "In Review");
        assert_eq!(s.owner.as_deref(), Some("Joe"));
        assert_eq!(s.ticket_type, "bug");
    }

    #[test]
    fn linear_issue_maps_and_a_missing_issue_errors() {
        let issue = serde_json::json!({
            "identifier": "MOB-12", "title": "Crash", "url": "https://linear.app/revaire/issue/MOB-12",
            "state": { "name": "Todo" }, "assignee": null, "labels": { "nodes": [{ "name": "Bug" }] }
        });
        let s = linear_summary(&issue).unwrap();
        assert_eq!((s.id.as_str(), s.state.as_str(), s.ticket_type.as_str()), ("MOB-12", "Todo", "Bug"));
        assert_eq!(s.owner, None);
        assert!(linear_summary(&serde_json::Value::Null).is_err());
    }
}
