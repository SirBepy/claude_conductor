//! Jarvis singleton orchestrator RPC (todo 272, chunk 1: daemon core plumbing
//! only). `ensure_jarvis_session` is the one method this chunk exposes: it
//! returns the existing Jarvis session id if the settings pointer still
//! resolves to a live registry entry, or spawns a fresh one otherwise. No
//! briefing/first-message is sent here - a later chunk owns that.
//!
//! Split into `jarvis_assets.rs` (seeded CLAUDE.md/state.md/hygiene-prompt
//! text) and `jarvis_fleet.rs` (spawn_worker/send_to_session/fleet_status/
//! respond_worker_prompt + account allocation) as of todo 329; this module
//! keeps the singleton lifecycle and re-exports the fleet fns so external
//! callers (`hooks_server::jarvis`) see no path change.

use super::jarvis_assets::{JARVIS_CLAUDE_MD, JARVIS_HYGIENE_PROMPT, JARVIS_ICON_SVG, JARVIS_STATE_MD_SEED};
// is_jarvis_caller/pick_worker_account stay jarvis_fleet-internal (only
// re-export what hooks_server::jarvis actually dispatches to).
pub(crate) use super::jarvis_fleet::{fleet_status, respond_worker_prompt, send_to_session, spawn_worker};
use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, Recurrence, RecurrenceRule, ScheduledItem, ScheduledKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct RestartJarvisParams {
    session_id: String,
}

/// Model/effort the Jarvis singleton always spawns with. "opus" matches the
/// bare family-alias form `is_valid_model` accepts (see
/// `daemon::lifecycle::is_valid_model`); "high" mirrors the effort every
/// other opus spawn path in this file defaults to (e.g.
/// `daemon::schedule::respawn_for_message`).
const JARVIS_MODEL: &str = "opus";
const JARVIS_EFFORT: &str = "high";

