//! Project dashboard RPCs: groups, custom cards, per-scope hidden builtins, and
//! the project-keyed todo tick. Desktop pipe only: none of these names is in
//! `remote_transport_table::TRANSPORT_TABLE`, so a phone or a paired machine is
//! refused (card configs hold commands and URLs, and may only be written from
//! this PC). `pub(crate)` because `hooks_server::dashboard_card` calls
//! `cards::dashboard_card_tool` directly, with no Router in scope.

pub(crate) mod cards;
mod gather;
mod history;
mod layout;
mod read;
mod seed;
mod snapshot;

pub(crate) use seed::ensure_seeded;

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::project_dashboard::{store, CardResult, Scope};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Arc;

/// Every dashboard mutation says the same thing: re-read. The dashboard also
/// refetches on open and on focus, per `project_daemon_notifier_broadcast_lossy`,
/// so a dropped frame costs freshness, never correctness.
pub(super) fn publish_changed(state: &DaemonState) {
    state.notifier.publish("dashboard_changed", json!({}));
}

fn parse<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

fn to_json<T: serde::Serialize>(v: &T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| RpcError::internal(e.to_string()))
}

fn storage_unavailable() -> RpcError {
    RpcError::internal("dashboard storage unavailable")
}

#[derive(serde::Deserialize)]
struct IdOnly {
    id: String,
}

pub fn register_project_dashboard(router: &mut Router, state: Arc<DaemonState>) {
    read::register_read(router, state.clone());
    layout::register_layout(router, state.clone());
    {
        let state = state.clone();
        router.register("dashboard_group_upsert", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    #[serde(default)]
                    id: Option<String>,
                    name: String,
                    #[serde(default)]
                    repos: Vec<String>,
                }
                let p: P = parse(params)?;
                if p.name.trim().is_empty() {
                    return Err(RpcError::invalid_params("name is required"));
                }
                let group = store::update(|s| {
                    let id = s.upsert_group(p.id.as_deref(), p.name.trim(), p.repos);
                    s.groups.iter().find(|g| g.id == id).cloned()
                })
                .flatten()
                .ok_or_else(storage_unavailable)?;
                publish_changed(&state);
                to_json(&group)
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_group_delete", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: IdOnly = parse(params)?;
                let removed = store::update(|s| s.delete_group(&p.id)).ok_or_else(storage_unavailable)?;
                if removed {
                    // The group's cards went with it, so their cached results are orphans.
                    cards::prune_cache_to_live_cards();
                    publish_changed(&state);
                }
                Ok(json!({"ok": true, "removed": removed}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_card_refresh", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: IdOnly = parse(params)?;
                let st = store::load();
                let card = cards::refreshable_card(&st.cards, &p.id).map_err(RpcError::invalid_params)?;
                let result: CardResult = cards::run_and_cache(card, &st.groups).await;
                publish_changed(&state);
                to_json(&result)
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_card_set_enabled", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    id: String,
                    enabled: bool,
                }
                let p: P = parse(params)?;
                let found = store::update(|s| s.set_card_enabled(&p.id, p.enabled)).ok_or_else(storage_unavailable)?;
                if !found {
                    return Err(RpcError::invalid_params(format!("no such card: {}", p.id)));
                }
                publish_changed(&state);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_card_delete", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: IdOnly = parse(params)?;
                let removed = store::update(|s| s.delete_card(&p.id)).ok_or_else(storage_unavailable)?;
                if removed {
                    cards::prune_cache_to_live_cards();
                    publish_changed(&state);
                }
                Ok(json!({"ok": true, "removed": removed}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("dashboard_builtin_set_hidden", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    scope: Scope,
                    builtin: String,
                    hidden: bool,
                }
                let p: P = parse(params)?;
                let known = store::update(|s| s.set_builtin_hidden(&p.scope.scope_key(), &p.builtin, p.hidden))
                    .ok_or_else(storage_unavailable)?;
                if !known {
                    return Err(RpcError::invalid_params(format!("unknown builtin card: {}", p.builtin)));
                }
                publish_changed(&state);
                Ok(json!({"ok": true}))
            }
        });
    }
    router.register("dashboard_todo_set_state", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                project_id: String,
                id: String,
                next: String,
            }
            let p: P = parse(params)?;
            super::user_todos::set_user_todo_state_for_project(&state, &p.project_id, &p.id, &p.next)
                .map_err(RpcError::internal)
        }
    });
}

#[cfg(test)]
mod tests {
    use crate::daemon::remote_transport_table::allowed;
    use crate::daemon::rpc::Transport;

    /// Every method this module registers that only the desktop pipe may call:
    /// all card, group and pin writes. Kept next to the registration so a new
    /// method added there is one grep from these lists.
    const DESKTOP_ONLY: &[&str] = &[
        "dashboard_group_upsert",
        "dashboard_group_delete",
        "dashboard_card_set_enabled",
        "dashboard_card_delete",
        "dashboard_builtin_set_hidden",
        "dashboard_set_pinned_actions",
    ];

    /// The phone's Projects tab: reads, running a stored card, the todo
    /// checkbox and opening or closing a project in the list. Never a paired
    /// machine, which mirrors chats, not dashboards.
    const PHONE: &[&str] = &[
        "dashboard_open_target",
        "dashboard_close_target",
        "dashboard_card_refresh",
        "dashboard_todo_set_state",
        "dashboard_list_targets",
        "dashboard_snapshot",
        "dashboard_history",
        "dashboard_gallery_image",
    ];

    fn methods() -> Vec<&'static str> {
        DESKTOP_ONLY.iter().chain(PHONE).copied().collect()
    }

    #[test]
    fn dashboard_writes_are_desktop_only() {
        for m in DESKTOP_ONLY {
            assert!(!allowed(m, &Transport::Phone), "{m} must be desktop-pipe only (phone)");
            assert!(
                !allowed(m, &Transport::PeerMachine("peer-1".to_string())),
                "{m} must be desktop-pipe only (peer machine)"
            );
        }
    }

    #[test]
    fn the_phone_reads_dashboards_and_a_paired_machine_never_does() {
        for m in PHONE {
            assert!(allowed(m, &Transport::Phone), "{m} must be reachable from the phone");
            assert!(
                !allowed(m, &Transport::PeerMachine("peer-1".to_string())),
                "{m} must not be reachable from a peer machine"
            );
        }
    }

    #[test]
    fn every_dashboard_method_stays_callable_from_the_desktop_pipe() {
        for m in methods() {
            assert!(allowed(m, &Transport::Local), "{m} must stay callable from the desktop pipe");
        }
    }

    #[test]
    fn the_method_list_matches_what_the_router_registers() {
        let src = format!("{}{}{}", include_str!("mod.rs"), include_str!("read.rs"), include_str!("layout.rs"));
        let registered = src.matches("router.register(\"dashboard_").count();
        assert_eq!(registered, methods().len(), "the method lists and register_project_dashboard drifted");
        for m in methods() {
            assert!(src.contains(&format!("router.register(\"{m}\"")), "{m} is not registered");
        }
    }
}
