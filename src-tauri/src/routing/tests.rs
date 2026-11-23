use super::*;
mod fallback;
use crate::accounts::EndpointConfig;
use crate::types::{RouteFallback, RoutingConfig};
use std::path::PathBuf;

fn account(id: &str, kind: AccountKind, models: &[&str]) -> Account {
    Account {
        id: id.into(),
        label: id.into(),
        colour: "#fff".into(),
        icon: "key".into(),
        config_dir: PathBuf::from("C:/home/.claude-x"),
        chrome_profile_dir: PathBuf::from("C:/appdata/chrome-profiles/x"),
        email: String::new(),
        org_uuid: "ORG".into(),
        subscription_tier: String::new(),
        created_at: "2026-11-23T00:00:00Z".into(),
        fleet_eligible: false,
        kind,
        endpoint: (kind == AccountKind::Endpoint).then(|| EndpointConfig {
            base_url: "https://p.example".into(),
            models: models.iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        }),
    }
}

fn accounts() -> Vec<Account> {
    vec![
        account("max-1", AccountKind::Subscription, &[]),
        account("max-2", AccountKind::Subscription, &[]),
        account("ds", AccountKind::Endpoint, &["deepseek-flash", "deepseek-v4-pro"]),
        account("credit", AccountKind::ApiCredit, &[]),
    ]
}

fn rule(account: Option<&str>, model: Option<&str>, effort: Option<&str>) -> RouteRule {
    RouteRule { account_id: account.map(Into::into), model: model.map(Into::into), effort: effort.map(Into::into), ..Default::default() }
}

fn ranged(min_model: Option<&str>, max_model: Option<&str>, min_effort: Option<&str>, max_effort: Option<&str>) -> RouteRule {
    RouteRule {
        range: Some(RouteRange {
            min_model: min_model.map(Into::into),
            max_model: max_model.map(Into::into),
            min_effort: min_effort.map(Into::into),
            max_effort: max_effort.map(Into::into),
        }),
        ..Default::default()
    }
}

fn project(group: Option<&str>, overrides: &[(&str, RouteRule)]) -> ProjectConfig {
    let mut p: ProjectConfig = serde_json::from_value(serde_json::json!({
        "id": "p1", "path": "C:/proj", "name": "proj", "created_at": "2026-11-23T00:00:00Z"
    }))
    .unwrap();
    p.payment_group = group.map(Into::into);
    p.routing_overrides = overrides.iter().map(|(k, r)| (k.to_string(), r.clone())).collect();
    p
}

fn settings(groups: &[(&str, &[(&str, RouteRule)])]) -> Settings {
    let mut s = Settings::default();
    s.routing = RoutingConfig {
        groups: groups.iter().map(|(g, rules)| (g.to_string(), rules.iter().map(|(k, r)| (k.to_string(), r.clone())).collect())).collect(),
    };
    s
}

fn run(s: &Settings, p: Option<&ProjectConfig>, kind: &str, explicit: Explicit<'_>) -> Resolved {
    resolve(s, p, &accounts(), kind, Some("max-1"), explicit)
}

#[test]
fn precedence_runs_explicit_then_project_override_then_group_rule_then_today() {
    let group = rule(Some("max-2"), Some("sonnet"), Some("low"));
    let over = rule(Some("ds"), Some("deepseek-flash"), Some("high"));
    let none = Explicit::default();
    let s = settings(&[("personal", &[("build", group)])]);

    // Group rule alone.
    let r = run(&s, Some(&project(None, &[])), "build", none);
    assert_eq!((r.account_id.as_deref(), r.model.as_deref(), r.effort.as_deref()), (Some("max-2"), Some("sonnet"), Some("low")));
    assert_eq!(r.sources, FieldSources { account: Source::GroupRule, model: Source::GroupRule, effort: Source::GroupRule });
    assert_eq!(r.source, Source::GroupRule);

    // A project override beats the group rule, field by field.
    let p = project(None, &[("build", over)]);
    let r = run(&s, Some(&p), "build", none);
    assert_eq!((r.account_id.as_deref(), r.model.as_deref(), r.effort.as_deref()), (Some("ds"), Some("deepseek-flash"), Some("high")));
    assert_eq!(r.source, Source::ProjectOverride);

    // An explicit pick beats both, for the field it names only.
    let explicit = Explicit { account_id: Some("max-1"), model: Some("opus"), effort: None };
    let r = run(&s, Some(&p), "build", explicit);
    assert_eq!((r.account_id.as_deref(), r.model.as_deref(), r.effort.as_deref()), (Some("max-1"), Some("opus"), Some("high")));
    assert_eq!(r.sources, FieldSources { account: Source::Explicit, model: Source::Explicit, effort: Source::ProjectOverride });

    // Nothing: today's behaviour, every field left to the caller.
    let r = run(&s, Some(&project(None, &[])), "review", none);
    assert_eq!((r.account_id, r.model, r.effort, r.source), (None, None, None, Source::Default));
    let r = run(&s, None, "build", none);
    assert_eq!(r.account_id.as_deref(), Some("max-2"), "a chat in no registered project bills as personal");
}

