//! The three broker cards end to end on a daemon state: what each card shows, what
//! answering it changes, and every way of answering that must be refused. Tokens are
//! canary strings, and each test that could leak one looks for it everywhere a value
//! could land.

use super::card_ops::testing::mac_env;
use super::card_ops::{CardEnv, PolicyProposal};
use super::cards::{self, Action};
use super::services::Service;
use crate::daemon::methods::permission::{respond_question_inner, settle_answered_questions};
use crate::daemon::rpc::{ConnectionContext, Request, Router, Transport};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::Settings;
use serde_json::{json, Value};
use std::sync::Arc;

const SC: &str = "canary-card-sc-1";
const TR_TOK: &str = "canary-card-trtok-2";
const PASTED: &str = "canary-card-pasted-3";
const ENV_TEXT: &str = "SHORTCUT_API_TOKEN=canary-card-sc-1\nTRELLO_TOKEN=canary-card-trtok-2\nUNRELATED=keep\n";

fn state_with_chat(id: &str) -> Arc<DaemonState> {
    let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-18T00:00:00Z");
    st
}

fn env_in(dir: &std::path::Path, env_text: Option<&str>) -> Arc<CardEnv> {
    Arc::new(mac_env(dir, env_text))
}

async fn everything_visible(st: &Arc<DaemonState>) -> String {
    serde_json::to_string(&st.list_prompts().await).unwrap()
}

fn audit_lines(env: &CardEnv) -> Vec<Value> {
    std::fs::read_to_string(&env.audit_path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn proposal(service: Service, method: &str, path: &str, op: Option<&str>) -> PolicyProposal {
    PolicyProposal { service, method: method.into(), path: path.into(), op: op.map(str::to_string) }
}

async fn dispatch(state: &Arc<DaemonState>, transport: Transport, method: &str, params: Value) -> crate::daemon::rpc::Response {
    let mut router = Router::new();
    crate::daemon::methods::register_responders(&mut router, state.clone());
    crate::daemon::methods::register_broker_card(&mut router, state.clone());
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let mut ctx = ConnectionContext::new(tx);
    ctx.remote = matches!(transport, Transport::Phone);
    ctx.transport = transport;
    router.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) }, ctx).await
}

// ---- import --------------------------------------------------------------------

#[tokio::test]
async fn the_import_card_lists_the_rows_it_will_change_and_no_value() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), Some(ENV_TEXT));
    let st = state_with_chat("main-1");
    let r = cards::raise_import(&st, env.clone(), "main-1").await.unwrap();
    assert!(!r.already_open);
    let listed = st.list_prompts().await;
    assert_eq!(listed.len(), 1);
    let p = &listed[0]["payload"];
    assert_eq!(p["card_kind"], cards::KIND_IMPORT);
    assert_eq!(p["daemon_card"], true);
    let rows = p["broker_card"]["rows"].as_array().unwrap();
    let status = |n: &str| rows.iter().find(|r| r["name"] == n).unwrap()["status"].clone();
    assert_eq!((status("SHORTCUT_API_TOKEN"), status("TRELLO_TOKEN")), (json!("copy"), json!("copy")));
    assert_eq!(status("LINEAR_API_KEY"), json!("missing"), "the card names what .env lacks");
    assert_eq!(status("HUBSTAFF_REFRESH_TOKEN"), json!("pc_only"), "a Mac says Hubstaff is PC only");
    let shown = everything_visible(&st).await;
    for v in [SC, TR_TOK] {
        assert!(!shown.contains(v), "no value in the card: {shown}");
    }
    assert_eq!(st.registry.get("main-1").unwrap().awaiting.as_deref(), Some("question"), "it asks for Joe like any card");
}

