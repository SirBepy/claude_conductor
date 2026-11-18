//! The broker token a chat's `claude` child is launched with.
//!
//! `spawn_session` calls [`mint_for_launch`] on every launch, the per-turn
//! respawn included. The token is a pure function of the daemon's key, the
//! session id, its role and its bound services (`broker::session`), so the
//! respawn hands the chat the same value until its binding changes, and a
//! closed chat's token stays dead (`broker_sessions.revoke` runs when the row
//! ends).
//!
//! The value goes into the child's env and nowhere else: `BrokerToken` has no
//! `Display`, and its `Debug` is redacted, so a `{:?}` in a log line cannot
//! print it. [`apply`] is the only caller of `expose()`, and `spawn.rs` names
//! the token variable exactly twice (binding it, passing it to `apply`).

use crate::daemon::broker::{binding, session};
use crate::daemon::state::DaemonState;
use crate::tickets::TicketTracker;
use std::path::Path;
use std::sync::Arc;

/// Puts the token in the child's env. Called after the account env, so nothing
/// inherited or scrubbed can shadow it.
pub(super) fn apply(cmd: &mut tokio::process::Command, token: &session::BrokerToken) {
    cmd.env(session::ENV_NAME, token.expose());
    // Where a script finds the loopback front: this daemon's own hooks port, which differs per instance.
    cmd.env(session::ENV_URL, loopback_url(crate::daemon::claude_config::daemon_hook_port()));
}