#[test]
fn each_field_resolves_on_its_own() {
    let s = settings(&[("personal", &[("fix", rule(Some("max-2"), None, None)), ("test", rule(None, None, Some("high")))])]);
    let r = run(&s, None, "fix", Explicit::default());
    assert_eq!((r.account_id.as_deref(), r.model, r.effort), (Some("max-2"), None, None));
    let r = run(&s, None, "test", Explicit::default());
    assert_eq!((r.account_id, r.model, r.effort.as_deref()), (None, None, Some("high")));
    // The override sets only the model: the account still comes from the group rule.
    let s = settings(&[("personal", &[("fix", rule(Some("max-2"), Some("opus"), None))])]);
    let p = project(None, &[("fix", rule(None, Some("sonnet"), None))]);
    let r = run(&s, Some(&p), "fix", Explicit::default());
    assert_eq!((r.account_id.as_deref(), r.model.as_deref()), (Some("max-2"), Some("sonnet")));
    assert_eq!((r.sources.account, r.sources.model), (Source::GroupRule, Source::ProjectOverride));
}

#[test]
fn the_payment_group_picks_the_rule_set_and_none_reads_as_personal() {
    let s = settings(&[
        ("personal", &[("build", rule(Some("ds"), None, None))]),
        ("client", &[("build", rule(Some("max-2"), None, None))]),
    ]);
    assert_eq!(run(&s, Some(&project(None, &[])), "build", Explicit::default()).account_id.as_deref(), Some("ds"));
    assert_eq!(run(&s, Some(&project(Some("personal"), &[])), "build", Explicit::default()).account_id.as_deref(), Some("ds"));
    assert_eq!(run(&s, Some(&project(Some("client"), &[])), "build", Explicit::default()).account_id.as_deref(), Some("max-2"));
    // A group nobody configured has no rules.
    assert_eq!(run(&s, Some(&project(Some("agency"), &[])), "build", Explicit::default()).account_id, None);
}

#[test]
fn a_kind_is_any_string_and_an_unknown_one_has_no_rule() {
    let s = settings(&[("personal", &[("brand-new-kind", rule(Some("max-2"), None, None))])]);
    assert!(has_rules(&s, None, "brand-new-kind"));
    assert!(!has_rules(&s, None, "build"));
    assert_eq!(run(&s, None, "no-such-kind", Explicit::default()).source, Source::Default);
    assert!(KNOWN_KINDS.contains(&"errand") && KNOWN_KINDS.contains(&"main_chat"));
}

#[test]
fn a_rule_naming_a_deleted_or_api_credit_account_falls_through() {
    let gone = rule(Some("deleted"), Some("sonnet"), None);
    let s = settings(&[("personal", &[("build", rule(Some("max-2"), None, None))])]);
    // The override's account is gone: the group rule's account decides, the model stays.
    let p = project(None, &[("build", gone.clone())]);
    let r = run(&s, Some(&p), "build", Explicit::default());
    assert_eq!((r.account_id.as_deref(), r.model.as_deref()), (Some("max-2"), Some("sonnet")));
    assert_eq!(r.sources.account, Source::GroupRule);
    // No other rule: the account is left to today's behaviour.
    let s = settings(&[("personal", &[("build", gone)])]);
    let r = run(&s, None, "build", Explicit::default());
    assert_eq!((r.account_id, r.model.as_deref()), (None, Some("sonnet")));
    // An API-credit account is never routable.
    let s = settings(&[("personal", &[("build", rule(Some("credit"), None, None))])]);
    assert_eq!(run(&s, None, "build", Explicit::default()).account_id, None);
}