#[tokio::test]
async fn approving_the_import_copies_the_listed_tokens_into_the_store_and_audits_it() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), Some(ENV_TEXT));
    let st = state_with_chat("main-2");
    let id = cards::raise_import(&st, env.clone(), "main-2").await.unwrap().card_id;
    let before = std::fs::read_to_string(env.env_file.as_ref().unwrap()).unwrap();

    let out = cards::respond(&st, &id, Action::Approve { value: None }).await.unwrap();
    assert_eq!(out["stored"], json!(["SHORTCUT_API_TOKEN", "TRELLO_TOKEN"]));
    assert!(st.list_prompts().await.is_empty(), "the card is gone");
    assert_ne!(st.registry.get("main-2").unwrap().awaiting.as_deref(), Some("question"));
    assert_eq!(std::fs::read_to_string(env.env_file.as_ref().unwrap()).unwrap(), before, ".env is left as it was");
    let got = crate::api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "SHORTCUT_API_TOKEN").unwrap().unwrap();
    assert_eq!(got.0, SC);

    let lines = audit_lines(&env);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!((lines[0]["method"].clone(), lines[0]["path"].clone(), lines[0]["outcome"].clone()), (json!("CARD"), json!("import"), json!("card_import")));
    assert_eq!(lines[0]["session"], "main-2");
    let text = std::fs::read_to_string(&env.audit_path).unwrap();
    for v in [SC, TR_TOK] {
        assert!(!text.contains(v), "no value in the audit log: {text}");
    }
    // A second answer finds no card: it cannot apply twice.
    assert_eq!(cards::respond(&st, &id, Action::Approve { value: None }).await.unwrap_err(), "no such broker card");
}

#[tokio::test]
async fn no_import_card_is_raised_when_there_is_nothing_to_copy_and_the_text_lists_what_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_with_chat("main-3");
    let env = env_in(dir.path(), None);
    let e = cards::raise_import(&st, env, "main-3").await.unwrap_err();
    assert!(e.contains("LINEAR_API_KEY") && e.contains("replace"), "{e}");
    assert!(st.list_prompts().await.is_empty());
}

// ---- add / replace -----------------------------------------------------------

#[tokio::test]
async fn hubstaff_has_no_card_on_a_mac_and_says_pc_only() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_with_chat("main-4");
    let e = cards::raise_replace(&st, env_in(dir.path(), None), "main-4", "HUBSTAFF_REFRESH_TOKEN").await.unwrap_err();
    assert!(e.contains("PC only"), "{e}");
    assert!(st.list_prompts().await.is_empty());
    assert!(cards::raise_replace(&st, env_in(dir.path(), None), "main-4", "NOT_A_KEY").await.is_err());
}

#[tokio::test]
async fn the_replace_card_takes_a_pasted_token_straight_into_the_store_and_nowhere_else() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-5");
    let mut rx = st.notifier.subscribe();
    let id = cards::raise_replace(&st, env.clone(), "main-5", "FIGMA_TOKEN").await.unwrap().card_id;
    let p = st.list_prompts().await[0]["payload"].clone();
    assert_eq!((p["card_kind"].clone(), p["broker_card"]["name"].clone(), p["broker_card"]["stored"].clone()), (json!("broker_replace"), json!("FIGMA_TOKEN"), json!(false)));
    assert_eq!(p["questions"][0]["header"], "Add token");

    // An empty paste is refused and the card stays open for another try.
    assert!(cards::respond(&st, &id, Action::Approve { value: Some("  \n".into()) }).await.is_err());
    assert!(cards::respond(&st, &id, Action::Approve { value: None }).await.is_err());
    assert_eq!(st.list_prompts().await.len(), 1);

    let out = cards::respond(&st, &id, Action::Approve { value: Some(format!("{PASTED}\n")) }).await.unwrap();
    assert_eq!(out["stored"], json!(["FIGMA_TOKEN"]));
    let got = crate::api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "FIGMA_TOKEN").unwrap().unwrap();
    assert_eq!(got.0, PASTED, "the newline of a paste is dropped");

    let mut frames = String::new();
    while let Ok(f) = rx.try_recv() {
        frames.push_str(&f.to_string());
    }
    let audit = std::fs::read_to_string(&env.audit_path).unwrap();
    for (place, text) in [("notifier frames", &frames), ("prompts", &everything_visible(&st).await), ("audit log", &audit)] {
        assert!(!text.contains(PASTED), "the pasted token leaked into the {place}");
    }
    assert_eq!(audit_lines(&env).last().unwrap()["outcome"], "card_replace");

    // The next card for the same token says Replace.
    cards::raise_replace(&st, env, "main-5", "FIGMA_TOKEN").await.unwrap();
    assert_eq!(st.list_prompts().await[0]["payload"]["questions"][0]["header"], "Replace token");
}

