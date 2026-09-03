//! Read-mostly listing RPCs: instances, accounts, project groups, history
//! pages/events, auto-accept flags, chat-state, plus the two registry
//! mutators that create a new instance entry (register_historical,
//! takeover_manual).

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_listings(router: &mut Router, state: Arc<DaemonState>) {
    // Persist a chat's auto-accept-permissions toggle. The daemon is the sole
    // writer of chat-config.json, so both the desktop app (forwarding via the
    // daemon client) and the phone (direct remote RPC) funnel through here.
    router.register("set_auto_accept", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { session_id: String, value: bool }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            crate::sessions::chat_config::set_auto_accept(&p.session_id, p.value);
            Ok(json!({"ok": true}))
        }
    });
    // Session ids with auto-accept enabled, so a freshly-launched client seeds
    // its gate. Read-only; mirrors the desktop `list_auto_accept` Tauri command.
    router.register("list_auto_accept", move |_params, _ctx| {
        async move { Ok(json!(crate::sessions::chat_config::list_auto_accept())) }
    });
    // Read-only; mirrors the desktop `get_chat_state` Tauri command so a
    // remote/phone client can seed the same unread-vs-stale judgement a
    // freshly-opened desktop window would.
    router.register("get_chat_state", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { session_id: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            Ok(json!(crate::sessions::chat_state::get(&p.session_id)))
        }
    });
    {
        let state = state.clone();
        router.register("register_historical", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct HistoricalParams { session_id: String, cwd: String, account_id: String }
                let p: HistoricalParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = std::path::PathBuf::from(&p.cwd);
                let now = chrono::Utc::now().to_rfc3339();
                let (project_id, created_new) = {
                    let mut snap = state.settings.snapshot();
                    crate::settings::upsert_project_for_cwd(&mut snap, &cwd, &now)
                };
                if created_new {
                    state.notifier.publish("project_created", json!({
                        "project_id": project_id, "cwd": p.cwd, "now": now,
                    }));
                }
                state.registry.upsert_interactive(&p.session_id, &cwd, &project_id, &now);
                // A historical session was never associated with an account in
                // this run (the registry entry may be brand new, or a stale one
                // from before account tracking existed) - record the account the
                // user picked in the "Continue this chat" confirmation, same
                // reasoning as chat::takeover::takeover.
                state.registry.set_account(&p.session_id, &p.account_id);
                crate::sessions::chat_config::set_account(&p.session_id, &p.account_id);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("takeover_manual", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct TakeoverParams { manual_pid: u32, model: String, effort: String, account_id: String }
                let p: TakeoverParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let shim = std::sync::Mutex::new(state.settings.snapshot());
                let sid = crate::chat::takeover::takeover(p.manual_pid, &p.model, &p.effort, &p.account_id, &state.registry, &shim)
                    .map_err(|e| RpcError::internal(e.to_string()))?;
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": sid}))
            }
        });
    }
    // Snapshot fetch so a freshly-connected app can seed its instance cache
    // without waiting for the next instances_changed notification (ai_todo 63).
    {
        let state = state.clone();
        router.register("list_instances", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.registry.list())) }
        });
    }
    // Read-only account list, exposed over the remote-access API so the phone's
    // new-chat account picker can list the same accounts as desktop. Without it
    // the picker is empty and "Start session" stays permanently disabled, which
    // is why chats couldn't be started from mobile at all (ai_todo 241).
    // `accounts::load_registry()` reads the shared on-disk accounts.json - the
    // SAME file the daemon already reads to resolve `start_session`'s account_id
    // - so the daemon process serves it fine. Identical serde shape to the
    // `list_accounts` Tauri command (frontend `Account[]`).
    {
        router.register("list_accounts", move |_params, _ctx| {
            async move { Ok(json!(crate::accounts::load_registry())) }
        });
    }
    // Read-only project-groups list, mirroring the `list_project_groups` Tauri
    // command's JSON shape (frontend `ProjectGroup[]`). Reuses the same PURE
    // `build_groups` helper; inputs are sourced daemon-side: `projects` from the
    // in-memory settings cache, `instances` from the registry snapshot (same as
    // `list_instances`), and `token_history` from the `token_records` table.
    {
        let state = state.clone();
        router.register("list_project_groups", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let projects = state.settings.snapshot().projects;
                let instances = state.registry.list();
                let now_ms = chrono::Utc::now().timestamp_millis();
                let db = state.db.clone();
                let groups = tokio::task::spawn_blocking(move || {
                    let token_history = db
                        .as_ref()
                        .map(|db| {
                            let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                            crate::storage::token_store::get_token_records(mgr.conn(), 0)
                                .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    let mut groups = crate::ipc::project_groups::groups_test_helpers::build_groups(
                        &projects, &token_history, &instances, now_ms,
                    );
                    for g in &mut groups {
                        g.path_exists = std::path::Path::new(&g.path).exists();
                    }
                    // Keep the phone's project picker / Projects view free of
                    // the "jarvis-home" pseudo-project and temp-dir scratch
                    // sessions, mirroring the desktop Tauri command - see
                    // `filter_out_jarvis_home`/`filter_out_ephemeral_projects`.
                    // `fold_worktrees` also mirrors desktop, collapsing worktree
                    // rows into their main repo instead of listing them flat.
                    let groups = crate::ipc::project_groups::groups_test_helpers::filter_out_jarvis_home(
                        crate::ipc::project_groups::fold_worktrees(groups),
                    );
                    crate::ipc::project_groups::groups_test_helpers::filter_out_ephemeral_projects(groups)
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(groups))
            }
        });
    }
    // Paginated transcript reader exposed over the remote-access API so that the
    // phone/browser client can load past conversation history without a Tauri
    // runtime. Reuses the same JSONL logic as the desktop `load_history_page`
    // Tauri command; no parsing is duplicated.
    router.register("load_history_page", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct HistoryPageParams {
                session_id: String,
                cwd: Option<String>,
                before_seq: Option<u64>,
                message_limit: u32,
            }
            let p: HistoryPageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            // Validate the session id (reuse the same check as the IPC layer to
            // reject path-traversal attempts before any filesystem access).
            crate::ipc::chat::attachments::validate_session_id(&p.session_id)
                .map_err(|e| RpcError::invalid_params(e))?;
            let limit = p.message_limit.clamp(1, 500);
            // Filesystem + JSONL parsing is synchronous IO; run on blocking pool.
            tokio::task::spawn_blocking(move || {
                crate::chat::history::read_page_for_session(
                    &p.session_id,
                    p.cwd.as_deref(),
                    p.before_seq,
                    limit,
                )
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?
            .map(|page| serde_json::to_value(page).unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::internal(e))
        }
    });
    // Mirrors the desktop `load_event_detail` Tauri command: fetch one
    // ToolResult's untruncated output, addressed by the `full_seq` a
    // `load_history_page` preview carried plus its tool_use_id.
    router.register("load_event_detail", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct EventDetailParams {
                session_id: String,
                cwd: Option<String>,
                seq: u64,
                tool_use_id: String,
            }
            let p: EventDetailParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            crate::ipc::chat::attachments::validate_session_id(&p.session_id)
                .map_err(|e| RpcError::invalid_params(e))?;
            tokio::task::spawn_blocking(move || {
                let path = crate::chat::history::locate_transcript(
                    &p.session_id,
                    p.cwd.as_deref(),
                )?;
                crate::chat::history::read_single_event(&path, p.seq, &p.tool_use_id)
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?
            .map(|ev| serde_json::to_value(ev).unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::internal(e))
        }
    });
}
