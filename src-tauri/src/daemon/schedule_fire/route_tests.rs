use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::types::{RouteRange, RouteRule, RoutingConfig, Settings};

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn state_with(rule: RouteRule, kind: &str) -> Arc<DaemonState> {
    let mut settings = Settings::default();
    crate::settings::upsert_project_for_cwd(&mut settings, std::path::Path::new(ROOT), "2026-11-23T00:00:00Z");
    settings.routing = RoutingConfig { groups: [("personal".to_string(), [(kind.to_string(), rule)].into())].into() };
    DaemonState::new(new_session_map(), SettingsCache::new(settings))
}

#[test]
fn a_fired_new_chat_is_clamped_by_its_kinds_range_and_main_chat_has_its_own_rule() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let ranged = RouteRule { range: Some(RouteRange { max_model: Some("sonnet".into()), ..Default::default() }), ..Default::default() };
    let st = state_with(ranged.clone(), "new_chat");
    let (m, e, a) = route_fired(&st, ROOT, false, "opus", "high", Some("acct-a"));
    assert_eq!((m.as_str(), e.as_str(), a.as_deref()), ("sonnet", "high", Some("acct-a")));
    // A fire that turns the mode on is a main chat: the new_chat rule does not apply.
    let (m, _, _) = route_fired(&st, ROOT, true, "opus", "high", None);
    assert_eq!(m, "opus");
    let st = state_with(ranged, "main_chat");
    let (m, _, _) = route_fired(&st, ROOT, true, "opus", "high", None);
    assert_eq!(m, "sonnet");
}

#[test]
fn a_fired_new_chat_with_no_rule_is_untouched() {
    let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    assert_eq!(route_fired(&st, ROOT, false, "opus", "high", None), ("opus".to_string(), "high".to_string(), None));
}