#[test]
fn a_rule_model_is_checked_against_the_account_it_runs_on() {
    // Endpoint id on a Claude account: refused, falls through to the next rule.
    let s = settings(&[("personal", &[("build", rule(None, Some("sonnet"), None))])]);
    let p = project(None, &[("build", rule(Some("max-2"), Some("deepseek-v4-pro"), None))]);
    let r = run(&s, Some(&p), "build", Explicit::default());
    assert_eq!(r.model.as_deref(), Some("sonnet"));
    assert_eq!(r.sources.model, Source::GroupRule);
    // The same id on the Endpoint account is fine.
    let p = project(None, &[("build", rule(Some("ds"), Some("deepseek-v4-pro"), None))]);
    let r = run(&s, Some(&p), "build", Explicit::default());
    assert_eq!((r.model.as_deref(), r.sources.model), (Some("deepseek-v4-pro"), Source::ProjectOverride));
    // An unsafe id is refused on either kind.
    let s = settings(&[("personal", &[("build", rule(Some("ds"), Some("--flag"), Some("turbo")))])]);
    let r = run(&s, None, "build", Explicit::default());
    assert_eq!(r.effort, None, "an unknown effort falls through");
    assert_eq!(r.model.as_deref(), Some("deepseek-flash"), "an Endpoint account's own first model fills in");
    assert_eq!(r.sources.model, Source::Default);
    // The model is judged against the BASE account when the rule names none.
    let s = settings(&[("personal", &[("build", rule(None, Some("deepseek-v4-pro"), None))])]);
    let r = resolve(&s, None, &accounts(), "build", Some("ds"), Explicit::default());
    assert_eq!(r.model.as_deref(), Some("deepseek-v4-pro"));
    let r = resolve(&s, None, &accounts(), "build", Some("max-1"), Explicit::default());
    assert_eq!(r.model, None);
}

