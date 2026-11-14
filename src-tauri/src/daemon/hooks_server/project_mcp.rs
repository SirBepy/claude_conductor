//! `/projects/mcp`: HTTP half of the `project_mcp` MCP tool, which lets a chat list,
//! add and remove the MCP servers its own project lists in Settings (the same list
//! `daemon::project_mcp` writes into each turn's config). Outcome rides in the body
//! at `200 OK`, like every other MCP route here.
//!
//! An added entry can be a local program the daemon starts on every later turn, so
//! an `add` is the one action here a model must never complete alone: the daemon
//! raises an approval card showing the exact entry and stores nothing until a human
//! allows it. That holds in an auto-accept chat too (the card is also exempt from the
//! front end's auto-allow: `needsHumanApproval` in `permission-modal/gating.ts`),
//! because a web page or file a chat read could otherwise talk it into planting a
//! command. `remove` and `list` change or reveal nothing that runs, so they skip the card.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::state::DaemonState;
use crate::types::project::ProjectMcpServer;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) const PROJECT_MCP_TOOL: &str = "mcp__cc_conductor__project_mcp";

#[derive(Deserialize)]
pub(super) struct ProjectMcpBody {
    session_id: String,
    action: String,
    // Option rather than `#[serde(default)]` throughout: `default` covers a missing
    // key, not an explicit null (see `user_todos::WriteTodoBody`).
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
}

pub(super) async fn on_project_mcp(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<ProjectMcpBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    (StatusCode::OK, Json(project_mcp(&ctx.state, body).await))
}

fn failure(error: impl Into<String>) -> Value {
    json!({"ok": false, "error": error.into()})
}

/// The project's listed servers as the daemon's cache holds them now.
fn listed(state: &DaemonState, project_id: &str) -> Vec<ProjectMcpServer> {
    state
        .settings
        .snapshot()
        .projects
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.mcp_servers)
        .unwrap_or_default()
}

fn describe(s: &ProjectMcpServer) -> Value {
    if s.url.is_empty() {
        json!({"name": s.name, "command": s.command, "args": s.args})
    } else {
        json!({"name": s.name, "url": s.url})
    }
}

async fn project_mcp(state: &Arc<DaemonState>, body: ProjectMcpBody) -> Value {
    // The claimed session id is untrusted, as in `schedule.rs`: the project comes
    // from what the registry holds for it, never from the request.
    let Some(inst) = state.registry.get(&body.session_id) else {
        return failure("unknown caller");
    };
    let cwd = inst.cwd.clone();
    let found = crate::settings::identity::resolve_project_id(&state.settings.snapshot().projects, &cwd);

    match body.action.as_str() {
        "list" => {
            let servers: Vec<Value> = found.as_deref().map(|id| listed(state, id)).unwrap_or_default().iter().map(describe).collect();
            json!({"ok": true, "servers": servers})
        }
        "remove" => {
            let name = body.name.as_deref().unwrap_or("").trim().to_string();
            let Some(project_id) = found else { return failure("this project lists no servers") };
            let current = listed(state, &project_id);
            if !current.iter().any(|s| s.name == name) {
                return failure(format!("no listed server is named {name:?}"));
            }
            let next: Vec<ProjectMcpServer> = current.into_iter().filter(|s| s.name != name).collect();
            store(state, &project_id, next);
            json!({"ok": true, "text": format!("removed {name}; it is gone from the next turn on")})
        }
        "add" => add(state, &body, &cwd, found).await,
        _ => failure("action must be list, add or remove"),
    }
}

