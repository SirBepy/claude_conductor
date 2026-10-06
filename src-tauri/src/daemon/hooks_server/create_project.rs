//! `/projects/create`: HTTP half of the `create_project` MCP tool. The project
//! picker lists only projects registered in `settings.projects` (plus token
//! history and live sessions), never a disk scan, so this is how a folder
//! Claude made from a shell gets into it. Outcome rides in the body at
//! `200 OK`, same as `spawn_chat.rs`.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::state::DaemonState;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct CreateProjectBody {
    session_id: String,
    path: String,
}

pub(super) async fn on_create_project(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<CreateProjectBody>,
) -> impl IntoResponse {
    if !body.session_id.is_empty() {
        super::mark_mcp_tool_used(&ctx, &body.session_id);
    }
    (StatusCode::OK, Json(create_project(&ctx.state, &body.path).await))
}

fn failure(error: impl Into<String>) -> Value {
    json!({"ok": false, "error": error.into()})
}

async fn create_project(state: &DaemonState, raw_path: &str) -> Value {
    let path = PathBuf::from(raw_path.trim());
    if !path.is_absolute() {
        return failure("path must be absolute");
    }
    // Checked before touching disk: `upsert_project_for_cwd` silently declines
    // these, which would otherwise leave a stray folder and a success-shaped reply.
    if crate::settings::identity::is_ephemeral_root_path(&path) {
        return failure("temp-dir paths are never registered as projects");
    }

    let target = path.clone();
    let created = match tokio::task::spawn_blocking(move || -> std::io::Result<bool> {
        if target.is_dir() {
            return Ok(false);
        }
        std::fs::create_dir_all(&target).map(|_| true)
    })
    .await
    {
        Ok(Ok(created)) => created,
        Ok(Err(e)) => return failure(format!("could not create {}: {e}", path.display())),
        Err(e) => return failure(format!("join: {e}")),
    };

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (project_id, registered_new) =
        crate::daemon::session_registration::register_project(state, &path, &now);
    json!({
        "ok": true,
        "project_id": project_id,
        "path": path.to_string_lossy(),
        "folder_created": created,
        "already_registered": !registered_new,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::settings::identity::test_support::non_ephemeral_tempdir;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn is_registered(state: &DaemonState, path: &std::path::Path) -> bool {
        let key = crate::settings::identity::project_key(path);
        state
            .settings
            .snapshot()
            .projects
            .iter()
            .any(|p| crate::settings::identity::project_key(&p.path) == key)
    }

    #[tokio::test]
    async fn creates_a_missing_folder_and_registers_it() {
        let dir = non_ephemeral_tempdir();
        let target = dir.path().join("fresh-app");
        let s = state();

        let resp = create_project(&s, &target.to_string_lossy()).await;

        assert_eq!(resp["ok"], json!(true), "got {resp}");
        assert_eq!(resp["folder_created"], json!(true));
        assert!(target.is_dir());
        assert!(is_registered(&s, &target));
    }

    /// The case that motivated the tool: a folder Claude already made from a
    /// shell, which no chat has run in yet.
    #[tokio::test]
    async fn registers_an_existing_folder_without_recreating_it() {
        let dir = non_ephemeral_tempdir();
        let target = dir.path().join("made-by-shell");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.txt"), "x").unwrap();
        let s = state();

        let resp = create_project(&s, &target.to_string_lossy()).await;

        assert_eq!(resp["ok"], json!(true), "got {resp}");
        assert_eq!(resp["folder_created"], json!(false));
        assert!(target.join("keep.txt").exists());
        assert!(is_registered(&s, &target));
    }

    #[tokio::test]
    async fn a_second_call_reports_already_registered() {
        let dir = non_ephemeral_tempdir();
        let target = dir.path().join("twice");
        let s = state();

        let first = create_project(&s, &target.to_string_lossy()).await;
        let second = create_project(&s, &target.to_string_lossy()).await;

        assert_eq!(first["already_registered"], json!(false));
        assert_eq!(second["already_registered"], json!(true));
        assert_eq!(first["project_id"], second["project_id"]);
    }

    #[tokio::test]
    async fn rejects_a_relative_path() {
        let resp = create_project(&state(), "relative/thing").await;
        assert_eq!(resp["ok"], json!(false));
    }

    #[tokio::test]
    async fn rejects_a_temp_dir_path_without_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("scratch");
        let s = state();

        let resp = create_project(&s, &target.to_string_lossy()).await;

        assert_eq!(resp["ok"], json!(false), "got {resp}");
        assert!(!target.exists());
        assert!(s.settings.snapshot().projects.is_empty());
    }
}