#[test]
fn an_explicit_claude_tier_is_not_sent_to_an_endpoint_account_a_rule_picked() {
    let s = settings(&[("personal", &[("build", rule(Some("ds"), Some("deepseek-v4-pro"), None))])]);
    let r = run(&s, None, "build", Explicit { model: Some("sonnet"), ..Default::default() });
    assert_eq!(r.model.as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(r.sources.model, Source::GroupRule);
    assert!(r.notes.iter().any(|n| n.contains("sonnet")), "{:?}", r.notes);
    // A model the account does serve stands.
    let r = run(&s, None, "build", Explicit { model: Some("deepseek-flash"), ..Default::default() });
    assert_eq!((r.model.as_deref(), r.sources.model), (Some("deepseek-flash"), Source::Explicit));
}

#[test]
fn a_range_clamps_an_explicit_model_and_effort_both_ways() {
    let s = settings(&[("personal", &[("review", ranged(Some("sonnet"), Some("opus"), Some("medium"), Some("high")))])]);
    let go = |model: &str, effort: &str| {
        let r = run(&s, None, "review", Explicit { model: Some(model), effort: Some(effort), ..Default::default() });
        (r.model.unwrap(), r.effort.unwrap(), r.notes)
    };
    let (m, e, notes) = go("haiku", "low");
    assert_eq!((m.as_str(), e.as_str()), ("sonnet", "medium"), "raised to the minimum");
    assert_eq!(notes.len(), 2);
    assert!(notes[0].contains("haiku") && notes[0].contains("below") && notes[0].contains("sonnet"), "{notes:?}");
    let (m, e, notes) = go("fable", "max");
    assert_eq!((m.as_str(), e.as_str()), ("opus", "high"), "lowered to the maximum");
    assert!(notes[0].contains("above"), "{notes:?}");
    // Inside the range, and a full model id, stay untouched.
    let (m, e, notes) = go("claude-opus-4-8", "medium");
    assert_eq!((m.as_str(), e.as_str(), notes.len()), ("claude-opus-4-8", "medium", 0));
    // Only one side set.
    let s = settings(&[("personal", &[("review", ranged(None, Some("sonnet"), None, None))])]);
    let r = run(&s, None, "review", Explicit { model: Some("opus"), effort: Some("max"), ..Default::default() });
    assert_eq!((r.model.as_deref(), r.effort.as_deref()), (Some("sonnet"), Some("max")));
}

#[test]
fn a_range_ranks_an_endpoint_accounts_models_by_list_position() {
    let s = settings(&[("personal", &[("build", RouteRule { account_id: Some("ds".into()), ..ranged(None, Some("deepseek-flash"), None, None) })])]);
    let r = run(&s, None, "build", Explicit { model: Some("deepseek-v4-pro"), ..Default::default() });
    assert_eq!(r.model.as_deref(), Some("deepseek-flash"));
    // A model the list does not hold cannot be ranked, so it is left alone.
    let s = settings(&[("personal", &[("build", ranged(None, Some("deepseek-flash"), None, None))])]);
    let r = resolve(&s, None, &accounts(), "build", Some("ds"), Explicit { model: Some("other-model"), ..Default::default() });
    assert_eq!(r.model.as_deref(), Some("other-model"));
}

#[test]
fn a_range_never_touches_a_model_a_rule_chose_and_a_broken_range_is_ignored() {
    let both = RouteRule { model: Some("haiku".into()), ..ranged(Some("sonnet"), None, None, None) };
    let s = settings(&[("personal", &[("build", both)])]);
    let r = run(&s, None, "build", Explicit::default());
    assert_eq!((r.model.as_deref(), r.notes.len()), (Some("haiku"), 0));
    // Minimum above maximum: ignored, not applied half way.
    let s = settings(&[("personal", &[("build", ranged(Some("opus"), Some("sonnet"), None, None))])]);
    let r = run(&s, None, "build", Explicit { model: Some("haiku"), ..Default::default() });
    assert_eq!(r.model.as_deref(), Some("haiku"));
    // The range of the override applies when it has one, else the group's.
    let s = settings(&[("personal", &[("build", ranged(Some("opus"), None, None, None))])]);
    let p = project(None, &[("build", rule(None, None, None))]);
    let r = run(&s, Some(&p), "build", Explicit { model: Some("haiku"), ..Default::default() });
    assert_eq!(r.model.as_deref(), Some("opus"));
}

#[test]
fn old_settings_and_projects_load_unchanged_and_the_new_shapes_round_trip() {
    let s: Settings = serde_json::from_str(r#"{"pollIntervalSecs": 1, "projects": []}"#).unwrap();
    assert_eq!(s.routing, RoutingConfig::default());
    let s: Settings = serde_json::from_str("{}").unwrap();
    assert!(s.routing.groups.is_empty() && !s.extra.contains_key("routing"));
    // An old project row has neither field; a half-written routing block still loads.
    let old: ProjectConfig = serde_json::from_str(r#"{"id":"p","path":"C:/p","name":"p","created_at":"x"}"#).unwrap();
    assert!(old.routing_overrides.is_empty() && old.payment_group.is_none());
    let s: Settings = serde_json::from_str(r#"{"routing": {"groups": {"personal": {"build": {"model": "sonnet"}}}}}"#).unwrap();
    assert_eq!(s.routing.groups["personal"]["build"], rule(None, Some("sonnet"), None));
    let s: Settings = serde_json::from_str(r#"{"routing": {}}"#).unwrap();
    assert!(s.routing.groups.is_empty());

    let full = RouteRule {
        account_id: Some("a".into()),
        model: Some("m".into()),
        effort: Some("high".into()),
        fallback: Some(RouteFallback::Account { account_id: "b".into() }),
        range: Some(RouteRange { min_model: Some("sonnet".into()), ..Default::default() }),
    };
    let json = serde_json::to_value(&full).unwrap();
    assert_eq!(json["fallback"], serde_json::json!({"kind": "account", "account_id": "b"}));
    assert_eq!(serde_json::from_value::<RouteRule>(json).unwrap(), full);
    let wait: RouteRule = serde_json::from_str(r#"{"fallback": {"kind": "wait"}}"#).unwrap();
    assert_eq!(wait.fallback, Some(RouteFallback::Wait));
}
