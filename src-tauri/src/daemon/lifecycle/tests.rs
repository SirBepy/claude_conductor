use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::Settings;

fn blocked_status(account_id: &str) -> crate::accounts::ApiCreditStatus {
    crate::accounts::ApiCreditStatus {
        account_id: account_id.into(),
        blocked: true,
        block_reason: Some("API credit for this cycle is used up, expires 2026-11-02".into()),
        ..Default::default()
    }
}

#[test]
fn api_credit_gate_refuses_a_blocked_account_by_registry_binding() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let settings = std::sync::Mutex::new(Settings::default());
    for sid in ["on-api", "on-sub", "unbound"] {
        state.registry.record_interactive_session(sid, std::path::Path::new("/tmp/x"), &settings, "2026-10-26T00:00:00Z");
    }
    state.registry.set_account("on-api", "api-1");
    state.registry.set_account("on-sub", "sub-1");
    crate::daemon::api_credit::store(&state, blocked_status("api-1"));

    let err = refuse_if_api_credit_blocked(&state, "on-api").expect_err("blocked account must refuse");
    assert!(matches!(err, LifecycleError::ApiCreditBlocked(_)), "{err:?}");
    assert!(err.to_string().starts_with("API_CREDIT_BLOCKED: API credit for this cycle is used up"), "{err}");
    assert!(refuse_if_api_credit_blocked(&state, "on-sub").is_ok(), "another account is untouched");
    assert!(refuse_if_api_credit_blocked(&state, "unbound").is_ok(), "no account bound: unknown never blocks");
    assert!(refuse_if_api_credit_blocked(&state, "ghost").is_ok(), "unknown session is the caller's NotFound");

    // Lifting the block (a new cycle, a raised limit) lets turns through again.
    let mut ok = blocked_status("api-1");
    ok.blocked = false;
    ok.block_reason = None;
    crate::daemon::api_credit::store(&state, ok);
    assert!(refuse_if_api_credit_blocked(&state, "on-api").is_ok());
}

#[tokio::test]
async fn a_blocked_api_credit_chat_refuses_before_any_respawn() {
    // The session is not live, so an unguarded send would try to respawn
    // it (and fail with CwdMissing for this bogus cwd). The gate must win.
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    state.registry.upsert_interactive("blocked-sid", std::path::Path::new("Z:\\does\\not\\exist"), "p", "2026-10-26T00:00:00Z");
    state.registry.set_account("blocked-sid", "api-1");
    crate::daemon::api_credit::store(&state, blocked_status("api-1"));

    let r = send_message_with_respawn(&state, "blocked-sid", "hi", false).await;
    assert!(matches!(r, Err(LifecycleError::ApiCreditBlocked(_))), "{r:?}");
}

#[test]
fn launch_differs_reads_empty_as_the_spawn_default() {
    assert!(!launch_differs("opus", "high", "opus", "high"));
    assert!(!launch_differs("opus", "high", "", ""), "an unrecorded pair respawns as opus/high");
    assert!(launch_differs("opus", "high", "sonnet", "high"), "a model pick is a change");
    assert!(launch_differs("opus", "high", "opus", "max"), "an effort pick is a change");
    assert!(!launch_differs("sonnet", "low", "sonnet", "low"), "picking the original back cancels it");
}

#[test]
fn model_effort_or_default_fills_only_the_empty_half() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    state.registry.upsert_interactive("s", std::path::Path::new("/tmp/x"), "p", "2026-11-08T00:00:00Z");
    state.registry.set_model_effort("s", "", "");
    let inst = state.registry.get("s").unwrap();
    assert_eq!(model_effort_or_default(&inst), (SPAWN_DEFAULT_MODEL.to_string(), SPAWN_DEFAULT_EFFORT.to_string()));
    state.registry.set_model_effort("s", "sonnet", "");
    let inst = state.registry.get("s").unwrap();
    assert_eq!(model_effort_or_default(&inst), ("sonnet".to_string(), SPAWN_DEFAULT_EFFORT.to_string()));
}

#[test]
fn the_spawn_default_pair_is_never_a_launch_change() {
    assert!(!launch_differs(SPAWN_DEFAULT_MODEL, SPAWN_DEFAULT_EFFORT, "", ""));
    assert!(!launch_differs("", "", SPAWN_DEFAULT_MODEL, SPAWN_DEFAULT_EFFORT));
}