#[tokio::test]
async fn a_failed_store_keeps_the_replace_card_open_and_audits_the_failure() {
    let dir = tempfile::tempdir().unwrap();
    let mut env = mac_env(dir.path(), None);
    env.runner = Box::new(super::card_ops::testing::FakeKeychain { locked: true, ..Default::default() });
    let env = Arc::new(env);
    let st = state_with_chat("main-6");
    let id = cards::raise_replace(&st, env.clone(), "main-6", "FIGMA_TOKEN").await.unwrap().card_id;
    let e = cards::respond(&st, &id, Action::Approve { value: Some(PASTED.into()) }).await.unwrap_err();
    assert!(!e.contains(PASTED), "{e}");
    assert_eq!(st.list_prompts().await.len(), 1, "Joe can retry");
    let lines = audit_lines(&env);
    assert_eq!(lines.last().unwrap()["outcome"], "card_failed");
    assert!(!std::fs::read_to_string(&env.audit_path).unwrap().contains(PASTED));
}

// ---- policy --------------------------------------------------------------------

#[tokio::test]
async fn the_policy_card_shows_the_exact_row_and_approving_it_appends_that_row_once() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-7");
    let call = proposal(Service::Shortcut, "POST", "/api/v3/epics", None);
    let want = super::card_ops::row_line(&super::card_ops::propose_row(&call).unwrap());
    let id = cards::raise_policy(&st, env.clone(), "main-7", call.clone()).await.unwrap().card_id;
    let p = st.list_prompts().await[0]["payload"].clone();
    assert_eq!((p["card_kind"].clone(), p["broker_card"]["line"].clone()), (json!("broker_policy"), json!(want)));

    // The same ask while it is open is the same card.
    let again = cards::raise_policy(&st, env.clone(), "main-7", call).await.unwrap();
    assert_eq!((again.already_open, again.card_id.clone()), (true, id.clone()));
    assert_eq!(st.list_prompts().await.len(), 1);

    let rows_before = super::policy_file::load_effective(&env.policy_path).unwrap().rows.len();
    let out = cards::respond(&st, &id, Action::Approve { value: None }).await.unwrap();
    assert_eq!(out["added"], true);
    let file = super::policy_file::load_effective(&env.policy_path).unwrap();
    assert_eq!(file.rows.len(), rows_before + 1);
    assert_eq!(super::card_ops::row_line(file.rows.last().unwrap()), want, "exactly the row the card showed");
    assert!(st.list_prompts().await.is_empty());
    let last = audit_lines(&env).pop().unwrap();
    assert_eq!((last["path"].clone(), last["outcome"].clone()), (json!("policy"), json!("card_policy")));
    assert!(last["reason"].as_str().unwrap().contains("/api/v3/epics"), "{last}");
}

