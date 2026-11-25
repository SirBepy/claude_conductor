use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::types::{RouteRule, RoutingConfig, Settings};

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn state_with(rules: &[(&str, RouteRule)]) -> Arc<DaemonState> {
    let mut settings = Settings::default();
    crate::settings::upsert_project_for_cwd(&mut settings, std::path::Path::new(ROOT), "2026-11-23T00:00:00Z");
    settings.routing = RoutingConfig {
        groups: [("personal".to_string(), rules.iter().map(|(k, r)| (k.to_string(), r.clone())).collect())].into(),
    };
    DaemonState::new(new_session_map(), SettingsCache::new(settings))
}

fn rule(model: &str, effort: &str) -> RouteRule {
    RouteRule { model: Some(model.into()), effort: Some(effort.into()), ..Default::default() }
}

#[test]
fn a_main_chat_spawn_uses_main_chat_and_every_other_new_chat_new_chat() {
    assert_eq!(plain_kind(true), "main_chat");
    assert_eq!(plain_kind(false), "new_chat");
}

#[test]
fn a_new_chat_follows_the_new_chat_rule_and_a_main_chat_its_own() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let st = state_with(&[("new_chat", rule("haiku", "low")), ("main_chat", rule("opus", "high"))]);
    let cwd = std::path::Path::new(ROOT);
    let inherited = ChatConfig::default();
    let n = route_plain(&st, cwd, plain_kind(false), &inherited, None, None, false);
    assert_eq!((n.model.as_str(), n.effort.as_str()), ("haiku", "low"));
    assert_eq!(n.applied.expect("applied").kind, "new_chat");
    let m = route_plain(&st, cwd, plain_kind(true), &inherited, None, None, false);
    assert_eq!((m.model.as_str(), m.effort.as_str()), ("opus", "high"));
    // What the caller named wins over the rule.
    let e = route_plain(&st, cwd, plain_kind(false), &inherited, Some("sonnet"), None, false);
    assert_eq!((e.model.as_str(), e.effort.as_str()), ("sonnet", "low"));
}

#[test]
fn with_no_rule_a_chat_on_an_endpoint_account_runs_a_model_from_its_own_list() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let mut account = crate::daemon::lifecycle::provider_gate_tests::endpoint_account();
    account.endpoint.as_mut().expect("endpoint").models = vec!["k3.1-pro".into(), "k3.1-lite".into()];
    crate::accounts::store::save(&crate::settings::paths::accounts_file().unwrap(), &[account.clone()]).unwrap();
    let st = state_with(&[]);
    let cwd = std::path::Path::new(ROOT);
    let inherited = ChatConfig { account_id: account.id.clone(), ..Default::default() };
    // A Claude tier is not in the account's list: the list's first model replaces it.
    let swapped = route_plain(&st, cwd, "new_chat", &inherited, Some("opus"), None, false);
    assert_eq!(swapped.model, "k3.1-pro");
    assert!(swapped.applied.is_none() && swapped.account_id.is_none());
    // A model the list holds is kept.
    let kept = route_plain(&st, cwd, "new_chat", &inherited, Some("k3.1-lite"), None, false);
    assert_eq!(kept.model, "k3.1-lite");
    // A chat on no endpoint account keeps the Claude tier it named.
    let claude = route_plain(&st, cwd, "new_chat", &ChatConfig::default(), Some("opus"), None, false);
    assert_eq!(claude.model, "opus");
}

#[test]
fn a_respawn_keeps_its_own_model_and_no_rule_means_the_old_path() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let st = state_with(&[("main_chat", rule("haiku", "low"))]);
    let cwd = std::path::Path::new(ROOT);
    let inherited = ChatConfig { model: "opus".into(), effort: "max".into(), ..Default::default() };
    let r = route_plain(&st, cwd, "main_chat", &inherited, None, None, true);
    assert_eq!((r.model.as_str(), r.effort.as_str()), ("opus", "max"));
    let none = route_plain(&st, cwd, "new_chat", &inherited, None, None, false);
    assert!(none.applied.is_none() && none.account_id.is_none());
}