#[test]
fn only_a_chat_mid_turn_with_no_card_open_would_lose_its_turn_to_a_respawn() {
    assert!(respawn_would_kill_a_turn(true, false), "a running turn dies with the child");
    assert!(!respawn_would_kill_a_turn(false, false), "idle: nothing runs");
    assert!(!respawn_would_kill_a_turn(true, true), "a question card parks the child, nothing runs");
    assert!(!respawn_would_kill_a_turn(false, true));
}

#[test]
fn a_stale_pick_is_applied_on_the_next_send_unless_a_turn_is_running() {
    // (busy, has_prompt, stale)
    assert!(stale_respawn_due(false, false, true), "idle chat: the send applies the pick");
    assert!(stale_respawn_due(true, true, true), "open question card: the send applies the pick");
    assert!(!stale_respawn_due(true, false, true), "mid-turn: refused as busy, the child is left alone");
    assert!(!stale_respawn_due(false, false, false), "nothing pending");
    assert!(!stale_respawn_due(true, true, false));
    assert!(!stale_respawn_due(true, false, false));
}

/// The live-child cases below read `expected_exit` as "a respawn was
/// attempted": the respawn itself cannot complete here (it would start
/// `claude`), so it fails at the cwd check after the kill.
#[cfg(windows)]
async fn refresh_with(busy: bool, card: bool, stale: bool) -> (bool, bool) {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let registry_pair = if stale { ("sonnet", "low") } else { ("opus", "high") };
    let (_child, session) = probe::live_session(&state, "s", ("opus", "high"), registry_pair);
    state.registry.set_busy("s", busy);
    if card {
        state.add_prompt("p1", "question-requested", serde_json::json!({"session_id": "s", "seq": 1}), false).await;
    }
    let returned = refresh_stale_launch(&state, "s").await;
    (returned, session.expected_exit.load(std::sync::atomic::Ordering::SeqCst))
}

#[cfg(windows)]
#[tokio::test]
async fn refresh_stale_launch_respawns_an_idle_chat_and_one_parked_on_a_card() {
    assert!(refresh_with(false, false, true).await.1, "idle and stale: the send applies the pick");
    assert!(refresh_with(true, true, true).await.1, "a question card open: nothing runs, the send applies the pick");
}

#[cfg(windows)]
#[tokio::test]
async fn refresh_stale_launch_refuses_a_chat_mid_turn_without_a_card() {
    assert_eq!(refresh_with(true, false, true).await, (false, false), "the running turn must not be killed");
}

#[cfg(windows)]
#[tokio::test]
async fn refresh_stale_launch_leaves_a_chat_running_its_pick_alone() {
    assert_eq!(refresh_with(false, false, false).await, (false, false));
}

/// Every daemon-originated send door applies a pending pick before it writes:
/// each is called on an idle chat whose child runs opus/high while the registry
/// holds sonnet/low, and `expected_exit` shows the respawn was attempted.
#[cfg(windows)]
#[tokio::test]
async fn every_respawning_send_door_applies_a_pending_pick_first() {
    for door in 0..3 {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_child, session) = probe::live_session(&state, "s", ("opus", "high"), ("sonnet", "low"));
        let _ = match door {
            0 => send_message_with_respawn(&state, "s", "hi", false).await,
            1 => send_message_with_respawn_and_author(&state, "s", "hi", "jarvis").await,
            _ => send_message_with_respawn_meta_and_author(&state, "s", "hi", "peer").await,
        };
        assert!(
            session.expected_exit.load(std::sync::atomic::Ordering::SeqCst),
            "send door {door} wrote into a child on the stale pick"
        );
    }
}

#[test]
fn launch_is_stale_is_false_without_a_live_child() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    state.registry.upsert_interactive("s", std::path::Path::new("/tmp/x"), "p", "2026-11-04T00:00:00Z");
    state.registry.set_model_effort("s", "sonnet", "low");
    assert!(!launch_is_stale(&state, "s"), "no live child means the next spawn already uses the pick");
}

#[test]
fn refuse_if_busy_only_refuses_a_mid_turn_session() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let settings = std::sync::Mutex::new(Settings::default());
    state.registry.record_interactive_session(
        "s",
        std::path::Path::new("/tmp/x"),
        &settings,
        "2026-09-03T00:00:00Z",
    );

    assert!(refuse_if_busy(&state, "s").is_ok(), "an idle session must accept a send");
    assert!(refuse_if_busy(&state, "ghost").is_ok(), "an unknown session is NotFound's call, not ours");

    state.registry.set_busy("s", true);
    let err = refuse_if_busy(&state, "s").expect_err("a mid-turn session must be refused");
    assert!(
        err.to_string().starts_with("SESSION_BUSY:"),
        "the frontend re-stage path keys off this prefix: {err}"
    );
}