/// Writes `<jarvis-home>/CLAUDE.md`, `/state.md`, and `/icon.svg` iff each is
/// individually missing - never overwrites, since Joe may hand-tune the
/// first two. Called only on the fresh-spawn path in `ensure_jarvis_session`,
/// never on reuse of an existing pointer.
fn seed_jarvis_home_files(cwd: &std::path::Path) -> Result<(), RpcError> {
    let claude_md = cwd.join("CLAUDE.md");
    if !claude_md.exists() {
        std::fs::write(&claude_md, JARVIS_CLAUDE_MD).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    let state_md = cwd.join("state.md");
    if !state_md.exists() {
        std::fs::write(&state_md, JARVIS_STATE_MD_SEED).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    let icon_svg = cwd.join("icon.svg");
    if !icon_svg.exists() {
        std::fs::write(&icon_svg, JARVIS_ICON_SVG).map_err(|e| RpcError::internal(e.to_string()))?;
    }
    Ok(())
}

/// The Monday-morning weekly recurrence the hygiene item seeds with. Time is
/// local wall-clock per `Recurrence::time`'s semantics; the exact slot is an
/// arbitrary-but-reasonable default (start of week, low-traffic hour) - Joe
/// can drag it in the Schedule view like any other recurring item afterward.
fn jarvis_hygiene_recurrence() -> Recurrence {
    Recurrence {
        time: "09:00".to_string(),
        rule: RecurrenceRule::Weekly { weekdays: vec![0] }, // Monday
    }
}

/// True iff a `JarvisHygiene`-kind item already exists anywhere in the
/// schedule store. The kind itself IS the stable idempotency marker (it
/// carries no session id to dedupe on - see `ScheduledKind::JarvisHygiene`'s
/// doc comment for why), so this is a plain existence check, not a lookup by
/// id. Pure (takes the already-loaded list) so it's testable without disk I/O.
fn jarvis_hygiene_already_seeded(items: &[ScheduledItem]) -> bool {
    items.iter().any(|it| matches!(it.kind, ScheduledKind::JarvisHygiene))
}

/// Builds the (not-yet-persisted) recurring hygiene item, its first `fire_at`
/// computed as the next Monday-09:00 occurrence strictly after `now`. Pure
/// builder, split out from `seed_jarvis_hygiene_schedule` so the shape is
/// testable without touching the real scheduled-items store.
fn build_jarvis_hygiene_item(now: chrono::DateTime<chrono::Utc>) -> ScheduledItem {
    let recurrence = jarvis_hygiene_recurrence();
    let fire_at = scheduled_items::next_occurrence(now, &recurrence).to_rfc3339();
    ScheduledItem::new(ScheduledKind::JarvisHygiene, JARVIS_HYGIENE_PROMPT.to_string(), fire_at, Some(recurrence))
}

/// Seeds the recurring weekly memory-hygiene pass (todo 272 remainder), once,
/// the first time a fresh Jarvis singleton is spawned - never called from the
/// pointer-reuse branch in `ensure_jarvis_session`. An existing item already
/// targets Jarvis correctly regardless of respawns (it resolves the live
/// session id at FIRE time, not creation time - see `ScheduledKind::
/// JarvisHygiene` and `daemon::schedule::fire_jarvis_hygiene`), so a second
/// fresh spawn (e.g. after the stored pointer went stale) must not create a
/// duplicate recurring item - `jarvis_hygiene_already_seeded` is the guard.
fn seed_jarvis_hygiene_schedule() {
    if jarvis_hygiene_already_seeded(&scheduled_items::list()) {
        return;
    }
    scheduled_items::upsert(build_jarvis_hygiene_item(chrono::Utc::now()));
}

fn err_to_rpc(e: LifecycleError) -> RpcError {
    match e {
        LifecycleError::InvalidConfig(_, _)
        | LifecycleError::CwdMissing(_)
        | LifecycleError::NoAccounts
        | LifecycleError::NoDefault
        | LifecycleError::AccountNotFound(_)
        | LifecycleError::AccountDrift(_)
        | LifecycleError::AccountCredentials(_)
        | LifecycleError::Frozen(_) => RpcError::invalid_params(e.to_string()),
        LifecycleError::NotFound(_) => RpcError { code: -32004, message: e.to_string(), data: None },
        LifecycleError::AlreadyExists(_) => RpcError { code: -32005, message: e.to_string(), data: None },
        LifecycleError::MeteredBilling(_) | LifecycleError::Io(_) => RpcError::internal(e.to_string()),
    }
}

/// Resolves (and creates if missing) the dedicated cwd Jarvis spawns in:
/// `<data-dir>/jarvis-home/`. A non-project cwd is fine for
/// `upsert_project_for_cwd`/`upsert_interactive` - both accept any existing
/// directory and mint a fresh `ProjectConfig`/registry entry keyed off it
/// (see module docs below on `ensure_jarvis_session`), so this doesn't panic
/// or wedge the sessions UI; it just shows up as an ordinary project named
/// "jarvis-home" until a later chunk special-cases it in the frontend.
fn jarvis_home_dir() -> Result<std::path::PathBuf, RpcError> {
    let dir = crate::settings::paths::data_dir()
        .map_err(|e| RpcError::internal(e.to_string()))?
        .join("jarvis-home");
    std::fs::create_dir_all(&dir).map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(dir)
}

/// Spawns a brand-new Jarvis singleton (fresh cwd seed, fresh session id,
/// jarvis-flagged, `jarvis_session_id` repointed) and publishes the same
/// notifications `ensure_jarvis_session`'s fresh-spawn branch always has.
/// Shared by that branch and `clear_jarvis_context`.
async fn spawn_fresh_jarvis(state: &Arc<DaemonState>) -> Result<String, RpcError> {
    let cwd = jarvis_home_dir()?;
    seed_jarvis_home_files(&cwd)?;
    let params = StartSessionParams {
        cwd: cwd.clone(),
        model: JARVIS_MODEL.to_string(),
        effort: JARVIS_EFFORT.to_string(),
        resume_id: None,
        remote: false,
        account_id: None,
        fork: false,
        new_session_id: None,
    };
    // check_metered_billing already gates inside spawn_session.
    let session = lifecycle::spawn_session(state, params).await.map_err(err_to_rpc)?;
    let sid = session.session_id.clone();
    let account_id = session.account_id.clone();
    let now = chrono::Utc::now().to_rfc3339();

    // auto_accept=true, no character: Jarvis runs unattended, so
    // requiring manual approval on every tool call would stall the
    // whole fleet on a prompt no one is watching for.
    crate::daemon::session_registration::register_new_session(
        state, &sid, &cwd, JARVIS_MODEL, JARVIS_EFFORT, &account_id, &now, true, None, false,
    );
    // Atomic coupling lives in `flag_as_jarvis` (session_registration.rs):
    // flagging the registry AND forcing chat_config's auto_accept happen
    // together so a future change here can't decouple them.
    crate::daemon::session_registration::flag_as_jarvis(state, &sid);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    // Idempotent - see the function doc for why a respawn never duplicates
    // this, so it's safe to call again from clear_jarvis_context too.
    seed_jarvis_hygiene_schedule();

    // Instant in-memory read for this and any other daemon-side
    // consumer; the app process persists the same value to
    // settings.json off the `jarvis_session_created` notification
    // below (daemon has no direct write access to that file - see
    // `SettingsCache`'s module header).
    state.settings.set_jarvis_session_id(&sid);
    state.notifier.publish("jarvis_session_created", json!({"session_id": sid}));
    state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));

    Ok(sid)
}