fn loopback_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Issues the token for one launch. `own_tracker` is the tracker `spawn.rs`
/// already worked out for `cwd`; only a sub's parent folder needs another git
/// lookup, so this runs on the blocking pool.
pub(crate) async fn mint_for_launch(
    state: &Arc<DaemonState>,
    session_id: &str,
    sub_parent: Option<&str>,
    cwd: &Path,
    own_tracker: Option<TicketTracker>,
) -> session::BrokerToken {
    let projects = state.settings.snapshot().projects;
    let registry = Arc::clone(&state.registry);
    let sub_is_set = sub_parent.is_some();
    // A sub copies what its main chat was launched with, not what settings say now.
    let parent_set = sub_parent.and_then(|p| state.broker_sessions.current(p)).map(|c| c.services);
    let (sub_parent, own_cwd) = (sub_parent.map(str::to_string), cwd.to_path_buf());
    let scope = tokio::task::spawn_blocking(move || {
        binding::launch_scope(&registry, &projects, sub_parent.as_deref(), parent_set, &own_cwd, |p| {
            if p == own_cwd.as_path() {
                own_tracker.clone()
            } else {
                crate::tickets::effective_tracker(&projects, p).map(|(t, _)| t)
            }
        })
    })
    .await;
    // A lookup that panicked binds nothing: the chat still gets a token, and
    // every service is refused as unbound.
    let (role, services) = scope.unwrap_or_else(|e| {
        log::warn!("[broker] binding lookup for session {session_id} failed, binding nothing: {e}");
        (if sub_is_set { session::Role::Sub } else { session::Role::Chat }, Vec::new())
    });
    state.broker_sessions.mint(session::SessionClaims::new(session_id, role, services))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::tickets::TrackerKind;
    use crate::types::{ProjectConfig, Settings};

    fn project(path: &Path, broker: Option<&[&str]>) -> ProjectConfig {
        let mut p: ProjectConfig = serde_json::from_value(serde_json::json!({
            "id": "p1", "path": path, "name": "p1", "created_at": "2026-11-18T00:00:00Z"
        }))
        .unwrap();
        p.broker_services = broker.map(|b| b.iter().map(|s| s.to_string()).collect());
        p
    }

    fn state_with(projects: Vec<ProjectConfig>) -> Arc<DaemonState> {
        let mut settings = Settings::default();
        settings.projects = projects;
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    fn shortcut() -> Option<TicketTracker> {
        Some(TicketTracker { kind: TrackerKind::Shortcut, workspace: "ws".into() })
    }

    fn claims_of(state: &DaemonState, token: &session::BrokerToken) -> session::SessionClaims {
        state.broker_sessions.verify(token.expose()).expect("a freshly minted token verifies")
    }

    fn names(c: &session::SessionClaims) -> Vec<&'static str> {
        c.services.iter().map(|s| s.name()).collect()
    }

    #[tokio::test]
    async fn a_chat_with_no_stored_field_gets_its_tracker_and_figma() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(vec![project(dir.path(), None)]);
        let t = mint_for_launch(&state, "chat-1", None, dir.path(), shortcut()).await;
        let c = claims_of(&state, &t);
        assert_eq!((c.role, names(&c)), (session::Role::Chat, vec!["figma", "shortcut"]));
    }

    #[tokio::test]
    async fn the_per_turn_respawn_gets_the_same_token_and_a_changed_binding_a_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(vec![project(dir.path(), None)]);
        let first = mint_for_launch(&state, "chat-1", None, dir.path(), shortcut()).await;
        let second = mint_for_launch(&state, "chat-1", None, dir.path(), shortcut()).await;
        assert_eq!(first.expose(), second.expose(), "stable across the respawn");

        let mut s = Settings::default();
        s.projects = vec![project(dir.path(), Some(&["linear"]))];
        state.settings.replace(s);
        let third = mint_for_launch(&state, "chat-1", None, dir.path(), shortcut()).await;
        assert_ne!(first.expose(), third.expose());
        assert_eq!(names(&claims_of(&state, &third)), ["linear"]);
    }

    #[tokio::test]
    async fn a_hidden_sub_gets_its_parents_set_even_from_a_folder_outside_every_project() {
        let main_dir = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let state = state_with(vec![project(main_dir.path(), Some(&["clockify", "trello"]))]);
        state.registry.upsert_interactive("main", main_dir.path(), "p1", "2026-11-18T00:00:00Z");
        state.registry.upsert_interactive("sub", tree.path(), "p1", "2026-11-18T00:00:00Z");
        state.registry.set_subchat_of("sub", Some("main".into()));

        // The sub's first spawn names its parent explicitly; a relaunch reads the row.
        for explicit in [Some("main"), None] {
            let parent = crate::daemon::subchats::launch_parent(&state, "sub", explicit);
            let t = mint_for_launch(&state, "sub", parent.as_deref(), tree.path(), None).await;
            let c = claims_of(&state, &t);
            assert_eq!((c.role, names(&c)), (session::Role::Sub, vec!["clockify", "trello"]), "explicit parent {explicit:?}");
        }
    }

    #[tokio::test]
    async fn a_sub_copies_what_its_main_chat_was_launched_with_not_what_settings_say_now() {
        let dir = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let state = state_with(vec![project(dir.path(), Some(&["figma"]))]);
        state.registry.upsert_interactive("main", dir.path(), "p1", "2026-11-18T00:00:00Z");
        state.registry.upsert_interactive("sub", tree.path(), "p1", "2026-11-18T00:00:00Z");
        state.registry.set_subchat_of("sub", Some("main".into()));
        mint_for_launch(&state, "main", None, dir.path(), None).await;

        // Joe widens the project after the main chat launched.
        let mut s = Settings::default();
        s.projects = vec![project(dir.path(), Some(&["figma", "linear", "shortcut"]))];
        state.settings.replace(s);

        let t = mint_for_launch(&state, "sub", Some("main"), tree.path(), None).await;
        let c = claims_of(&state, &t);
        assert_eq!((c.role, names(&c)), (session::Role::Sub, vec!["figma"]), "a sub never holds more than its main chat does");
    }

    #[tokio::test]
    async fn an_autopilot_chat_gets_the_projects_set() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(vec![project(dir.path(), Some(&["hubstaff", "figma"]))]);
        state.registry.upsert_interactive("auto", dir.path(), "p1", "2026-11-18T00:00:00Z");
        state.registry.set_autopilot("auto", true);
        let t = mint_for_launch(&state, "auto", None, dir.path(), None).await;
        let c = claims_of(&state, &t);
        assert_eq!((c.role, names(&c)), (session::Role::Chat, vec!["figma", "hubstaff"]));
    }

    #[tokio::test]
    async fn closing_the_chat_revokes_its_token_and_a_resume_mints_a_live_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(vec![project(dir.path(), None)]);
        state.registry.upsert_interactive("chat-1", dir.path(), "p1", "2026-11-18T00:00:00Z");
        let t = mint_for_launch(&state, "chat-1", None, dir.path(), None).await;
        let other = mint_for_launch(&state, "chat-2", None, dir.path(), None).await;
        assert!(state.broker_sessions.verify(t.expose()).is_ok());

        state.registry.mark_ended("chat-1", crate::types::EndReason::Manual, "2026-11-18T00:01:00Z");
        assert!(state.broker_sessions.verify(t.expose()).is_err(), "closed chat's token is dead");
        assert!(state.broker_sessions.verify(other.expose()).is_ok(), "another chat is untouched");

        let resumed = mint_for_launch(&state, "chat-1", None, dir.path(), None).await;
        assert!(state.broker_sessions.verify(resumed.expose()).is_ok());
        assert!(state.broker_sessions.verify(t.expose()).is_err(), "the old copy stays dead");
    }

    #[test]
    fn apply_puts_the_token_in_the_childs_env_under_the_documented_name() {
        let state = state_with(vec![]);
        let token = state.broker_sessions.mint(session::SessionClaims::new("chat-1", session::Role::Chat, vec![]));
        let mut cmd = tokio::process::Command::new("claude");
        cmd.env(session::ENV_NAME, "stale-inherited-value");
        apply(&mut cmd, &token);
        let carried = cmd.as_std().get_envs().find(|(k, _)| *k == session::ENV_NAME).and_then(|(_, v)| v).map(|v| v.to_string_lossy().into_owned());
        assert_eq!(carried.as_deref(), Some(token.expose()), "the minted value replaces whatever was set before");
        // The address of the loopback front rides next to it, and holds no credential.
        let url = cmd.as_std().get_envs().find(|(k, _)| *k == session::ENV_URL).and_then(|(_, v)| v).map(|v| v.to_string_lossy().into_owned()).unwrap();
        assert!(url.starts_with("http://127.0.0.1:") && url[17..].parse::<u16>().is_ok(), "{url}");
        assert!(!url.contains(token.expose()));
        assert_eq!(loopback_url(27182), "http://127.0.0.1:27182");
    }

    // The spawn path must hand the token to the child env and never to a log.
    #[test]
    fn spawn_passes_the_token_to_apply_and_nothing_else_names_it() {
        let spawn = include_str!("spawn.rs").replace("\r\n", "\n");
        // Any use in a log macro, a format string or a second call would add an occurrence.
        assert_eq!(spawn.matches("broker_token").count(), 2, "spawn.rs binds the token and passes it to apply, nothing more");
        assert!(spawn.contains("super::broker_env::apply(&mut cmd, &broker_token);"));
        assert!(!spawn.contains(".expose()") && !spawn.contains("ENV_NAME"), "spawn.rs never reads the value itself");
        // `Command`'s Debug prints its env, so formatting the command would print the token.
        for (n, line) in spawn.lines().enumerate().filter(|(_, l)| l.contains("cmd")) {
            assert!(!line.contains("{:") && !line.contains("?}") && !line.contains("dbg!") && !line.contains("format!"), "spawn.rs:{} formats the command: {line}", n + 1);
        }
        let this = include_str!("broker_env.rs").replace("\r\n", "\n");
        let code = this.split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches(".expose()").count(), 1, "apply is the one reader");
        assert!(!code.contains("println!"), "this module prints nothing");
        for (n, line) in code.lines().enumerate().filter(|(_, l)| l.contains("log::")) {
            assert!(!line.contains("token") && !line.contains("expose"), "broker_env.rs:{} logs the token: {line}", n + 1);
        }
    }
}
