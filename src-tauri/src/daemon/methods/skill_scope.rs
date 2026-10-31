//! `add_project_to_skill_scope`: the phone's "Enable here" for a skill or
//! plugin scoped to other projects (the desktop does the same through
//! `ipc::enable_skill_here`). The phone is refused `save_settings`, so this is
//! its one narrow write into `Settings.extra["skillScopes"]`.
//!
//! It can only ADD the project of the calling chat to the scope of one key that
//! is already scoped. It cannot remove a project, create or delete a scope,
//! change `elsewhere`, or name a project the caller is not working in: the
//! project comes from the chat's own registered cwd (or, for a draft with no
//! session yet, from a project dir this daemon already knows), never from a
//! project id in the params.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::slash::scope;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_skill_scope(router: &mut Router, state: Arc<DaemonState>) {
    router.register("add_project_to_skill_scope", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                project_dir: String,
                key: String,
                #[serde(default)]
                session_id: Option<String>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            // With a session id the registry's cwd wins over `project_dir`; without
            // one `project_dir` must be a project this daemon already knows.
            let cwd = super::pr_review::resolve_cwd(&state, p.project_dir, p.session_id.as_deref())?;
            let project = scope::project_id(&state.settings.snapshot(), Some(std::path::Path::new(&cwd)))
                .ok_or_else(|| RpcError::invalid_params(format!("not_a_project: {cwd}")))?;
            let added = state.settings.add_skill_scope_project(&p.key, &project);
            if added {
                // The app process owns settings.json: it merges and persists on this event.
                state.notifier.publish("skill_scope_project_added", json!({ "key": p.key, "project": project }));
            }
            Ok(json!({ "ok": true, "added": added }))
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
    // A project under the OS temp dir is refused as ephemeral by the identity
    // layer, so the fixtures live under the cache dir instead.
    use crate::settings::identity::test_support::non_ephemeral_tempdir;

    async fn call(router: &Router, params: Value) -> crate::daemon::rpc::Response {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        router
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "add_project_to_skill_scope".into(), params: Some(params) },
                ConnectionContext::new(tx),
            )
            .await
    }

    /// A state with one registered project at `dir`, one session `s1` in it, and
    /// two scoped keys, neither containing the project yet.
    fn scoped_state(dir: &std::path::Path) -> Arc<DaemonState> {
        let mut s = Settings::default();
        s.hook_port = Some(4242);
        s.extra.insert(
            scope::SETTINGS_KEY.into(),
            json!({
                "figma-tiles": { "projects": ["other"], "elsewhere": "name-only" },
                "figma@claude-plugins-official": { "projects": ["other"] },
            }),
        );
        let state = DaemonState::new(new_session_map(), SettingsCache::new(s));
        state.settings.upsert_project_for_cwd(dir, "2026-10-31T00:00:00Z");
        state.registry.upsert_interactive("s1", dir, "proj", "2026-10-31T00:00:00Z");
        state
    }

    fn scopes_of(state: &DaemonState) -> std::collections::BTreeMap<String, scope::SkillScope> {
        scope::scopes(&state.settings.snapshot())
    }

    #[tokio::test]
    async fn adds_the_chats_project_to_that_one_key_and_changes_nothing_else() {
        let dir = non_ephemeral_tempdir();
        let state = scoped_state(dir.path());
        let project = scope::project_id(&state.settings.snapshot(), Some(dir.path())).unwrap();
        let mut r = Router::new();
        register_skill_scope(&mut r, state.clone());

        let resp = call(&r, json!({ "project_dir": "ignored", "key": "figma-tiles", "session_id": "s1" })).await;

        assert_eq!(resp.result.unwrap(), json!({ "ok": true, "added": true }));
        let scopes = scopes_of(&state);
        assert_eq!(scopes["figma-tiles"].projects, vec!["other".to_string(), project]);
        // The other key and the scope's own `elsewhere` are untouched.
        assert_eq!(scopes["figma-tiles"].elsewhere, scope::Elsewhere::NameOnly);
        assert_eq!(scopes["figma@claude-plugins-official"].projects, vec!["other".to_string()]);
        assert_eq!(state.settings.snapshot().hook_port, Some(4242));
    }

    #[tokio::test]
    async fn never_creates_a_scope_for_an_unscoped_key() {
        let dir = non_ephemeral_tempdir();
        let state = scoped_state(dir.path());
        let mut r = Router::new();
        register_skill_scope(&mut r, state.clone());

        let resp = call(&r, json!({ "project_dir": "ignored", "key": "commit", "session_id": "s1" })).await;

        assert_eq!(resp.result.unwrap(), json!({ "ok": true, "added": false }));
        assert!(!scopes_of(&state).contains_key("commit"), "an unscoped key is already on everywhere");
    }

    #[tokio::test]
    async fn a_second_enable_is_a_no_op() {
        let dir = non_ephemeral_tempdir();
        let state = scoped_state(dir.path());
        let mut r = Router::new();
        register_skill_scope(&mut r, state.clone());
        let params = json!({ "project_dir": "ignored", "key": "figma-tiles", "session_id": "s1" });

        call(&r, params.clone()).await;
        let again = call(&r, params).await;

        assert_eq!(again.result.unwrap(), json!({ "ok": true, "added": false }));
        assert_eq!(scopes_of(&state)["figma-tiles"].projects.len(), 2, "no duplicate project id");
    }

    #[tokio::test]
    async fn a_draft_uses_a_known_project_dir_and_refuses_an_unknown_one() {
        let dir = non_ephemeral_tempdir();
        let state = scoped_state(dir.path());
        let mut r = Router::new();
        register_skill_scope(&mut r, state.clone());

        let unknown = call(&r, json!({ "project_dir": "C:\\nope\\not\\registered", "key": "figma-tiles" })).await;
        assert_eq!(unknown.error.unwrap().code, -32602);
        assert_eq!(scopes_of(&state)["figma-tiles"].projects, vec!["other".to_string()]);

        let known = call(&r, json!({ "project_dir": dir.path().to_string_lossy(), "key": "figma-tiles" })).await;
        assert_eq!(known.result.unwrap(), json!({ "ok": true, "added": true }));
    }

    #[tokio::test]
    async fn an_unknown_session_is_refused() {
        let dir = non_ephemeral_tempdir();
        let state = scoped_state(dir.path());
        let mut r = Router::new();
        register_skill_scope(&mut r, state.clone());

        let resp = call(&r, json!({ "project_dir": dir.path().to_string_lossy(), "key": "figma-tiles", "session_id": "ghost" })).await;

        assert_eq!(resp.error.unwrap().code, -32602);
        assert_eq!(scopes_of(&state)["figma-tiles"].projects, vec!["other".to_string()]);
    }

    #[tokio::test]
    async fn rejects_missing_params() {
        let dir = non_ephemeral_tempdir();
        let mut r = Router::new();
        register_skill_scope(&mut r, scoped_state(dir.path()));
        for bad in [json!({ "key": "figma-tiles" }), json!({ "project_dir": "x" }), Value::Null] {
            assert_eq!(call(&r, bad).await.error.unwrap().code, -32602);
        }
    }
}