pub fn register_jarvis(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("ensure_jarvis_session", move |_params, _ctx| {
        let state = state.clone();
        async move {
            let existing = state.settings.snapshot().jarvis_session_id;
            if let Some(id) = existing {
                // Require the pointer to resolve to a still-live entry (not
                // merely present-but-ended): an ended Jarvis session can't
                // take the follow-up briefing/orchestration messages a later
                // chunk sends it, so treat "ended" the same as "gone" and
                // fall through to respawning a fresh singleton.
                if let Some(inst) = state.registry.get(&id) {
                    if inst.ended_at.is_none() {
                        return Ok(json!({"session_id": id}));
                    }
                }
            }

            let sid = spawn_fresh_jarvis(&state).await?;
            Ok(json!({"session_id": sid}))
        }
        });
    }

    // Kebab menu's "Restart Jarvis" (Part B): force-kill the live child (if
    // any) and respawn resuming the SAME session id - never a fork, never a
    // fresh id, and the session is never marked ended. Scoped to a
    // jarvis-flagged session_id only; the frontend only ever surfaces this
    // action inside the Jarvis window, but the daemon re-checks so a stray
    // call against an ordinary session can't nuke its live process.
    {
        let state = state.clone();
        router.register("restart_jarvis_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: RestartJarvisParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let is_jarvis = state.registry.get(&p.session_id).map(|i| i.jarvis).unwrap_or(false);
                if !is_jarvis {
                    return Err(RpcError::invalid_params(format!(
                        "session {} is not the Jarvis singleton", p.session_id
                    )));
                }
                let new_id = lifecycle::restart_session(&state, &p.session_id).await.map_err(err_to_rpc)?;
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                Ok(json!({"session_id": new_id}))
            }
        });
    }

    // Kebab menu's "Clear context": unlike Restart above, this permanently
    // discards the singleton's whole transcript. Force-ends the live child
    // via `end_session` (tolerating NotFound), marks it ended, then spawns a
    // genuinely fresh singleton. Same is-jarvis guard as Restart.
    router.register("clear_jarvis_context", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: RestartJarvisParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let is_jarvis = state.registry.get(&p.session_id).map(|i| i.jarvis).unwrap_or(false);
            if !is_jarvis {
                return Err(RpcError::invalid_params(format!(
                    "session {} is not the Jarvis singleton", p.session_id
                )));
            }
            if let Err(e) = lifecycle::end_session(&state.sessions, &p.session_id).await {
                if !matches!(e, LifecycleError::NotFound(_)) {
                    return Err(err_to_rpc(e));
                }
            }
            let now = chrono::Utc::now().to_rfc3339();
            state.registry.mark_ended(&p.session_id, crate::types::EndReason::Manual, &now);
            let sid = spawn_fresh_jarvis(&state).await?;
            Ok(json!({"session_id": sid}))
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
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn ensure_jarvis_session_reuses_existing_pointer() {
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-x", "2026-07-27T00:00:00Z");
        state.settings.set_jarvis_session_id("jv-1");

        let mut r = Router::new();
        register_jarvis(&mut r, state.clone());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "ensure_jarvis_session".into(),
            params: None,
        }, dummy_ctx()).await;

        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"session_id": "jv-1"})));
    }

    #[test]
    fn seed_jarvis_home_files_creates_both_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        seed_jarvis_home_files(dir.path()).unwrap();

        let claude_md = std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap();
        assert_eq!(claude_md, JARVIS_CLAUDE_MD);
        let state_md = std::fs::read_to_string(dir.path().join("state.md")).unwrap();
        assert_eq!(state_md, JARVIS_STATE_MD_SEED);
        let icon_svg = std::fs::read(dir.path().join("icon.svg")).unwrap();
        assert_eq!(icon_svg, JARVIS_ICON_SVG, "jarvis-home must get a real project icon (todo 682)");
    }

    #[test]
    fn seed_jarvis_home_files_never_overwrites_existing_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "Joe's hand-tuned instructions").unwrap();
        std::fs::write(dir.path().join("state.md"), "Joe's hand-tuned state").unwrap();
        std::fs::write(dir.path().join("icon.svg"), "Joe's hand-tuned icon").unwrap();

        seed_jarvis_home_files(dir.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            "Joe's hand-tuned instructions"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("state.md")).unwrap(),
            "Joe's hand-tuned state"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("icon.svg")).unwrap(),
            "Joe's hand-tuned icon"
        );
    }

    #[test]
    fn seed_jarvis_home_files_fills_in_only_the_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "Joe's hand-tuned instructions").unwrap();
        // state.md and icon.svg left absent.

        seed_jarvis_home_files(dir.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            "Joe's hand-tuned instructions"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("state.md")).unwrap(),
            JARVIS_STATE_MD_SEED
        );
        assert_eq!(std::fs::read(dir.path().join("icon.svg")).unwrap(), JARVIS_ICON_SVG);
    }

    // `ensure_jarvis_session_reuses_existing_pointer` above doubles as coverage
    // for "reuse writes nothing": the reuse branch returns at the `Ok(json!(
    // {"session_id": id}))` early-return, before `jarvis_home_dir()` or
    // `seed_jarvis_home_files` are ever reached (see the non-test code above),
    // so there's no filesystem side effect to assert on - the call graph
    // itself is the guarantee.

    // No test exercises the "pointer is stale/ended -> spawn a fresh singleton"
    // branch: that requires reaching `lifecycle::spawn_session`'s account
    // resolution, which reads the REAL accounts.json off this machine (see
    // `accounts::resolve_account` / `load_registry` - unmocked, not test-
    // isolated) and would actually launch a `claude` child process under
    // `cargo test --lib`. Every other RPC test in this daemon avoids that same
    // trap by using an invalid cwd to short-circuit before account resolution
    // (see `methods::mod::tests::start_session_invalid_cwd_does_not_register`);
    // that shortcut isn't available here since a missing cwd is exactly what
    // this method's happy path needs to create. The `ended_at.is_none()` guard
    // itself is covered by code review; verify manually via the app.

    // ── weekly memory-hygiene seed (todo 272 remainder) ─────────────────────

    #[test]
    fn jarvis_hygiene_already_seeded_true_when_a_jarvis_hygiene_item_exists() {
        let items = vec![ScheduledItem::new(
            ScheduledKind::JarvisHygiene,
            "x".into(),
            "2026-01-01T00:00:00Z".into(),
            None,
        )];
        assert!(jarvis_hygiene_already_seeded(&items), "idempotency guard must detect the existing marker item");
    }

    #[test]
    fn jarvis_hygiene_already_seeded_false_when_only_other_kinds_exist() {
        let items = vec![
            ScheduledItem::new(
                ScheduledKind::Message { session_id: "s".into(), cwd: "C:/x".into() },
                "x".into(),
                "2026-01-01T00:00:00Z".into(),
                None,
            ),
            ScheduledItem::new(
                ScheduledKind::NewChat {
                    cwd: "C:/y".into(), model: "opus".into(), effort: "high".into(),
                    account_id: None, placeholder_id: None, character_id: None, auto_accept: false,
                },
                "x".into(),
                "2026-01-01T00:00:00Z".into(),
                None,
            ),
        ];
        assert!(!jarvis_hygiene_already_seeded(&items), "Message/NewChat items must never be mistaken for the hygiene marker");
    }

    #[test]
    fn jarvis_hygiene_already_seeded_false_for_empty_list() {
        assert!(!jarvis_hygiene_already_seeded(&[]));
    }

    #[test]
    fn build_jarvis_hygiene_item_shape_is_weekly_with_the_verbatim_prompt() {
        let now = chrono::Utc::now();
        let item = build_jarvis_hygiene_item(now);
        assert!(matches!(item.kind, ScheduledKind::JarvisHygiene));
        assert_eq!(item.prompt, JARVIS_HYGIENE_PROMPT);
        let rec = item.recurrence.expect("hygiene item must recur");
        assert!(matches!(rec.rule, RecurrenceRule::Weekly { .. }), "must be a weekly recurrence, not one-shot");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&item.fire_at).is_ok(),
            "fire_at must be a valid RFC3339 instant"
        );
        assert!(
            chrono::DateTime::parse_from_rfc3339(&item.fire_at).unwrap() > now,
            "seeded fire_at must be strictly in the future"
        );
    }

    #[test]
    fn build_jarvis_hygiene_item_two_calls_produce_distinct_ids() {
        // Guards against `seed_jarvis_hygiene_schedule` ever accidentally
        // upserting over itself by id (it doesn't - `ScheduledItem::new` mints
        // a fresh uuid every call, same as every other kind).
        let now = chrono::Utc::now();
        let a = build_jarvis_hygiene_item(now);
        let b = build_jarvis_hygiene_item(now);
        assert_ne!(a.id, b.id);
    }
}
