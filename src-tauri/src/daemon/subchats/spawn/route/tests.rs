use super::*;
use crate::daemon::lifecycle::provider_gate_tests::endpoint_account;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::{spawn::plan, spawn::plan_remote, SubchatArgs};
use crate::types::{RouteRange, RouteRule, RoutingConfig, Settings};
use std::sync::Arc;

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn rule(account: Option<&str>, model: Option<&str>, effort: Option<&str>) -> RouteRule {
    RouteRule { account_id: account.map(Into::into), model: model.map(Into::into), effort: effort.map(Into::into), ..Default::default() }
}

fn accounts() -> Vec<Account> {
    let mut ep = endpoint_account();
    ep.endpoint.as_mut().unwrap().models = vec!["deepseek-flash".into(), "deepseek-v4-pro".into()];
    vec![ep]
}

/// A state whose project at `ROOT` bills under personal with `rules`.
fn state_with(rules: &[(&str, RouteRule)]) -> Arc<DaemonState> {
    let mut settings = Settings::default();
    crate::settings::upsert_project_for_cwd(&mut settings, std::path::Path::new(ROOT), "2026-11-23T00:00:00Z");
    settings.routing = RoutingConfig {
        groups: [("personal".to_string(), rules.iter().map(|(k, r)| (k.to_string(), r.clone())).collect())].into(),
    };
    DaemonState::new(new_session_map(), SettingsCache::new(settings))
}

fn main_row(st: &DaemonState, id: &str) {
    st.registry.upsert_interactive(id, std::path::Path::new(ROOT), "proj", "2026-11-23T00:00:00Z");
}

fn args(writes: bool) -> SubchatArgs {
    SubchatArgs {
        task: Some("t".into()),
        goal: Some("g".into()),
        done_when: Some("d".into()),
        writes: Some(writes),
        files: writes.then(|| vec!["a.rs".into()]),
        ..Default::default()
    }
}

fn cfg() -> ChatConfig {
    ChatConfig { subchats_on: true, ..Default::default() }
}

fn plan_for(
    st: &DaemonState,
    parent: &str,
    writes: bool,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<crate::daemon::subchats::spawn::SubPlan, String> {
    main_row(st, parent);
    plan(st, parent, &cfg(), ROOT, None, model, effort, Some("job"), &args(writes), &accounts()).map(|p| p.expect("a sub plan"))
}

#[test]
fn the_kind_of_a_sub_is_build_for_a_writer_research_for_a_reader_and_gate_for_a_gate() {
    assert_eq!(route_kind_for_sub(true, false), "build");
    assert_eq!(route_kind_for_sub(false, false), "research");
    assert_eq!(route_kind_for_sub(true, true), "gate");
}

#[test]
fn a_sub_with_no_rule_plans_exactly_as_before() {
    let st = state_with(&[]);
    let p = plan_for(&st, "rt-none", true, None, None).unwrap();
    assert_eq!((p.model.as_str(), p.effort.as_str(), p.account_id.clone(), p.routing.is_none()), ("sonnet", "medium", None, true));
}

#[test]
fn a_writing_sub_follows_the_build_rule_and_a_read_only_one_the_research_rule() {
    let st = state_with(&[("build", rule(Some("ep-1"), Some("deepseek-v4-pro"), Some("high"))), ("research", rule(None, Some("opus"), None))]);
    let w = plan_for(&st, "rt-build", true, Some("sonnet"), Some("high")).unwrap();
    // An Endpoint account: no tier rules, the rule's model, and the main chat's Claude tier is not sent.
    assert_eq!((w.model.as_str(), w.effort.as_str(), w.account_id.as_deref()), ("deepseek-v4-pro", "high", Some("ep-1")));
    let applied = w.routing.expect("applied");
    assert_eq!(applied.kind, "build");
    assert!(applied.notes.iter().any(|n| n.contains("sonnet")), "{:?}", applied.notes);
    let r = plan_for(&st, "rt-research", false, None, None).unwrap();
    assert_eq!((r.model.as_str(), r.effort.as_str(), r.account_id.clone()), ("opus", "high", None));
    assert_eq!(r.routing.expect("applied").kind, "research");
}

#[test]
fn an_opus_rule_for_a_writing_sub_falls_back_to_the_tier_default_with_a_note() {
    let st = state_with(&[("build", rule(None, Some("opus"), Some("high")))]);
    let p = plan_for(&st, "rt-opus", true, None, None).unwrap();
    assert_eq!((p.model.as_str(), p.effort.as_str()), ("sonnet", "medium"));
    let notes = p.routing.expect("a note says why").notes;
    assert!(notes.len() == 1 && notes[0].contains("opus") && notes[0].contains("tier default"), "{notes:?}");
    // The main chat's own Opus pick for a writer is still refused, never rewritten.
    let err = plan_for(&st, "rt-opus2", true, Some("opus"), Some("high")).err().expect("refused");
    assert!(err.contains("cannot edit files"), "{err}");
}

#[test]
fn a_rule_that_only_sets_the_account_runs_the_accounts_own_first_model() {
    let st = state_with(&[("build", rule(Some("ep-1"), None, None))]);
    let p = plan_for(&st, "rt-acct", true, Some("sonnet"), Some("high")).unwrap();
    assert_eq!((p.model.as_str(), p.account_id.as_deref()), ("deepseek-flash", Some("ep-1")));
}

#[test]
fn the_range_clamps_a_main_chats_tier_and_the_spawn_result_says_so() {
    let ranged = RouteRule { range: Some(RouteRange { min_effort: Some("high".into()), ..Default::default() }), ..Default::default() };
    let st = state_with(&[("build", ranged)]);
    let p = plan_for(&st, "rt-clamp", true, Some("sonnet"), Some("medium")).unwrap();
    assert_eq!((p.model.as_str(), p.effort.as_str()), ("sonnet", "high"));
    let applied = p.routing.expect("applied");
    let mut body = serde_json::json!({"ok": true});
    applied.attach(&mut body);
    assert!(body["routing_note"].as_str().unwrap().contains("medium"), "{body}");
    assert_eq!(body["routing"]["effort"], "high");
}

#[test]
fn a_sub_placed_on_another_machine_ignores_this_machines_rules() {
    let st = state_with(&[("build", rule(Some("ep-1"), Some("deepseek-v4-pro"), None))]);
    main_row(&st, "rt-remote");
    let p = plan_remote(&st, "rt-remote", &cfg(), None, None, None, Some("job"), &args(true), &accounts()).unwrap().unwrap();
    assert_eq!((p.model.as_str(), p.account_id, p.routing.is_none()), ("sonnet", None, true));
}
