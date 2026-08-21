//! Character/voiceline RPCs: listing, asset URLs, voiceline resolution,
//! whitelist resolution, per-session character map, and assignment.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

pub fn register_characters(router: &mut Router, state: Arc<DaemonState>) {
    // Read-only character list, exposed over the remote-access API so the phone
    // client can render session avatars without a Tauri runtime. `characters::list()`
    // reads the shared on-disk characters dir (process-local cache, shared files),
    // so it works fine from the daemon process. Same serde shape as the
    // `list_characters` Tauri command (frontend `Character[]`).
    {
        router.register("list_characters", move |_params, _ctx| {
            async move { Ok(json!(crate::characters::list())) }
        });
    }
    // Mirrors `character_asset_url` (params: character_id, file) -> Option<String>
    // data URL. `file` is client-supplied, so `asset_path_checked` canonicalizes
    // and rejects any escape from the character's own dir before the fs read.
    router.register("character_asset_url", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P { character_id: String, file: String }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let url = crate::characters::get(&p.character_id)
                .and_then(|c| c.asset_path_checked(&p.file))
                .and_then(|path| crate::characters::assets::file_data_url_at(&path));
            Ok(json!(url))
        }
    });
    // Mirrors the character/slot resolution `notifications::fire` runs natively
    // on the app process for a `turn_sound` event (rodio playback there avoids
    // `data:` URLs only because WebView2 blocks them - a real browser tab has
    // no such restriction). Lets a remote client hear the same voiceline the
    // desktop app just played by resolving the identical rule daemon-side and
    // handing back a data URL instead of bytes. Returns null whenever there's
    // nothing to play: muted (mute_all/mute_sounds), no character resolved, or
    // the resolved mode is Voice/TTS (out of scope for remote - sound-clip
    // slots only).
    {
        let state = state.clone();
        router.register("resolve_voiceline", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: Option<String>, cwd: Option<String>, awaiting: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let kind = match p.awaiting.as_str() {
                    "done" => crate::notifications::NotifKind::WorkFinished,
                    "question" => crate::notifications::NotifKind::QuestionAsked,
                    _ => return Ok(json!(null)),
                };
                let settings = state.settings.snapshot();
                if crate::notifications::should_suppress(&settings, crate::tray::NotifMode::Sound) {
                    return Ok(json!(null));
                }
                let cfg: crate::tray::NotificationsConfig = (&settings).try_into().unwrap_or_default();
                let rule = crate::notifications::resolve_with_character(
                    &cfg, &settings, kind, p.session_id.as_deref(), p.cwd.as_deref(),
                );
                if !rule.enabled
                    || rule.mode != crate::tray::NotifMode::Sound
                    || rule.sound_pack != crate::notifications::CHARACTER_PACK_SENTINEL
                {
                    return Ok(json!(null));
                }
                let url = crate::characters::assets::file_data_url_at(
                    std::path::Path::new(&rule.sound_file),
                );
                Ok(json!(url))
            }
        });
    }
    // Mirrors `resolve_whitelist_characters` (params: project_id) -> Vec<Character>.
    // Reads the project's whitelist + default whitelist from the settings
    // snapshot, then whitelist::resolve over characters::list().
    {
        let state = state.clone();
        router.register("resolve_whitelist_characters", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { project_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let s = state.settings.snapshot();
                let proj_wl = s
                    .projects
                    .iter()
                    .find(|pc| pc.id == p.project_id)
                    .map(|pc| pc.whitelist.clone())
                    .unwrap_or(crate::types::CharacterWhitelist::Default);
                let default_wl = s.default_character_whitelist.clone();
                let all = crate::characters::list();
                let resolved_ids = crate::characters::whitelist::resolve(&proj_wl, &default_wl, &all);
                let resolved: Vec<_> = resolved_ids
                    .iter()
                    .filter_map(|id| crate::characters::get(id))
                    .collect();
                Ok(json!(resolved))
            }
        });
    }
    // Mirrors `list_session_characters` -> { session_id: character_id }. The
    // Tauri command prunes dead sessions before returning; the daemon skips the
    // prune (a read-only display fetch) and returns the full snapshot map. Stale
    // ids are harmless: the frontend only looks up live session ids. Without this
    // the phone sidebar + chat header show the "?" placeholder for every session
    // because the per-session character map never loads (missing avatars).
    {
        let state = state.clone();
        router.register("list_session_characters", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.settings.snapshot().session_characters)) }
        });
    }
    // Mirrors the ASSIGNMENT half of `ensure_session_character` (the Tauri
    // command in ipc/characters.rs), which previously existed ONLY on the app
    // process. HttpTransport had no case for it and the frontend's `.catch(()
    // => null)` swallowed the resulting RemoteUnavailableError, so a
    // remote-created session never got a character (silent no-op). Mutates the
    // daemon's own settings cache immediately for an instant read (mirrors
    // `upsert_project_for_cwd`'s pattern), then - on a FRESH pick only -
    // publishes a notification so a connected app process persists the same
    // assignment to settings.json (see daemon_link.rs's "project_created"
    // handler for the app-side counterpart of this pattern).
    {
        let state = state.clone();
        router.register("ensure_session_character", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { session_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;

                let instances = state.registry.list();
                let live_ids: HashSet<String> = instances
                    .iter()
                    .filter(|i| i.end_reason.is_none())
                    .map(|i| i.session_id.clone())
                    .collect();
                let Some(project_id) = instances
                    .iter()
                    .find(|i| i.session_id == p.session_id)
                    .map(|i| i.project_id.clone())
                else {
                    return Ok(json!(null));
                };

                let all = crate::characters::list();
                let (pick, is_new) = state.settings.ensure_session_character(
                    &p.session_id, &project_id, &all, &live_ids,
                );
                if is_new {
                    if let Some(ref character_id) = pick {
                        state.notifier.publish("session_character_assigned", json!({
                            "session_id": p.session_id, "character_id": character_id,
                        }));
                    }
                }
                Ok(json!(pick))
            }
        });
    }
}
