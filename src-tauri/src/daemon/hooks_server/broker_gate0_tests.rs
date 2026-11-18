//! Step 8b, Gate 0 (in-process half): every kind of chat reads through the broker with no
//! permission card, and the friction counter counts what the engine really denies.
//!
//! "Zero cards" is two facts. (1) The permission layer: the `claude` child is started with the
//! broker tools in `--allowedTools` (`PRETRUSTED_TOOLS`), so it never calls the permission relay
//! for them. `spawn_session` builds that argv once for every kind of chat, so the argv test below
//! covers all four. (2) The daemon side: a chat launched the way `spawn_session` launches it
//! (`broker_env::mint_for_launch`, the real binding) can make `api_read` calls through both fronts
//! and the daemon ends with no open prompt. A positive control proves the check could see a card.
//!
//! The four kinds go through one code path here (the engine has no notion of autopilot or of a phone
//! chat), so what sets them apart is proven only by the argv test (one argv for all) and by
//! `scripts/broker-gate0.mjs`, which starts each kind for real. The hidden sub is the one kind with
//! its own binding rule, and `a_hidden_sub_reads_only_what_its_main_chat_was_bound_to` covers it.
//!
//! Not proven here, by name: that a real `claude` honours `--allowedTools` for an MCP tool in each
//! mode, and the cross-process path (pipe, env var, MCP child). `scripts/broker-gate0.mjs` runs the
//! second against a real daemon process; the first needs a billed `claude` run and was not made.

use super::broker_rig::Rig;
use crate::daemon::broker::friction;
use crate::daemon::lifecycle::broker_env::mint_for_launch;
use crate::daemon::rpc::Transport;
use crate::types::{ProjectConfig, Settings};
use serde_json::{json, Value};
use std::path::Path;

const FIG: &str = "CANARY-fig-gate0-1";
const NOW: &str = "2026-11-18T00:00:00Z";

fn project(path: &Path) -> ProjectConfig {
    serde_json::from_value(json!({"id": "p1", "path": path, "name": "p1", "created_at": NOW})).unwrap()
}

/// A rig whose daemon knows the project, so `mint_for_launch` resolves the real default binding
/// (no stored `broker_services`, no tracker: Figma only).
async fn rig() -> Rig {
    let r = Rig::new(&[("FIGMA_TOKEN", FIG)]).await;
    let mut s = Settings::default();
    s.projects = vec![project(r.project.path())];
    r.ctx.state.settings.replace(s);
    r
}

struct Kind {
    name: &'static str,
    session: &'static str,
}

/// The four kinds the plan names, each set up the way the registry holds it: an attended chat, a hidden
/// sub of it, an autopilot chat, and a chat a phone started or drives (a plain chat on this PC).
const KINDS: [Kind; 4] = [
    Kind { name: "attended", session: "chat-a" },
    Kind { name: "hidden sub", session: "sub-1" },
    Kind { name: "autopilot", session: "auto-1" },
    Kind { name: "phone-driven", session: "phone-1" },
];

async fn launch(r: &Rig, k: &Kind, sub_dir: &Path) -> String {
    let state = &r.ctx.state;
    let root = r.project.path();
    let token = match k.name {
        "hidden sub" => {
            state.registry.upsert_interactive(k.session, sub_dir, "p1", NOW);
            state.registry.set_subchat_of(k.session, Some("chat-a".into()));
            mint_for_launch(state, k.session, Some("chat-a"), sub_dir, None).await
        }
        _ => {
            state.registry.upsert_interactive(k.session, root, "p1", NOW);
            if k.name == "autopilot" {
                state.registry.set_autopilot(k.session, true);
            }
            mint_for_launch(state, k.session, None, root, None).await
        }
    };
    token.expose().to_string()
}

async fn no_open_prompt(r: &Rig) {
    assert!(r.ctx.state.list_prompts().await.is_empty(), "a card is open: {:?}", r.ctx.state.list_prompts().await);
    assert!(r.ctx.state.pending.lock().await.is_empty(), "a prompt is waiting for an answer");
}

