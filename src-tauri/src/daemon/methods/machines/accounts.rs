//! The new-chat account picker for a chat started on ANOTHER machine: the
//! picker has to list the host's accounts (ids are per-machine), preselect the
//! host's binding for the project, and save a pick as that binding on the host.
//!
//! Wrappers (`list_machine_accounts`, `set_machine_project_account`) are `P` in
//! the transport table and forward to the host's peer-only halves
//! (`peer_accounts`, `peer_set_project_account`, mask `M`). Only an account's
//! display fields cross the wire: never `config_dir`, `chrome_profile_dir`,
//! `org_uuid` or any other path or identity token.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::accounts::Account;
use crate::daemon::machines::forward::{map_peer_err, resolve_peer_client};
use crate::daemon::methods::pr_review::is_known_cwd;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;

/// The only keys of an account that leave a machine.
const ACCOUNT_FIELDS: [&str; 6] = ["id", "label", "colour", "icon", "email", "subscription_tier"];

fn redact_account(a: &Account) -> Value {
    json!({
        "id": a.id,
        "label": a.label,
        "colour": a.colour,
        "icon": a.icon,
        "email": a.email,
        "subscription_tier": a.subscription_tier,
    })
}

/// `{accounts, default_account_id, project_account_id}` for this machine, in
/// the redacted shape. `project_account_id` is the binding for `cwd`; a cwd
/// this daemon doesn't know yields no binding rather than an error, since the
/// picker still has to list accounts for a project the host has never seen.
fn picker_data(
    state: &DaemonState,
    registry: &[Account],
    cwd: Option<&str>,
) -> Value {
    let settings = state.settings.snapshot();
    let project_account = cwd.filter(|c| is_known_cwd(state, c)).and_then(|c| {
        crate::settings::identity::resolve_effective_preferred_account_id(
            &settings.projects,
            std::path::Path::new(c),
        )
    });
    // An API-credit account is never preselected, so a default or project
    // binding that points at one is reported as unset.
    let project_account = crate::accounts::without_api_credit_in(registry, project_account);
    let default_account = crate::accounts::without_api_credit_in(registry, settings.default_account_id.clone());
    json!({
        "accounts": registry.iter().map(redact_account).collect::<Vec<_>>(),
        "default_account_id": default_account,
        "project_account_id": project_account,
    })
}

/// Re-picks the allowed fields from a peer's answer. The result goes on to the
/// phone or webview, so a peer that sent more (an older build, a bug) must not
/// have the extra fields relayed.
fn repick(raw: &Value) -> Value {
    let accounts: Vec<Value> = raw["accounts"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|a| {
                    let mut out = Map::new();
                    for k in ACCOUNT_FIELDS {
                        out.insert(k.to_string(), a.get(k).cloned().unwrap_or(Value::Null));
                    }
                    Value::Object(out)
                })
                .collect()
        })
        .unwrap_or_default();
    let id_or_null = |k: &str| raw.get(k).and_then(Value::as_str).map_or(Value::Null, |s| json!(s));
    json!({
        "accounts": accounts,
        "default_account_id": id_or_null("default_account_id"),
        "project_account_id": id_or_null("project_account_id"),
    })
}

