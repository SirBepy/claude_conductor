//! A rule's `fallback` at a usage limit (pc-1833 phase 3). The limit probe is a
//! closure here; `limits::tests` covers what counts as a limit.

use super::*;
use crate::routing::limits::Limit;

fn with_fallback(account: &str, model: Option<&str>, fb: Option<RouteFallback>) -> RouteRule {
    RouteRule { fallback: fb, ..rule(Some(account), model, None) }
}

fn acct(id: &str) -> Option<RouteFallback> {
    Some(RouteFallback::Account { account_id: id.into() })
}

fn limited(ids: &'static [&'static str]) -> impl Fn(&Account) -> Option<Limit> {
    move |a| ids.contains(&a.id.as_str()).then(|| Limit { window: "5h", resets_at: Some(4_000_000_000) })
}

fn go(s: &Settings, explicit: Explicit<'_>, at: &'static [&'static str]) -> Resolved {
    resolve_with(s, None, &accounts(), "build", Some("max-1"), explicit, &limited(at))
}

fn build_rule(r: RouteRule) -> Settings {
    settings(&[("personal", &[("build", r)])])
}

#[test]
fn a_limited_account_moves_to_the_fallback_account_with_a_note() {
    let s = build_rule(with_fallback("max-1", None, acct("max-2")));
    let r = go(&s, Explicit::default(), &["max-1"]);
    assert_eq!(r.account_id.as_deref(), Some("max-2"));
    assert_eq!(r.sources.account, Source::GroupRule);
    assert_eq!(r.notes.len(), 1);
    assert!(r.notes[0].starts_with("max-1 is at its 5h limit (resets "), "{:?}", r.notes);
    assert!(r.notes[0].ends_with("using max-2"), "{:?}", r.notes);
}

#[test]
fn an_account_under_its_limit_stays_and_says_nothing() {
    let s = build_rule(with_fallback("max-1", None, acct("max-2")));
    let r = go(&s, Explicit::default(), &[]);
    assert_eq!((r.account_id.as_deref(), r.notes.len()), (Some("max-1"), 0));
}

#[test]
fn a_fallback_that_is_also_limited_keeps_the_account_and_notes_it() {
    let s = build_rule(with_fallback("max-1", None, acct("max-2")));
    let r = go(&s, Explicit::default(), &["max-1", "max-2"]);
    assert_eq!(r.account_id.as_deref(), Some("max-1"));
    assert!(r.notes[0].contains("and so is the fallback max-2"), "{:?}", r.notes);
}

#[test]
fn wait_and_a_missing_or_api_credit_fallback_keep_the_account_with_a_note() {
    let r = go(&build_rule(with_fallback("max-1", None, Some(RouteFallback::Wait))), Explicit::default(), &["max-1"]);
    assert_eq!(r.account_id.as_deref(), Some("max-1"));
    assert!(r.notes[0].contains("waits for it to reset"), "{:?}", r.notes);
    for target in ["gone", "credit"] {
        let r = go(&build_rule(with_fallback("max-1", None, acct(target))), Explicit::default(), &["max-1"]);
        assert_eq!(r.account_id.as_deref(), Some("max-1"), "{target}");
        assert!(r.notes[0].contains("not usable"), "{target}: {:?}", r.notes);
    }
}

#[test]
fn no_fallback_set_is_unchanged_and_silent() {
    let r = go(&build_rule(with_fallback("max-1", None, None)), Explicit::default(), &["max-1"]);
    assert_eq!((r.account_id.as_deref(), r.notes.len()), (Some("max-1"), 0));
}

#[test]
fn an_override_without_a_fallback_does_not_inherit_the_groups() {
    let s = build_rule(with_fallback("max-1", None, acct("max-2")));
    let p = project(None, &[("build", rule(Some("max-1"), None, None))]);
    let r = resolve_with(&s, Some(&p), &accounts(), "build", Some("max-1"), Explicit::default(), &limited(&["max-1"]));
    assert_eq!((r.account_id.as_deref(), r.notes.len()), (Some("max-1"), 0));
}

#[test]
fn an_explicit_account_is_never_moved() {
    let s = build_rule(with_fallback("max-1", None, acct("max-2")));
    let r = go(&s, Explicit { account_id: Some("max-1"), model: None, effort: None }, &["max-1"]);
    assert_eq!((r.account_id.as_deref(), r.notes.len()), (Some("max-1"), 0));
}

#[test]
fn the_callers_own_account_is_moved_when_the_rule_names_none() {
    let s = build_rule(RouteRule { fallback: acct("max-2"), ..Default::default() });
    let r = go(&s, Explicit::default(), &["max-1"]);
    assert_eq!(r.account_id.as_deref(), Some("max-2"));
}

#[test]
fn the_rules_model_is_kept_when_valid_on_the_fallback_and_dropped_when_not() {
    let s = build_rule(with_fallback("max-1", Some("opus"), acct("max-2")));
    assert_eq!(go(&s, Explicit::default(), &["max-1"]).model.as_deref(), Some("opus"));
    // An Endpoint fallback does not serve a Claude tier: its own first model instead.
    let s = build_rule(with_fallback("max-1", Some("opus"), acct("ds")));
    let r = go(&s, Explicit::default(), &["max-1"]);
    assert_eq!((r.account_id.as_deref(), r.model.as_deref()), (Some("ds"), Some("deepseek-flash")));
}
