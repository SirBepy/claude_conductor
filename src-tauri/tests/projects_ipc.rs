//! Unit-level tests for the pure portion of the project IPC commands.
//!
//! The `#[tauri::command]` wrappers require the Tauri `State` and `AppHandle`
//! harness, so we test the extracted pure helpers directly. The wrappers are
//! thin glue around these.

use claude_conductor_lib::ipc::projects_test_helpers as h;
use claude_conductor_lib::types::{Avatar, ProjectConfig, ProjectsSortBy, Settings};

fn sample_project(id: &str, path: &str) -> ProjectConfig {
    ProjectConfig {
        id: id.into(),
        path: path.into(),
        name: id.into(),
        avatar: Avatar::None,
        whitelist: Default::default(),
        automation: None,
        created_at: "2026-04-21T00:00:00Z".into(),
        last_active_at: None,
        preferred_account_id: None,
        last_worktree_path: None,
        last_start_folder_rel: None,
    }
}

#[test]
fn list_projects_returns_empty_on_defaults() {
    let s = Settings::default();
    assert!(h::list_from(&s).is_empty());
}

#[test]
fn get_project_finds_by_id() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    s.projects.push(sample_project("b", "C:/b"));
    let got = h::get_from(&s, "b").unwrap();
    assert_eq!(got.path, std::path::PathBuf::from("C:/b"));
    assert!(h::get_from(&s, "missing").is_none());
}

#[test]
fn update_project_applies_patch_in_place() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    let patch = serde_json::json!({ "name": "Alpha", "avatar": {"kind":"emoji","value":"🅰"} });
    let res = h::update_in(&mut s, "a", patch);
    assert!(res.is_ok());
    assert_eq!(s.projects[0].name, "Alpha");
    assert_eq!(s.projects[0].avatar, Avatar::Emoji("🅰".into()));
}

#[test]
fn update_project_returns_not_found_for_missing_id() {
    let mut s = Settings::default();
    let res = h::update_in(&mut s, "missing", serde_json::json!({ "name": "X" }));
    assert!(matches!(res, Err(h::UpdateErr::NotFound)));
}

#[test]
fn update_project_returns_invalid_patch_for_bad_type() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    let res = h::update_in(&mut s, "a", serde_json::json!({ "avatar": "not-an-object" }));
    assert!(matches!(res, Err(h::UpdateErr::InvalidPatch(_))));
}

#[test]
fn delete_project_removes_entry() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    s.projects.push(sample_project("b", "C:/b"));
    let ok = h::delete_in(&mut s, "a");
    assert!(ok);
    assert_eq!(s.projects.len(), 1);
    assert_eq!(s.projects[0].id, "b");
}

#[test]
fn set_projects_sort_by_updates_field() {
    let mut s = Settings::default();
    h::set_sort_by(&mut s, ProjectsSortBy::Name);
    assert_eq!(s.projects_sort_by, ProjectsSortBy::Name);
    h::set_sort_by(&mut s, ProjectsSortBy::Tokens);
    assert_eq!(s.projects_sort_by, ProjectsSortBy::Tokens);
    h::set_sort_by(&mut s, ProjectsSortBy::Live);
    assert_eq!(s.projects_sort_by, ProjectsSortBy::Live);
    h::set_sort_by(&mut s, ProjectsSortBy::Recent);
    assert_eq!(s.projects_sort_by, ProjectsSortBy::Recent);
}