/// Binds `account_id` to `cwd`'s project here, after checking both: the cwd
/// must be a project this daemon already knows (a peer may only touch existing
/// projects, like `start_session`) and the account must be in `registry`.
/// Publishes `project_account_set` so the app process persists the binding.
fn bind_account(
    state: &DaemonState,
    registry: &[Account],
    cwd: &str,
    account_id: &str,
) -> Result<(), RpcError> {
    if !is_known_cwd(state, cwd) {
        return Err(RpcError::invalid_params("unknown cwd"));
    }
    if !registry.iter().any(|a| a.id == account_id) {
        return Err(RpcError::invalid_params(format!("account {account_id} not found in the registry")));
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    if !state.settings.bind_project_account(std::path::Path::new(cwd), account_id, &now) {
        return Err(RpcError::invalid_params("this folder cannot be saved as a project"));
    }
    state.notifier.publish(
        "project_account_set",
        json!({ "cwd": cwd, "account_id": account_id, "now": now }),
    );
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ListParams {
    machine_id: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PeerListParams {
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SetParams {
    machine_id: String,
    cwd: String,
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct PeerSetParams {
    cwd: String,
    account_id: String,
}

pub(super) fn register(router: &mut Router, state: Arc<DaemonState>) {
    // The picker's read. `machine_id == self` answers from this daemon; a peer
    // forwards to its `peer_accounts`, which also resolves the host's own
    // binding for `cwd` so the preselect needs no second round trip.
    router.register("list_machine_accounts", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: ListParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                if crate::daemon::machines::is_self_machine(&state, &req.machine_id) {
                    return Ok(picker_data(&state, &crate::accounts::load_registry(), req.cwd.as_deref()));
                }
                let client = resolve_peer_client(&state, &req.machine_id).await?;
                let raw = client
                    .call("peer_accounts", json!({ "cwd": req.cwd }))
                    .await
                    .map_err(map_peer_err)?;
                Ok(repick(&raw))
            }
        }
    });

    // Host half of the read, callable only by a paired machine (mask M). The
    // answer is decided here, never by a param, so it is always the redacted shape.
    router.register("peer_accounts", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: PeerListParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(picker_data(&state, &crate::accounts::load_registry(), req.cwd.as_deref()))
            }
        }
    });

    // Saves a pick as the host's binding for the project. A peer only: this
    // machine's own bindings keep their desktop-only `update_project` path, so
    // a phone cannot rebind its own desktop's projects through here.
    router.register("set_machine_project_account", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: SetParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                if crate::daemon::machines::is_self_machine(&state, &req.machine_id) {
                    return Err(RpcError::invalid_params("machine_id must name a paired machine"));
                }
                let client = resolve_peer_client(&state, &req.machine_id).await?;
                client
                    .call(
                        "peer_set_project_account",
                        json!({ "cwd": req.cwd, "account_id": req.account_id }),
                    )
                    .await
                    .map_err(map_peer_err)?;
                Ok(json!({ "ok": true }))
            }
        }
    });

    // Host half of the write (mask M, and drive-gated in `peer_scope`: it is
    // deliberately not SEE_ONLY, so a view-only peer is refused).
    router.register("peer_set_project_account", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: PeerSetParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                bind_account(&state, &crate::accounts::load_registry(), &req.cwd, &req.account_id)?;
                Ok(json!({ "ok": true }))
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::PeerMachine;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn account(id: &str, label: &str) -> Account {
        Account {
            id: id.into(),
            label: label.into(),
            colour: "#112233".into(),
            icon: "briefcase".into(),
            config_dir: std::path::PathBuf::from("C:/secret/config-dir"),
            chrome_profile_dir: std::path::PathBuf::from("C:/secret/chrome-profile"),
            email: format!("{id}@example.test"),
            org_uuid: "dummy-org-uuid".into(),
            subscription_tier: "max".into(),
            created_at: "2026-10-01T00:00:00Z".into(),
            fleet_eligible: false,
            kind: crate::accounts::AccountKind::Subscription,
        }
    }

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn state_with(settings: Settings) -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    fn project_at(path: &std::path::Path, preferred: Option<&str>) -> crate::types::ProjectConfig {
        let mut p = crate::types::ProjectConfig {
            id: "proj1".into(),
            path: path.to_path_buf(),
            name: "proj1".into(),
            avatar: crate::types::Avatar::None,
            automation: None,
            created_at: "2026-09-05T00:00:00Z".into(),
            last_active_at: None,
            whitelist: Default::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
            claude_ai_connectors: false,
            tracker: None,
            keep_running_in_gaming_mode: false,
        };
        p.preferred_account_id = preferred.map(str::to_string);
        p
    }

    async fn call(router: &Router, method: &str, params: Value) -> crate::daemon::rpc::Response {
        router
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
                dummy_ctx(),
            )
            .await
    }

    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    /// A state paired to `mach-b` (online) listening on `b_port`.
    fn state_paired_to_b(app_dir: &std::path::Path, b_data_dir: &std::path::Path, b_port: u16) -> Arc<DaemonState> {
        let state = state_with(Settings::default());
        state.init_machines(app_dir.to_path_buf());
        state.machines.get().unwrap().ensure_self();
        let (token, _device_id) = DeviceRegistry::add_machine_device("A", "mach-a", b_data_dir).unwrap();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        state.mirror.set_instances("mach-b", "B", vec![]);
        state.mirror.set_online("mach-b", true);
        state
    }

    #[test]
    fn the_host_answer_names_only_display_fields_and_resolves_its_own_binding() {
        let proj_dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.default_account_id = Some("acct-default".into());
        settings.projects.push(project_at(proj_dir.path(), Some("acct-bound")));
        let state = state_with(settings);
        let registry = [account("acct-default", "Default"), account("acct-bound", "Bound")];

        let cwd = proj_dir.path().to_string_lossy().into_owned();
        let out = picker_data(&state, &registry, Some(&cwd));

        assert_eq!(keys(&out), ["accounts", "default_account_id", "project_account_id"]);
        assert_eq!(out["default_account_id"], json!("acct-default"));
        assert_eq!(out["project_account_id"], json!("acct-bound"));
        let list = out["accounts"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        for a in list {
            assert_eq!(keys(a), ["colour", "email", "icon", "id", "label", "subscription_tier"]);
        }
        let serialized = out.to_string();
        for leaked in ["config-dir", "chrome-profile", "dummy-org-uuid", "config_dir", "org_uuid", "chrome_profile_dir"] {
            assert!(!serialized.contains(leaked), "{leaked} must not cross the wire: {serialized}");
        }
    }

    #[test]
    fn an_unknown_cwd_has_no_binding_but_still_lists_accounts() {
        let state = state_with(Settings::default());
        let out = picker_data(&state, &[account("a", "A")], Some("Z:/nowhere/at/all"));
        assert_eq!(out["project_account_id"], Value::Null);
        assert_eq!(out["accounts"].as_array().unwrap().len(), 1);
        let no_cwd = picker_data(&state, &[account("a", "A")], None);
        assert_eq!(no_cwd["project_account_id"], Value::Null);
    }

    #[test]
    fn repick_drops_every_field_a_peer_adds() {
        let raw = json!({
            "accounts": [{
                "id": "a", "label": "A", "colour": "#fff", "icon": "x", "email": "a@x.test",
                "subscription_tier": "pro",
                "config_dir": "C:/leak", "chrome_profile_dir": "C:/leak2", "org_uuid": "leak3",
            }],
            "default_account_id": "a",
            "project_account_id": null,
            "settings": {"apiKey": "dummy-secret"},
        });
        let out = repick(&raw);
        assert_eq!(keys(&out), ["accounts", "default_account_id", "project_account_id"]);
        assert_eq!(keys(&out["accounts"][0]), ["colour", "email", "icon", "id", "label", "subscription_tier"]);
        assert_eq!(out["default_account_id"], json!("a"));
        assert_eq!(out["project_account_id"], Value::Null);
        assert!(!out.to_string().contains("leak"));
    }

    #[tokio::test]
    async fn peer_accounts_dispatches_and_answers_in_the_redacted_shape() {
        let state = state_with(Settings::default());
        let mut r = Router::new();
        register(&mut r, state);
        let resp = call(&r, "peer_accounts", json!({})).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let out = resp.result.unwrap();
        assert_eq!(keys(&out), ["accounts", "default_account_id", "project_account_id"]);
        // Whatever accounts.json holds on this machine, none may carry a path.
        for a in out["accounts"].as_array().unwrap() {
            assert_eq!(keys(a), ["colour", "email", "icon", "id", "label", "subscription_tier"]);
        }
    }

    #[tokio::test]
    async fn list_machine_accounts_self_answers_locally() {
        let dir = tempdir().unwrap();
        let state = state_with(Settings::default());
        state.init_machines(dir.path().to_path_buf());
        let mine = state.machines.get().unwrap().ensure_self();
        let mut r = Router::new();
        register(&mut r, state);
        let resp = call(&r, "list_machine_accounts", json!({"machine_id": mine.machine_id})).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        assert_eq!(keys(&resp.result.unwrap()), ["accounts", "default_account_id", "project_account_id"]);
    }

    #[tokio::test]
    async fn list_machine_accounts_unknown_machine_is_invalid_params() {
        let dir = tempdir().unwrap();
        let state = state_with(Settings::default());
        state.init_machines(dir.path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        let mut r = Router::new();
        register(&mut r, state);
        let resp = call(&r, "list_machine_accounts", json!({"machine_id": "ghost"})).await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn list_machine_accounts_forwards_with_the_cwd_and_keeps_only_the_allowed_fields() {
        let (dir, peer_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let seen_cwd = Arc::new(std::sync::Mutex::new(None::<Value>));
        let seen = seen_cwd.clone();
        let mut b_router = Router::new();
        b_router.register("peer_accounts", move |params, _ctx| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap() = params.as_ref().and_then(|p| p.get("cwd")).cloned();
                Ok::<Value, RpcError>(json!({
                    "accounts": [{
                        "id": "win-1", "label": "Work", "colour": "#abc", "icon": "briefcase",
                        "email": "work@x.test", "subscription_tier": "max",
                        "config_dir": "C:/Users/win/.claude-work", "org_uuid": "dummy-org",
                    }],
                    "default_account_id": "win-1",
                    "project_account_id": "win-1",
                    "settings": {"apiKey": "dummy-secret"},
                }))
            }
        });
        let b_state = state_with(Settings::default());
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);
        let state = state_paired_to_b(dir.path(), peer_dir.path(), b_port);

        let mut r = Router::new();
        register(&mut r, state);
        let resp = call(&r, "list_machine_accounts", json!({"machine_id": "mach-b", "cwd": "C:/win/proj"})).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        assert_eq!(
            resp.result.unwrap(),
            json!({
                "accounts": [{
                    "id": "win-1", "label": "Work", "colour": "#abc", "icon": "briefcase",
                    "email": "work@x.test", "subscription_tier": "max",
                }],
                "default_account_id": "win-1",
                "project_account_id": "win-1",
            })
        );
        assert_eq!(seen_cwd.lock().unwrap().clone(), Some(json!("C:/win/proj")));
        b_serve.kill();
    }

    #[tokio::test]
    async fn set_machine_project_account_forwards_to_the_host() {
        let (dir, peer_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(None::<Value>));
        let rec = seen.clone();
        let mut b_router = Router::new();
        b_router.register("peer_set_project_account", move |params, _ctx| {
            let rec = rec.clone();
            async move {
                *rec.lock().unwrap() = params;
                Ok::<Value, RpcError>(json!({"ok": true}))
            }
        });
        let b_state = state_with(Settings::default());
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);
        let state = state_paired_to_b(dir.path(), peer_dir.path(), b_port);

        let mut r = Router::new();
        register(&mut r, state);
        let resp = call(
            &r,
            "set_machine_project_account",
            json!({"machine_id": "mach-b", "cwd": "C:/win/proj", "account_id": "win-1"}),
        )
        .await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        assert_eq!(resp.result.unwrap(), json!({"ok": true}));
        assert_eq!(
            seen.lock().unwrap().clone(),
            Some(json!({"cwd": "C:/win/proj", "account_id": "win-1"})),
            "the host gets the project folder and ITS account id, never the machine id"
        );
        b_serve.kill();
    }

    #[tokio::test]
    async fn set_machine_project_account_refuses_this_machine() {
        let dir = tempdir().unwrap();
        let state = state_with(Settings::default());
        state.init_machines(dir.path().to_path_buf());
        let mine = state.machines.get().unwrap().ensure_self();
        let mut r = Router::new();
        register(&mut r, state);
        let resp = call(
            &r,
            "set_machine_project_account",
            json!({"machine_id": mine.machine_id, "cwd": "C:/x", "account_id": "a"}),
        )
        .await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn the_host_saves_the_pick_as_the_projects_binding_and_tells_the_app() {
        let proj_dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.projects.push(project_at(proj_dir.path(), None));
        let state = state_with(settings);
        let mut rx = state.notifier.subscribe();
        let cwd = proj_dir.path().to_string_lossy().into_owned();

        bind_account(&state, &[account("acct-win", "Win")], &cwd, "acct-win").unwrap();

        assert_eq!(state.settings.snapshot().projects[0].preferred_account_id.as_deref(), Some("acct-win"));
        let frame = rx.recv().await.expect("frame");
        assert_eq!(frame["method"], json!("project_account_set"));
        assert_eq!(frame["params"]["cwd"], json!(cwd));
        assert_eq!(frame["params"]["account_id"], json!("acct-win"));
    }

    #[test]
    fn the_host_refuses_a_bind_for_an_unknown_folder_or_account() {
        let proj_dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.projects.push(project_at(proj_dir.path(), None));
        let state = state_with(settings);
        let cwd = proj_dir.path().to_string_lossy().into_owned();
        let registry = [account("acct-win", "Win")];

        let unknown_cwd = bind_account(&state, &registry, "Z:/not/a/project", "acct-win").unwrap_err();
        assert_eq!(unknown_cwd.message, "unknown cwd");
        let unknown_acct = bind_account(&state, &registry, &cwd, "acct-mac-only").unwrap_err();
        assert!(unknown_acct.message.contains("acct-mac-only"), "{}", unknown_acct.message);
        assert_eq!(state.settings.snapshot().projects[0].preferred_account_id, None);
    }
}
