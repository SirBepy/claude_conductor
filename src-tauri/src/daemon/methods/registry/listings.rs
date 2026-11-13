//! Read-mostly listing RPCs: instances, accounts, project groups, history
//! pages/events, auto-accept flags, chat-state, plus the two registry
//! mutators that create a new instance entry (register_historical,
//! takeover_manual).

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// The phone's project-picker list, shared by `list_project_groups` and
/// `new_session_bundle` so the two can never disagree on which rows exist.
pub(super) async fn project_groups(
    state: &Arc<DaemonState>,
) -> Result<Vec<crate::types::ProjectGroup>, RpcError> {
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
        let groups = crate::ipc::project_groups::groups_test_helpers::filter_out_ephemeral_projects(groups);
        // Dead token-history-only rows (the `wf_*` worktree scratch
        // pile) - same prune the desktop command applies.
        crate::ipc::project_groups::groups_test_helpers::filter_out_history_only_ghosts(groups)
    })
    .await
    .map_err(|e| RpcError::internal(format!("join: {e}")))?;
    Ok(groups)
}

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
    // Persist a chat's "Use subchats" toggle. Same sole-writer shape as
    // set_auto_accept, plus two rules the daemon owns (`subchats::apply_set_on`):
    // an API-credit chat is refused, and turning it on raises the chat's effort to
    // high (model unchanged) through the registry (applied at its next send, never killing a
    // running turn).
    {
        let state = state.clone();
        router.register("set_subchats_on", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: String, value: bool }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let applied = crate::daemon::subchats::apply_set_on(
                    &state,
                    &p.session_id,
                    p.value,
                    &crate::accounts::load_registry(),
                    crate::sessions::chat_config::set_subchats_on,
                )?;
                // After the write, so a client that re-reads on this nudge sees the new set.
                crate::daemon::subchats::publish_mode_changed(&state);
                if let Some((model, effort)) = applied {
                    crate::sessions::chat_config::record(&p.session_id, &model, &effort);
                    crate::daemon::machines::publish_instances_changed(&state);
                    crate::sessions::persistence::save_snapshot_default(&state.registry);
                }
                Ok(json!({"ok": true}))
            }
        });
    }
    // "Move to sidebar" on a sub read in place: it becomes an ordinary chat for
    // good (`subchats::move_to_sidebar` lists what that clears).
    {
        let state = state.clone();
        router.register("move_sub_to_sidebar", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::subchats::move_to_sidebar(&state, &p.session_id)
                    .await
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!({"ok": true}))
            }
        });
    }
    // The reverse, from the sidebar chat's menu: turns an ordinary chat into a sub of
    // the main chat Joe picked (`subchats::adopt` lists what that sets and refuses).
    {
        let state = state.clone();
        router.register("move_chat_into_main", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: String, main_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::subchats::adopt::move_into_main(&state, &p.session_id, &p.main_id)
                    .await
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!({"ok": true}))
            }
        });
    }
    // The picker's default: the main chat this chat last drew a card in, or null.
    {
        let state = state.clone();
        router.register("former_main_chat", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                Ok(json!(crate::daemon::subchats::adopt::former_main_chat(&state, &p.session_id)))
            }
        });
    }
    // Session ids with the subchats mode on, so a freshly-launched client seeds
    // its menu-toggle state. Read-only; mirrors `list_auto_accept`.
    router.register("list_subchats_on", move |_params, _ctx| {
        async move { Ok(json!(crate::sessions::chat_config::list_subchats_on())) }
    });
    // A main chat's sub cards (verdicts, blockers, "all finished"), oldest
    // first. The chat merges them into its own transcript by timestamp.
    router.register("list_subchat_cards", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { session_id: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            Ok(json!(crate::daemon::subchats::card_log::read(&p.session_id)))
        }
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
                crate::daemon::machines::publish_instances_changed(&state);
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
                    .await
                    .map_err(|e| RpcError::internal(e.to_string()))?;
                crate::daemon::machines::publish_instances_changed(&state);
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
            async move { Ok(json!(crate::daemon::machines::all_instances(&state))) }
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
            async move { Ok(json!(project_groups(&state).await?)) }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    /// A flip made on one surface must reach the others: every client keeps the set
    /// of mode-on chats in memory, seeded once at boot, so without this nudge a flip
    /// from the phone only showed in the desktop sidebar after a reload.
    #[tokio::test]
    async fn turning_the_mode_on_tells_every_client_to_re_read_the_set() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("mode-flip", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        let mut router = Router::new();
        register_listings(&mut router, state.clone());
        let mut rx = state.notifier.subscribe();
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "set_subchats_on".into(),
                    params: Some(json!({"session_id": "mode-flip", "value": true})),
                },
                ConnectionContext::new(tx),
            )
            .await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let mut methods = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            methods.push(frame["method"].as_str().unwrap_or("").to_string());
        }
        assert!(methods.contains(&"subchats_on_changed".to_string()), "{methods:?}");
        assert_eq!(crate::sessions::chat_config::list_subchats_on(), ["mode-flip"]);
    }

    /// A refused flip changed nothing, so nobody is told.
    #[tokio::test]
    async fn a_refused_flip_publishes_nothing() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("sub-main", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        state.registry.upsert_interactive("sub-flip", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        state.registry.set_subchat_of("sub-flip", Some("sub-main".into()));
        let mut router = Router::new();
        register_listings(&mut router, state.clone());
        let mut rx = state.notifier.subscribe();
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "set_subchats_on".into(),
                    params: Some(json!({"session_id": "sub-flip", "value": true})),
                },
                ConnectionContext::new(tx),
            )
            .await;
        assert!(resp.error.is_some(), "a sub cannot use subchats itself");
        while let Ok(frame) = rx.try_recv() {
            assert_ne!(frame["method"], "subchats_on_changed");
        }
    }
}