async fn add(
    state: &Arc<DaemonState>,
    body: &ProjectMcpBody,
    cwd: &std::path::Path,
    found: Option<String>,
) -> Value {
    let entry = ProjectMcpServer {
        name: body.name.as_deref().unwrap_or("").trim().to_string(),
        url: body.url.as_deref().unwrap_or("").trim().to_string(),
        command: body.command.as_deref().unwrap_or("").trim().to_string(),
        args: body.args.clone().unwrap_or_default(),
    };
    if let Err(why) = crate::daemon::project_mcp::check(&entry) {
        return failure(why);
    }
    if found.as_deref().map(|id| listed(state, id)).unwrap_or_default().iter().any(|s| s.name == entry.name) {
        return failure(format!("{} is already listed; remove it first to change it", entry.name));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let mut input = json!({"action": "add", "name": entry.name, "project": cwd.to_string_lossy()});
    if entry.url.is_empty() {
        input["command"] = json!(entry.command);
        input["args"] = json!(entry.args);
    } else {
        input["url"] = json!(entry.url);
    }
    let decision = super::permission::ask_human(state, &id, PROJECT_MCP_TOOL, input, Some(&body.session_id)).await;
    if decision["behavior"] != "allow" {
        // Joe's own decline is expected control flow, so it answers directly.
        return failure(
            decision["message"]
                .as_str()
                .map(|m| format!("not added: {m}"))
                .unwrap_or_else(|| "not added: Joe declined".to_string()),
        );
    }

    // Registered only now, after the approval: a declined add leaves no project behind.
    let project_id = match found {
        Some(id) => id,
        None => {
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            crate::daemon::session_registration::register_project(state, cwd, &now).0
        }
    };
    // Re-read: the list may have changed while the card was open.
    let mut next = listed(state, &project_id);
    if next.iter().any(|s| s.name == entry.name) {
        return failure(format!("{} was listed while the card was open", entry.name));
    }
    let name = entry.name.clone();
    next.push(entry);
    store(state, &project_id, next);
    json!({"ok": true, "text": format!("added {name}; its tools appear from the next turn on, and it is left out with a notice if the program is not found")})
}

/// Writes the list into the daemon's cache and tells the app process to persist it.
fn store(state: &DaemonState, project_id: &str, servers: Vec<ProjectMcpServer>) {
    if state.settings.set_project_mcp_servers(project_id, &servers) {
        state.notifier.publish("project_mcp_servers_set", json!({"project_id": project_id, "servers": servers}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::settings::identity::test_support::non_ephemeral_tempdir;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A chat in a registered project folder, and that folder's project id.
    fn chat_in_project(state: &DaemonState, dir: &std::path::Path) -> (String, String) {
        let now = "2026-11-14T00:00:00Z";
        let (project_id, _) = crate::daemon::session_registration::register_project(state, dir, now);
        let sid = format!("pmcp-{}", uuid::Uuid::new_v4());
        state.registry.upsert_interactive(&sid, dir, &project_id, now);
        (sid, project_id)
    }

    fn body(sid: &str, action: &str) -> ProjectMcpBody {
        ProjectMcpBody {
            session_id: sid.into(),
            action: action.into(),
            name: Some("Roblox_Studio".into()),
            url: None,
            command: Some("cmd.exe".into()),
            args: Some(vec!["/c".into(), "%LOCALAPPDATA%\\Roblox\\mcp.bat".into()]),
        }
    }

    async fn first_pending_id(state: &Arc<DaemonState>) -> String {
        for _ in 0..200 {
            if let Some(id) = state.pending.lock().await.keys().next().cloned() {
                return id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("no approval card was raised");
    }

    fn listed_names(state: &DaemonState, project_id: &str) -> Vec<String> {
        listed(state, project_id).into_iter().map(|s| s.name).collect()
    }

    /// The card is the whole safety property: nothing is stored while it is open or
    /// after a deny, and it shows the exact command.
    #[tokio::test]
    async fn an_add_stores_nothing_until_a_human_allows_the_card_showing_the_command() {
        let dir = non_ephemeral_tempdir();
        let s = state();
        let (sid, project_id) = chat_in_project(&s, dir.path());
        let mut rx = s.notifier.subscribe();

        let (st, b) = (s.clone(), body(&sid, "add"));
        let call = tokio::spawn(async move { project_mcp(&st, b).await });

        let id = first_pending_id(&s).await;
        let prompts = s.list_prompts().await;
        let card = prompts.iter().find(|p| p["id"] == id.as_str()).expect("card is listed");
        assert_eq!(card["payload"]["tool_name"], PROJECT_MCP_TOOL);
        assert_eq!(card["payload"]["input"]["command"], "cmd.exe");
        assert_eq!(card["payload"]["input"]["args"][1], "%LOCALAPPDATA%\\Roblox\\mcp.bat");
        assert!(listed_names(&s, &project_id).is_empty(), "nothing is saved while the card is open");

        let tx = s.pending.lock().await.remove(&id).unwrap();
        tx.send(json!({"behavior": "allow"})).unwrap();
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(true), "got {v}");
        assert_eq!(listed_names(&s, &project_id), vec!["Roblox_Studio".to_string()]);

        let mut told_app = false;
        while let Ok(frame) = rx.try_recv() {
            if frame["method"] == "project_mcp_servers_set" {
                assert_eq!(frame["params"]["project_id"], json!(project_id));
                assert_eq!(frame["params"]["servers"][0]["command"], "cmd.exe");
                told_app = true;
            }
        }
        assert!(told_app, "the app process is told to persist the list");
    }

    #[tokio::test]
    async fn a_deny_leaves_the_list_empty_and_says_so() {
        let dir = non_ephemeral_tempdir();
        let s = state();
        let (sid, project_id) = chat_in_project(&s, dir.path());
        let (st, b) = (s.clone(), body(&sid, "add"));
        let call = tokio::spawn(async move { project_mcp(&st, b).await });

        let id = first_pending_id(&s).await;
        let tx = s.pending.lock().await.remove(&id).unwrap();
        tx.send(json!({"behavior": "deny", "message": "no"})).unwrap();
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().starts_with("not added"), "got {v}");
        assert!(listed_names(&s, &project_id).is_empty());
    }

    #[tokio::test]
    async fn a_bad_entry_is_refused_before_any_card_is_raised() {
        let dir = non_ephemeral_tempdir();
        let s = state();
        let (sid, _) = chat_in_project(&s, dir.path());
        let mut both = body(&sid, "add");
        both.url = Some("http://127.0.0.1:1/mcp".into());
        let mut reserved = body(&sid, "add");
        reserved.name = Some("cc_conductor".into());

        for b in [both, reserved, body("ghost", "add")] {
            assert_eq!(project_mcp(&s, b).await["ok"], json!(false));
        }
        assert!(s.pending.lock().await.is_empty(), "no card for a refused entry");
    }

    #[tokio::test]
    async fn list_and_remove_need_no_card() {
        let dir = non_ephemeral_tempdir();
        let s = state();
        let (sid, project_id) = chat_in_project(&s, dir.path());
        s.settings.set_project_mcp_servers(
            &project_id,
            &[ProjectMcpServer {
                name: "Roblox_Studio".into(),
                url: String::new(),
                command: "cmd.exe".into(),
                args: vec!["/c".into()],
            }],
        );

        let listing = project_mcp(&s, body(&sid, "list")).await;
        assert_eq!(listing["servers"][0]["name"], "Roblox_Studio");
        assert_eq!(listing["servers"][0]["command"], "cmd.exe");

        let removed = project_mcp(&s, body(&sid, "remove")).await;
        assert_eq!(removed["ok"], json!(true), "got {removed}");
        assert!(listed_names(&s, &project_id).is_empty());
        assert!(s.pending.lock().await.is_empty());
        assert_eq!(project_mcp(&s, body(&sid, "remove")).await["ok"], json!(false), "already gone");
    }
}
