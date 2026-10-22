//! Card operations shared by the desktop RPCs and the `dashboard_card` MCP
//! tool. The store-touching shells are thin; the rules (which scope a chat may
//! write, how an MCP card is normalised) are pure fns over a `DashboardStore`
//! so they are tested without touching the real data dir.

use super::publish_changed;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::store::{self, contains_path};
use crate::project_dashboard::types::cwd_key;
use crate::project_dashboard::{
    env_secret, run_card, CardConfig, CardResult, CardView, DashboardStore, GroupDef, Scope, TemplateCtx,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The repo a card runs against: a project's own cwd, or a group's first repo.
pub(super) fn run_cwd(scope: &Scope, groups: &[GroupDef]) -> String {
    match scope {
        Scope::Project { cwd } => cwd.clone(),
        Scope::Group { id } => {
            groups.iter().find(|g| &g.id == id).and_then(|g| g.repos.first().cloned()).unwrap_or_default()
        }
    }
}

/// Runs a card without touching the cache (the MCP `test` action).
pub(super) async fn run_uncached(card: &CardConfig, groups: &[GroupDef]) -> CardResult {
    let ctx = TemplateCtx::for_cwd(&run_cwd(&card.scope, groups));
    run_card(card, &ctx, &env_secret).await
}

/// Runs a card and stores the result, so the dashboard paints it after a restart.
pub(super) async fn run_and_cache(card: &CardConfig, groups: &[GroupDef]) -> CardResult {
    let result = run_uncached(card, groups).await;
    store::save_result(&card.id, result.clone());
    result
}

pub(super) fn views(cards: Vec<&CardConfig>, results: &BTreeMap<String, CardResult>) -> Vec<CardView> {
    cards.into_iter().map(|c| CardView { config: c.clone(), result: results.get(&c.id).cloned() }).collect()
}

/// Drops cache entries for cards that no longer exist.
pub(super) fn prune_cache_to_live_cards() {
    let live: Vec<String> = store::load().cards.into_iter().map(|c| c.id).collect();
    store::prune_cache(&live);
}

/// A chat may touch only its own project's scope, or a group that lists its
/// project as a repo. Compared through the same normalisation `scope_key` uses
/// so `C:\x\app` and `c:/x/app` are one project.
pub(super) fn scope_allowed(scope: &Scope, own_cwd: &str, groups: &[GroupDef]) -> bool {
    match scope {
        Scope::Project { cwd } => cwd_key(cwd) == cwd_key(own_cwd),
        Scope::Group { id } => groups.iter().any(|g| &g.id == id && contains_path(&g.repos, own_cwd)),
    }
}

/// Turns the model's `card` argument into a `CardConfig`: nulls are dropped
/// (serde's `default` covers a missing key, not an explicit null), a card with
/// no `enabled` is on (a chat adding a card means to see it, while the struct
/// default is off), and a missing scope becomes the caller's own project.
pub(super) fn parse_card(card: Value, own_cwd: &str) -> Result<CardConfig, String> {
    let Value::Object(mut map) = card else { return Err("card must be an object".to_string()) };
    map.retain(|_, v| !v.is_null());
    map.entry("enabled").or_insert(Value::Bool(true));
    let mut card: CardConfig = serde_json::from_value(Value::Object(map)).map_err(|e| format!("invalid card: {e}"))?;
    if matches!(&card.scope, Scope::Project { cwd } if cwd.trim().is_empty()) {
        card.scope = Scope::Project { cwd: own_cwd.to_string() };
    }
    Ok(card)
}

/// Saves a chat-authored card. Both the incoming scope and the scope of any
/// card already holding that id must be the caller's: otherwise a chat could
/// overwrite another project's card, or move its own into a foreign scope, by
/// reusing an id.
pub(super) fn apply_upsert(store: &mut DashboardStore, card: CardConfig, own_cwd: &str) -> Result<CardConfig, String> {
    if !scope_allowed(&card.scope, own_cwd, &store.groups) {
        return Err("this chat can only write cards for its own project or a group containing it".to_string());
    }
    let held = !card.id.trim().is_empty() && store.cards.iter().any(|c| c.id == card.id && !scope_allowed(&c.scope, own_cwd, &store.groups));
    if held {
        return Err(format!("card {} belongs to another project", card.id));
    }
    let id = store.upsert_card(card);
    Ok(store.cards.iter().find(|c| c.id == id).cloned().unwrap_or_default())
}

pub(super) fn apply_delete(store: &mut DashboardStore, id: &str, own_cwd: &str) -> Result<(), String> {
    let Some(card) = store.cards.iter().find(|c| c.id == id) else { return Err(format!("no such card: {id}")) };
    if !scope_allowed(&card.scope, own_cwd, &store.groups) {
        return Err(format!("card {id} belongs to another project"));
    }
    store.delete_card(id);
    Ok(())
}

/// The caller's project path (what dashboard scopes are keyed by), falling
/// back to the session's own cwd when its project is not in settings. Never an
/// argument, same trust model as `channel::caller_project`.
pub(super) fn caller_cwd(state: &DaemonState, session_id: &str) -> Result<String, String> {
    let inst = state.registry.get(session_id).ok_or_else(|| format!("unknown session: {session_id}"))?;
    let settings = state.settings.snapshot();
    Ok(settings
        .projects
        .iter()
        .find(|p| p.id == inst.project_id)
        .map(|p| p.path.to_string_lossy().into_owned())
        .unwrap_or_else(|| inst.cwd.to_string_lossy().into_owned()))
}

/// The `dashboard_card` MCP tool. Replies `{ok: true, ...}`; a refusal is an
/// `Err`, which the hooks route turns into `{ok: false, error}`.
pub(crate) async fn dashboard_card_tool(
    state: &Arc<DaemonState>,
    session_id: &str,
    action: &str,
    card: Option<Value>,
    id: Option<String>,
) -> Result<Value, String> {
    let own_cwd = caller_cwd(state, session_id)?;
    match action {
        "list" => {
            let st = store::load();
            let mine: Vec<&CardConfig> =
                st.cards.iter().filter(|c| scope_allowed(&c.scope, &own_cwd, &st.groups)).collect();
            Ok(json!({"ok": true, "cards": views(mine, &store::all_results())}))
        }
        "upsert" => {
            let card = parse_card(card.ok_or("card is required")?, &own_cwd)?;
            let saved = store::update(|s| apply_upsert(s, card, &own_cwd)).ok_or("dashboard storage unavailable")??;
            publish_changed(state);
            Ok(json!({"ok": true, "card": saved}))
        }
        "delete" => {
            let id = id.filter(|i| !i.trim().is_empty()).ok_or("id is required")?;
            store::update(|s| apply_delete(s, &id, &own_cwd)).ok_or("dashboard storage unavailable")??;
            prune_cache_to_live_cards();
            publish_changed(state);
            Ok(json!({"ok": true}))
        }
        "test" => {
            let card = parse_card(card.ok_or("card is required")?, &own_cwd)?;
            let groups = store::load().groups;
            if !scope_allowed(&card.scope, &own_cwd, &groups) {
                return Err("this chat can only test cards for its own project or a group containing it".to_string());
            }
            Ok(json!({"ok": true, "result": run_uncached(&card, &groups).await}))
        }
        other => Err(format!("unknown action: {other} (want list|upsert|delete|test)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::project_dashboard::{CardDisplay, CardSource};
    use crate::types::Settings;

    const ME: &str = "C:/work/app";

    fn group(id: &str, repos: &[&str]) -> GroupDef {
        GroupDef { id: id.into(), repos: repos.iter().map(|r| r.to_string()).collect(), ..Default::default() }
    }

    fn card(id: &str, scope: Scope) -> CardConfig {
        CardConfig {
            id: id.into(),
            scope,
            title: "t".into(),
            enabled: true,
            source: CardSource::Command { program: "echo".into(), args: vec![], cwd: None },
            display: CardDisplay::Stats { items: vec![] },
            refresh_secs: None,
        }
    }

    fn proj(cwd: &str) -> Scope {
        Scope::Project { cwd: cwd.into() }
    }

    #[test]
    fn own_project_is_allowed_whatever_the_path_style() {
        assert!(scope_allowed(&proj(ME), ME, &[]));
        assert!(scope_allowed(&proj("c:\\WORK\\app\\"), ME, &[]));
    }

    #[test]
    fn a_group_containing_the_caller_is_allowed() {
        let groups = [group("g1", &["C:\\work\\app", "C:/work/api"])];
        assert!(scope_allowed(&Scope::Group { id: "g1".into() }, ME, &groups));
    }

    #[test]
    fn a_foreign_project_is_refused() {
        assert!(!scope_allowed(&proj("C:/work/other"), ME, &[]));
        assert!(!scope_allowed(&proj("C:/work/app2"), ME, &[]));
    }

    #[test]
    fn a_foreign_or_unknown_group_is_refused() {
        let groups = [group("g1", &["C:/work/api"])];
        assert!(!scope_allowed(&Scope::Group { id: "g1".into() }, ME, &groups));
        assert!(!scope_allowed(&Scope::Group { id: "nope".into() }, ME, &groups));
    }

    #[test]
    fn an_absent_scope_defaults_to_the_callers_project() {
        let c = parse_card(json!({"title": "x", "source": {"kind": "command", "program": "echo"}}), ME).unwrap();
        assert_eq!(c.scope, proj(ME));
        let c = parse_card(json!({"title": "x", "scope": null}), ME).unwrap();
        assert_eq!(c.scope, proj(ME));
    }

    #[test]
    fn a_card_without_enabled_is_on_and_an_explicit_false_sticks() {
        assert!(parse_card(json!({"title": "x"}), ME).unwrap().enabled);
        assert!(!parse_card(json!({"title": "x", "enabled": false}), ME).unwrap().enabled);
    }

    #[test]
    fn a_non_object_card_is_an_error() {
        assert!(parse_card(json!("nope"), ME).is_err());
    }

    #[test]
    fn upsert_writes_own_scope_and_mints_an_id() {
        let mut st = DashboardStore::default();
        let saved = apply_upsert(&mut st, card("", proj(ME)), ME).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(st.cards.len(), 1);
    }

    #[test]
    fn upsert_into_a_foreign_scope_is_refused_and_writes_nothing() {
        let mut st = DashboardStore::default();
        st.groups.push(group("g1", &["C:/work/api"]));
        assert!(apply_upsert(&mut st, card("a", proj("C:/work/other")), ME).is_err());
        assert!(apply_upsert(&mut st, card("b", Scope::Group { id: "g1".into() }), ME).is_err());
        assert!(st.cards.is_empty());
    }

    #[test]
    fn upsert_cannot_take_over_a_foreign_card_by_reusing_its_id() {
        let mut st = DashboardStore::default();
        st.cards.push(card("victim", proj("C:/work/other")));
        let err = apply_upsert(&mut st, card("victim", proj(ME)), ME).unwrap_err();
        assert!(err.contains("another project"), "{err}");
        assert_eq!(st.cards[0].scope, proj("C:/work/other"));
    }

    #[test]
    fn upsert_edits_its_own_card_in_place() {
        let mut st = DashboardStore::default();
        st.cards.push(card("mine", proj(ME)));
        let mut edited = card("mine", proj(ME));
        edited.title = "renamed".into();
        apply_upsert(&mut st, edited, ME).unwrap();
        assert_eq!(st.cards.len(), 1);
        assert_eq!(st.cards[0].title, "renamed");
    }

    #[test]
    fn delete_follows_the_same_scope_rule() {
        let mut st = DashboardStore::default();
        st.cards.push(card("mine", proj(ME)));
        st.cards.push(card("theirs", proj("C:/work/other")));
        assert!(apply_delete(&mut st, "theirs", ME).is_err());
        assert!(apply_delete(&mut st, "ghost", ME).is_err());
        apply_delete(&mut st, "mine", ME).unwrap();
        assert_eq!(st.cards.len(), 1);
    }

    #[test]
    fn group_cards_resolve_their_run_dir_to_the_first_repo() {
        let groups = [group("g1", &["C:/work/api", "C:/work/app"])];
        assert_eq!(run_cwd(&Scope::Group { id: "g1".into() }, &groups), "C:/work/api");
        assert_eq!(run_cwd(&proj(ME), &groups), ME);
        assert_eq!(run_cwd(&Scope::Group { id: "x".into() }, &groups), "");
    }

    #[test]
    fn views_pair_each_card_with_its_cached_result() {
        let a = card("a", proj(ME));
        let b = card("b", proj(ME));
        let mut results = BTreeMap::new();
        results.insert("a".to_string(), CardResult { fetched_at_ms: 5, ..Default::default() });
        let v = views(vec![&a, &b], &results);
        assert_eq!(v[0].result.as_ref().map(|r| r.fetched_at_ms), Some(5));
        assert!(v[1].result.is_none());
    }

    #[tokio::test]
    async fn the_tool_rejects_an_unknown_session_before_touching_the_store() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        for action in ["list", "upsert", "delete", "test"] {
            let err = dashboard_card_tool(&state, "ghost", action, Some(json!({})), Some("x".into())).await.unwrap_err();
            assert!(err.contains("unknown session"), "{action}: {err}");
        }
    }

    #[tokio::test]
    async fn the_tool_rejects_an_unknown_action_and_a_missing_card() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let sid = uuid::Uuid::new_v4().to_string();
        state.registry.upsert_interactive(&sid, std::path::Path::new(ME), "proj-x", "2026-10-22T00:00:00Z");
        let err = dashboard_card_tool(&state, &sid, "obliterate", None, None).await.unwrap_err();
        assert!(err.contains("unknown action"), "{err}");
        let err = dashboard_card_tool(&state, &sid, "upsert", None, None).await.unwrap_err();
        assert!(err.contains("card is required"), "{err}");
        let err = dashboard_card_tool(&state, &sid, "delete", None, None).await.unwrap_err();
        assert!(err.contains("id is required"), "{err}");
    }
}