#[tokio::test]
async fn no_policy_card_for_an_allowed_call_an_unbound_service_or_a_row_nothing_can_allow() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-8");
    let call = proposal(Service::Shortcut, "POST", "/api/v3/epics", None);
    // Once the row is in the file, the same call needs no card.
    let id = cards::raise_policy(&st, env.clone(), "main-8", call.clone()).await.unwrap().card_id;
    cards::respond(&st, &id, Action::Approve { value: None }).await.unwrap();
    let e = cards::raise_policy(&st, env.clone(), "main-8", call).await.unwrap_err();
    assert!(e.contains("already allows"), "{e}");
    // A Linear operation outside the pinned three, and a GET, get no card.
    assert!(cards::raise_policy(&st, env.clone(), "main-8", proposal(Service::Linear, "POST", "/graphql", Some("issueDelete"))).await.is_err());
    assert!(cards::raise_policy(&st, env.clone(), "main-8", proposal(Service::Figma, "GET", "/v1/me", None)).await.is_err());
    // A chat bound to Figma only cannot ask for a Shortcut row.
    st.broker_sessions.mint(super::session::SessionClaims::new("main-8", super::session::Role::Chat, vec![Service::Figma]));
    let e = cards::raise_policy(&st, env, "main-8", proposal(Service::Shortcut, "POST", "/api/v3/stories", None)).await.unwrap_err();
    assert!(e.contains("not bound"), "{e}");
    assert!(st.list_prompts().await.is_empty());
}

#[tokio::test]
async fn declining_changes_nothing_and_leaves_an_audit_line() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), Some(ENV_TEXT));
    let st = state_with_chat("main-9");
    let id = cards::raise_import(&st, env.clone(), "main-9").await.unwrap().card_id;
    let out = cards::respond(&st, &id, Action::Decline).await.unwrap();
    assert_eq!(out["declined"], true);
    assert!(!env.store_path.exists(), "nothing was stored");
    assert!(st.list_prompts().await.is_empty());
    assert_eq!(audit_lines(&env).last().unwrap()["outcome"], "card_declined");
}

#[tokio::test]
async fn a_chat_cannot_stack_more_than_three_cards() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-10");
    for name in ["FIGMA_TOKEN", "CLOCKIFY_API_KEY", "LINEAR_API_KEY"] {
        cards::raise_replace(&st, env.clone(), "main-10", name).await.unwrap();
    }
    let e = cards::raise_replace(&st, env.clone(), "main-10", "SHORTCUT_API_TOKEN").await.unwrap_err();
    assert!(e.contains("3 broker cards"), "{e}");
    // A card that left (its chat answered or ended) frees the slot.
    let one = st.list_prompts().await[0]["id"].as_str().unwrap().to_string();
    st.remove_prompt(&one).await;
    cards::raise_replace(&st, env, "main-10", "SHORTCUT_API_TOKEN").await.unwrap();
}

#[tokio::test]
async fn a_sub_asking_shows_its_card_in_the_main_chat_and_the_audit_names_the_sub() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), Some(ENV_TEXT));
    let st = state_with_chat("main-11");
    st.registry.upsert_interactive("sub-11", std::path::Path::new("."), "proj", "2026-11-18T00:00:00Z");
    st.registry.set_subchat_of("sub-11", Some("main-11".into()));
    let id = cards::raise_import(&st, env.clone(), "sub-11").await.unwrap().card_id;
    let p = st.list_prompts().await[0]["payload"].clone();
    assert_eq!((p["display_session_id"].clone(), p["session_id"].clone()), (json!("main-11"), json!("main-11")));
    cards::respond(&st, &id, Action::Approve { value: None }).await.unwrap();
    assert_eq!(audit_lines(&env).last().unwrap()["session"], "sub-11");
}

// ---- who may answer ------------------------------------------------------------

async fn open_import(st: &Arc<DaemonState>, dir: &std::path::Path, chat: &str) -> (String, Arc<CardEnv>) {
    let env = env_in(dir, Some(ENV_TEXT));
    let id = cards::raise_import(st, env.clone(), chat).await.unwrap().card_id;
    (id, env)
}