#[tokio::test]
async fn every_kind_of_chat_reads_through_both_fronts_with_zero_cards_and_zero_denials() {
    let mut r = rig().await;
    let mock = r.server.mock("GET", "/v1/me").match_header("x-figma-token", FIG).with_status(200).with_body(r#"{"id":"u1"}"#).expect(8).create_async().await;
    let sub_dir = tempfile::tempdir().unwrap();
    for k in &KINDS {
        let token = launch(&r, k, sub_dir.path()).await;

        let via_mcp = r.read(k.session, "figma", "/v1/me").await;
        assert_eq!((via_mcp["ok"].clone(), via_mcp["status"].clone()), (json!(true), json!(200)), "{} via api_read: {via_mcp}", k.name);
        let via_script = r.http_ok(&token, json!({"service": "figma", "path": "/v1/me"})).await;
        assert_eq!((via_script["ok"].clone(), via_script["status"].clone()), (json!(true), json!(200)), "{} via the script front: {via_script}", k.name);
        no_open_prompt(&r).await;
    }
    mock.assert_async().await;

    // Every call is in the audit log under its own chat, all ok.
    let audit = r.audit();
    for k in &KINDS {
        let lines: Vec<&Value> = audit.iter().filter(|l| l["session"] == json!(k.session)).collect();
        assert_eq!(lines.len(), 2, "{}: {lines:?}", k.name);
        assert!(lines.iter().all(|l| l["outcome"] == json!("ok")), "{}: {lines:?}", k.name);
    }
    // A run with no denial leaves the friction counter at zero, so the target holds.
    let report = friction::report_now(&r.data.join("broker-audit.jsonl"), 1).unwrap();
    assert_eq!((report.today_friction, report.within_target, report.days[0].calls), (0, true, 8), "{report:?}");
    r.assert_no_leak(&[FIG], &[]);
}

#[tokio::test]
async fn a_hidden_sub_reads_only_what_its_main_chat_was_bound_to() {
    let mut r = rig().await;
    let mock = r.server.mock("GET", "/v1/me").with_status(200).with_body("{}").expect(1).create_async().await;
    let sub_dir = tempfile::tempdir().unwrap();
    // The main chat launches with the default (Figma); Joe then widens the project, and a sub
    // launched afterwards still holds the set its main chat holds.
    launch(&r, &KINDS[0], sub_dir.path()).await;
    let mut widened = project(r.project.path());
    widened.broker_services = Some(vec!["figma".into(), "shortcut".into()]);
    let mut s = Settings::default();
    s.projects = vec![widened];
    r.ctx.state.settings.replace(s);
    launch(&r, &KINDS[1], sub_dir.path()).await;

    assert_eq!(r.read("sub-1", "figma", "/v1/me").await["ok"], json!(true));
    let refused = r.read("sub-1", "shortcut", "/api/v3/member").await;
    assert_eq!(refused["ok"], json!(false));
    assert!(refused["error"].as_str().unwrap().contains("service_not_bound"), "{refused}");
    // An unbound service is a plain ok:false carrying the binding line, never a card.
    no_open_prompt(&r).await;
    mock.assert_async().await;
}

/// The claude child skips the permission relay for a tool named in `--allowedTools`. One function
/// builds that argv for every spawn (`spawn_session`: a fresh chat, a resume, the per-turn respawn, a
/// hidden sub, an autopilot run and a phone's start all call it), so one argv covers every kind.
#[test]
fn every_launch_pretrusts_the_broker_tools_so_the_child_never_asks_for_them() {
    for (resume, fork) in [(None, false), (Some("old"), false), (Some("old"), true)] {
        let args = crate::daemon::claude_config::base_claude_args(resume, "sess", "opus", "high", fork);
        let at = args.iter().position(|a| a == "--allowedTools").expect("--allowedTools is always passed");
        let allowed: Vec<&str> = args[at + 1].split(' ').collect();
        for tool in ["mcp__cc_conductor__api_read", "mcp__cc_conductor__api_write", "mcp__cc_conductor__api_card"] {
            assert!(allowed.contains(&tool), "{tool} missing from {allowed:?}");
        }
        // Nothing narrows the list or turns the permission mode into one that would ask anyway.
        assert!(!args.iter().any(|a| a.starts_with("--permission-mode") || a == "--dangerously-skip-permissions"), "{args:?}");
    }
    // The one place the argv is built for a chat: a second call site would be a second argv this test never saw.
    let spawn = include_str!("../lifecycle/spawn.rs").replace("\r\n", "\n");
    let code = spawn.split("#[cfg(test)]").next().unwrap();
    assert_eq!(code.matches("base_claude_args(").count(), 1, "spawn.rs builds a chat's argv in one place");
    assert_eq!(code.matches("--allowedTools").count(), 0, "spawn.rs adds no tool list of its own");
}

/// A phone starts and drives a chat (`start_session`, `send_message` are phone-callable), but the broker
/// is never an RPC: the chat reads through its own MCP child on this PC, and the phone cannot name a
/// session of its own to the broker.
#[test]
fn a_phone_can_drive_a_chat_but_cannot_call_the_broker_itself() {
    use crate::daemon::remote_handlers::allowed;
    for m in ["start_session", "send_message", "list_pending_prompts"] {
        assert!(allowed(m, &Transport::Phone), "{m} is how a phone drives a chat");
    }
    for m in ["api_read", "api_write", "api_card", "broker_friction", "respond_broker_card"] {
        assert!(!allowed(m, &Transport::Phone) && !allowed(m, &Transport::PeerMachine("x".into())), "{m}");
    }
}

/// The check above is only worth something if it can see a card. A tool that is not pretrusted, asked
/// through the relay's own card path, shows up in the same listing.
#[tokio::test]
async fn control_the_rig_sees_a_permission_card_for_a_tool_that_is_not_pretrusted() {
    let r = rig().await;
    let state = r.ctx.state.clone();
    let asked = {
        let state = state.clone();
        tokio::spawn(async move {
            super::permission::ask_human(&state, "ctl-1", "mcp__cc_conductor__person", json!({"action": "remember"}), Some("chat-a")).await
        })
    };
    for _ in 0..200 {
        if state.pending.lock().await.contains_key("ctl-1") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let listed = state.list_prompts().await;
    assert!(listed.iter().any(|p| p["id"] == "ctl-1"), "the control card is not visible: {listed:?}");
    assert!(!state.pending.lock().await.is_empty(), "no_open_prompt would have failed on this card");
    state.pending.lock().await.remove("ctl-1").unwrap().send(json!({"behavior": "deny"})).unwrap();
    asked.await.unwrap();
    no_open_prompt(&r).await;
}

/// The counter reads what the engine writes: a bound read is not a denial, an unbound service, an
/// unseeded write and a malformed path are denials of three kinds, and only the first two count.
#[tokio::test]
async fn the_friction_counter_counts_what_the_engine_really_denies() {
    let mut r = rig().await;
    let _ok = r.server.mock("GET", "/v1/me").with_status(200).with_body("{}").create_async().await;
    let sub_dir = tempfile::tempdir().unwrap();
    launch(&r, &KINDS[0], sub_dir.path()).await;

    assert_eq!(r.read("chat-a", "figma", "/v1/me").await["ok"], json!(true));
    let unbound = r.read("chat-a", "shortcut", "/api/v3/member").await;
    assert!(unbound["error"].as_str().unwrap().contains("service_not_bound"), "{unbound}");
    let no_row = r.write("chat-a", "figma", "DELETE", "/v1/files/abc/comments/1", Value::Null).await;
    assert_eq!(no_row["ok"], json!(false), "{no_row}");
    let guard = r.read("chat-a", "figma", "https://evil.example/v1/me").await;
    assert_eq!(guard["ok"], json!(false), "{guard}");

    let outcomes: Vec<String> = r.audit().iter().map(|l| l["outcome"].as_str().unwrap().to_string()).collect();
    assert_eq!(outcomes, ["ok", "denied_scope", "denied_policy", "denied_guard"], "{outcomes:?}");
    let report = friction::report_now(&r.data.join("broker-audit.jsonl"), 1).unwrap();
    let day = &report.days[0];
    assert_eq!((day.calls, day.friction, day.guard_denials), (4, 2, 1), "{report:?}");
    assert_eq!((day.by_outcome.get("denied_scope"), day.by_outcome.get("denied_policy")), (Some(&1), Some(&1)));
    // A denial never opens a card by itself: Joe adds a row or a binding on his own time.
    no_open_prompt(&r).await;
}
