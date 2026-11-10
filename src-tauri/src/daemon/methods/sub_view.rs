//! What the chat dashboard's Subchats card asks the daemon about one sub
//! (docs/chat-dashboard-design.md, "Subchats card"): every image in its
//! transcript, and the Pin to sidemenu flag.
//!
//! Both are phone-reachable (`P` in `remote_transport_table::TRANSPORT_TABLE`)
//! because the chat menu they hang off is shared with the phone, and neither
//! exposes anything the phone's transcript and sidebar do not already show.

use super::super::rpc::{Router, RpcError};
use super::super::state::DaemonState;
use crate::project_dashboard::history_scan::{encode_image_id, facts_for};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// One image of a sub's transcript. `id` is the opaque gallery id the existing
/// `dashboard_gallery_image` turns into a data URL, so no bytes travel here.
#[derive(Debug, Serialize, PartialEq)]
pub struct SubImage {
    pub id: String,
    pub at_ms: i64,
}

/// Every image of one transcript, oldest first. This is `history_scan`'s own
/// scan (memoised by path and mtime), so a poll while the sub works costs a
/// stat until the transcript grows.
pub fn images_of_transcript(path: &Path) -> Vec<SubImage> {
    let Some(facts) = facts_for(path) else { return Vec::new() };
    facts
        .images
        .iter()
        .map(|img| SubImage { id: encode_image_id(path, img.offset, &img.block), at_ms: img.at_ms })
        .collect()
}

/// The sub's transcript, found by session id only. Never `latest_transcript_for_cwd`:
/// a sub shares its main chat's folder, so "the newest file there" is a
/// different chat's transcript.
fn transcript_of(state: &DaemonState, session_id: &str) -> Option<PathBuf> {
    if let Some(inst) = state.registry.get(session_id) {
        if let Some(p) = inst.transcript_path.as_deref().filter(|p| p.exists()) {
            return Some(p.to_path_buf());
        }
        if let Some(p) = crate::tokens::transcript_for_session(&inst.cwd, session_id) {
            return Some(p);
        }
    }
    crate::ipc::drain::resolve_session_from_history(session_id).map(|(_, path)| path)
}

/// Sets a sub's sidebar shortcut. Only a sub can be pinned: any other chat
/// already has its row.
pub fn set_pinned(state: &DaemonState, session_id: &str, pinned: bool) -> Result<bool, String> {
    let inst = state.registry.get(session_id).ok_or_else(|| format!("unknown session: {session_id}"))?;
    if !super::super::subchats::is_sub(&inst) {
        return Err(format!("{session_id} is not a sub"));
    }
    let changed = state.registry.set_pinned_to_sidebar(session_id, pinned);
    if changed {
        crate::sessions::persistence::save_snapshot_default(&state.registry);
        crate::daemon::machines::publish_instances_changed(state);
    }
    Ok(changed)
}

/// The job Joe's main chat gave this sub, as the three brief lines the details
/// show. `None` for a chat that is not a sub or has no stored brief.
pub fn brief_of(session_id: &str) -> Option<Value> {
    let brief = crate::sessions::chat_config::get(session_id)?.subchat?;
    Some(json!({ "task": brief.task, "goal": brief.goal, "done_when": brief.done_when }))
}

fn parse<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

pub fn register_sub_view(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("list_session_images", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P {
                    session_id: String,
                }
                let p: P = parse(params)?;
                // File IO and a full-file scan on a cold cache.
                let images = tokio::task::spawn_blocking(move || {
                    transcript_of(&state, &p.session_id).map(|path| images_of_transcript(&path)).unwrap_or_default()
                })
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                Ok(json!({ "images": images }))
            }
        });
    }
    router.register("get_sub_brief", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
        }
        let p: P = parse(params)?;
        Ok(json!({ "brief": brief_of(&p.session_id) }))
    });
    router.register("set_sub_pinned", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(Deserialize)]
            struct P {
                session_id: String,
                pinned: bool,
            }
            let p: P = parse(params)?;
            set_pinned(&state, &p.session_id, p.pinned).map_err(RpcError::invalid_params)?;
            Ok(json!({"ok": true}))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{store_sub_brief, TempDataDir};
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn sub(st: &DaemonState, tag: &str) -> String {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, Path::new("."), "proj", "2026-11-10T00:00:00Z");
        st.registry.upsert_interactive(&sub, Path::new("."), "proj", "2026-11-10T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main.clone()));
        store_sub_brief(&sub, &main);
        sub
    }

    const PNG: &str = "iVBORw0KGgo=";

    #[test]
    fn every_image_of_the_transcript_is_listed_oldest_first_with_ids_the_gallery_can_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let user_img = format!(
            r#"{{"type":"user","timestamp":"2026-11-10T10:00:00Z","message":{{"role":"user","content":[{{"type":"text","text":"look"}},{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{PNG}"}}}}]}}}}"#
        );
        let tool_img = format!(
            r#"{{"type":"user","timestamp":"2026-11-10T10:05:00Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t","content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{PNG}"}}}}]}}]}}}}"#
        );
        let plain = r#"{"type":"user","message":{"role":"user","content":"no image here"}}"#;
        std::fs::write(&path, format!("{user_img}\n{plain}\n{tool_img}\n")).unwrap();

        let images = images_of_transcript(&path);

        assert_eq!(images.len(), 2);
        assert!(images[0].at_ms < images[1].at_ms);
        for img in &images {
            let url = crate::project_dashboard::history_scan::read_image(&img.id, dir.path()).unwrap();
            assert!(url.starts_with("data:image/png;base64,"), "{url}");
        }
    }

    #[test]
    fn a_missing_transcript_lists_no_images() {
        assert!(images_of_transcript(Path::new("/definitely/not/here.jsonl")).is_empty());
    }

    #[tokio::test]
    async fn pinning_a_sub_flags_the_row_and_leaves_it_a_sub() {
        let _data = TempDataDir::new();
        let st = state();
        let id = sub(&st, "pin-rt");

        assert!(set_pinned(&st, &id, true).unwrap());
        assert!(!set_pinned(&st, &id, true).unwrap(), "pinning twice changes nothing");
        let row = st.registry.get(&id).unwrap();
        assert!(row.pinned_to_sidebar);
        assert!(row.subchat_of.is_some(), "a pin only adds a shortcut: the sub stays a sub");

        assert!(set_pinned(&st, &id, false).unwrap());
        assert!(!st.registry.get(&id).unwrap().pinned_to_sidebar);
    }

    #[tokio::test]
    async fn a_subs_brief_is_listed_and_a_plain_chat_has_none() {
        let _data = TempDataDir::new();
        let st = state();
        let id = sub(&st, "brief-of");
        let brief = brief_of(&id).expect("a stored brief is listed");
        assert!(brief["task"].is_string() && brief["goal"].is_string() && brief["done_when"].is_string());
        assert!(brief_of("never-a-sub").is_none());
    }

    #[tokio::test]
    async fn only_a_sub_can_be_pinned() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("plain-pin", Path::new("."), "proj", "2026-11-10T00:00:00Z");
        assert!(set_pinned(&st, "plain-pin", true).unwrap_err().contains("not a sub"));
        assert!(set_pinned(&st, "ghost-pin", true).unwrap_err().contains("unknown session"));
    }
}