#[tokio::test]
async fn no_question_answer_skip_marker_or_when_done_can_answer_a_broker_card() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let dir = tempfile::tempdir().unwrap();
    let st = state_with_chat("main-12");
    let (id, env) = open_import(&st, dir.path(), "main-12").await;

    // The model-facing and the app-facing question path: an answer, a skip, when-done.
    assert!(!respond_question_inner(&st, &id, json!({"x": "Approve"}), false).await);
    assert!(!respond_question_inner(&st, &id, json!({}), true).await);
    assert!(!crate::daemon::methods::permission::respond_question_as(&st, &id, json!({"x": "Approve"}), false, true).await);
    // A user message carrying the answer marker (what a chat could get a message to say).
    settle_answered_questions(&st, "main-12", &format!("<auq-answer id=\"{id}\"/>User answered: Approve")).await;
    assert_eq!(st.list_prompts().await.len(), 1, "the card is still open");
    assert!(!env.store_path.exists(), "and nothing was stored");

    // Over the RPC, from every transport, including the desktop pipe's when-done mark.
    let params = json!({"request_id": id, "answers": {"x": "Approve"}, "auto_by": "when_done"});
    for t in [Transport::Local, Transport::Phone, Transport::PeerMachine("m1".into())] {
        let resp = dispatch(&st, t, "respond_question", params.clone()).await;
        assert!(resp.error.is_none());
        assert_eq!(resp.result.unwrap()["delivered"], false);
    }
    assert_eq!(st.list_prompts().await.len(), 1);
    assert!(!env.store_path.exists());
}

#[tokio::test]
async fn only_the_desktop_pipe_answers_through_respond_broker_card() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_with_chat("main-13");
    let (id, env) = open_import(&st, dir.path(), "main-13").await;
    let params = json!({"request_id": id, "action": "approve"});
    for t in [Transport::Phone, Transport::PeerMachine("m1".into())] {
        let resp = dispatch(&st, t, "respond_broker_card", params.clone()).await;
        assert!(resp.error.is_some(), "refused like an unknown method: {resp:?}");
    }
    assert_eq!(st.list_prompts().await.len(), 1);
    assert!(!env.store_path.exists());

    let resp = dispatch(&st, Transport::Local, "respond_broker_card", params).await;
    assert_eq!(resp.result.unwrap()["ok"], true);
    assert!(st.list_prompts().await.is_empty());
    assert!(env.store_path.exists());

    // Bad shapes are refused with a reason, not a panic.
    let resp = dispatch(&st, Transport::Local, "respond_broker_card", json!({"request_id": "nope", "action": "approve"})).await;
    assert_eq!(resp.result.unwrap()["ok"], false);
    let resp = dispatch(&st, Transport::Local, "respond_broker_card", json!({"request_id": "nope", "action": "maybe"})).await;
    assert_eq!(resp.result.unwrap()["ok"], false);
}

#[tokio::test]
async fn a_phone_or_a_paired_machine_never_lists_a_broker_card_but_the_desktop_does() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_with_chat("main-14");
    let (id, _env) = open_import(&st, dir.path(), "main-14").await;
    st.add_prompt("plain-q", "question-requested", json!({"session_id": "main-14"}), true).await;
    let ids = |v: Value| -> Vec<String> { v.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect() };
    for (t, sees) in [(Transport::Local, true), (Transport::Phone, false), (Transport::PeerMachine("m1".into()), false)] {
        let resp = dispatch(&st, t.clone(), "list_pending_prompts", json!({})).await;
        let got = ids(resp.result.unwrap());
        assert_eq!(got.contains(&id), sees, "{t:?}");
        assert!(got.contains(&"plain-q".to_string()), "{t:?}: other cards are unaffected");
    }
}

#[tokio::test]
async fn a_pending_card_is_forgotten_when_its_prompt_goes_away_and_the_slot_frees() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-15");
    let id = cards::raise_replace(&st, env.clone(), "main-15", "FIGMA_TOKEN").await.unwrap().card_id;
    st.remove_prompt(&id).await;
    // A fresh ask raises a new card (the stale entry is pruned, not "already open").
    let again = cards::raise_replace(&st, env, "main-15", "FIGMA_TOKEN").await.unwrap();
    assert!(!again.already_open);
    assert_ne!(again.card_id, id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_asks_made_at_once_raise_one_card_and_the_cap_still_holds() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-16");
    let asks = (0..6).map(|_| {
        let (st, env) = (st.clone(), env.clone());
        tokio::spawn(async move { cards::raise_replace(&st, env, "main-16", "FIGMA_TOKEN").await })
    });
    let mut made = 0;
    for h in asks.collect::<Vec<_>>() {
        // An ask that lands while the first is still being raised is told to retry; the rest see the open card.
        match h.await.unwrap() {
            Ok(r) if !r.already_open => made += 1,
            Ok(_) => {}
            Err(e) => assert!(e.contains("being raised"), "{e}"),
        }
    }
    assert_eq!((made, st.list_prompts().await.len()), (1, 1), "the same ask is one card however many arrive together");
    // Different names at once: never more than the cap.
    let names = ["CLOCKIFY_API_KEY", "SHORTCUT_API_TOKEN", "LINEAR_API_KEY", "TRELLO_API_KEY", "FIGMA_TOKEN"];
    let more = names.iter().map(|n| {
        let (st, env, n) = (st.clone(), env.clone(), *n);
        tokio::spawn(async move { cards::raise_replace(&st, env, "main-16", n).await })
    });
    for h in more.collect::<Vec<_>>() {
        let _ = h.await.unwrap();
    }
    assert!(st.list_prompts().await.len() <= 3, "at most three cards are open for one chat");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_answers_at_once_apply_the_card_once() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_with_chat("main-17");
    let (id, env) = open_import(&st, dir.path(), "main-17").await;
    let answers = (0..4).map(|_| {
        let (st, id) = (st.clone(), id.clone());
        tokio::spawn(async move { cards::respond(&st, &id, Action::Approve { value: None }).await })
    });
    let mut ok = 0;
    for h in answers.collect::<Vec<_>>() {
        if h.await.unwrap().is_ok() {
            ok += 1;
        }
    }
    assert_eq!(ok, 1, "only one of the answers applies the card");
    let imports = audit_lines(&env).iter().filter(|l| l["outcome"] == "card_import").count();
    assert_eq!(imports, 1, "one audit line for one apply");
    assert!(st.list_prompts().await.is_empty());
}

#[tokio::test]
async fn a_card_that_is_being_answered_refuses_a_second_answer_and_a_re_ask_and_a_refusal_frees_it() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-18");
    let id = cards::raise_replace(&st, env.clone(), "main-18", "FIGMA_TOKEN").await.unwrap().card_id;
    cards::mark_busy(&id);
    let e = cards::respond(&st, &id, Action::Decline).await.unwrap_err();
    assert!(e.contains("being answered"), "{e}");
    let e = cards::raise_replace(&st, env.clone(), "main-18", "FIGMA_TOKEN").await.unwrap_err();
    assert!(e.contains("answering that card"), "a re-ask must not report a card that may be gone: {e}");
    assert_eq!(st.list_prompts().await.len(), 1, "the card is still there");
}

#[tokio::test]
async fn a_refused_answer_clears_the_busy_mark_so_the_card_still_answers() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-19");
    let id = cards::raise_replace(&st, env, "main-19", "FIGMA_TOKEN").await.unwrap().card_id;
    // No value: the replace card refuses, and must stay answerable.
    assert!(cards::respond(&st, &id, Action::Approve { value: None }).await.is_err());
    assert!(cards::respond(&st, &id, Action::Decline).await.is_ok(), "the refusal left the card busy");
    assert!(st.list_prompts().await.is_empty());
}

#[tokio::test]
async fn a_card_whose_entry_is_lost_is_closed_by_the_next_answer_instead_of_sitting_there() {
    let dir = tempfile::tempdir().unwrap();
    let env = env_in(dir.path(), None);
    let st = state_with_chat("main-20");
    let id = cards::raise_replace(&st, env, "main-20", "FIGMA_TOKEN").await.unwrap().card_id;
    cards::lose_entry(&id);
    let e = cards::respond(&st, &id, Action::Decline).await.unwrap_err();
    assert!(e.contains("already closed"), "{e}");
    assert!(st.list_prompts().await.is_empty(), "the orphaned prompt is taken down");
    assert!(cards::respond(&st, &id, Action::Decline).await.unwrap_err().contains("no such broker card"));
}
