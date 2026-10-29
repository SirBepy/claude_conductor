//! Unit-level tests for the pure portion of the project IPC commands.
//!
//! The `#[tauri::command]` wrappers require the Tauri `State` and `AppHandle`
//! harness, so we test the extracted pure helpers directly. The wrappers are
//! thin glue around these.

use claude_conductor_lib::ipc::projects_test_helpers as h;
use claude_conductor_lib::accounts::{Account, AccountKind};
use claude_conductor_lib::types::{Avatar, ProjectConfig, Settings};

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
        claude_ai_connectors: false,
        tracker: None,
        keep_running_in_gaming_mode: false,
        default_model: None,
        default_effort: None,
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
fn update_project_sets_and_clears_the_default_model_and_effort() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    assert!(h::update_in(&mut s, "a", serde_json::json!({ "default_model": "sonnet", "default_effort": "low" })).is_ok());
    assert_eq!(s.projects[0].default_model.as_deref(), Some("sonnet"));
    assert_eq!(s.projects[0].default_effort.as_deref(), Some("low"));
    // null clears one back to "follow the global default" without touching the other.
    assert!(h::update_in(&mut s, "a", serde_json::json!({ "default_model": null })).is_ok());
    assert_eq!(s.projects[0].default_model, None);
    assert_eq!(s.projects[0].default_effort.as_deref(), Some("low"));
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

fn account(id: &str, kind: AccountKind) -> Account {
    Account {
        id: id.into(),
        label: id.into(),
        colour: "#fff".into(),
        icon: "user".into(),
        config_dir: format!("C:/home/.claude-{id}").into(),
        chrome_profile_dir: format!("C:/appdata/chrome-profiles/{id}").into(),
        email: format!("{id}@example.com"),
        org_uuid: format!("org-{id}"),
        subscription_tier: "claude_max".into(),
        created_at: "2026-07-07T00:00:00Z".into(),
        fleet_eligible: false,
        kind,
    }
}

#[test]
fn update_project_refuses_an_api_credit_binding() {
    let accounts = vec![account("sub", AccountKind::Subscription), account("api", AccountKind::ApiCredit)];
    let err = h::check_binding_patch(&accounts, &serde_json::json!({ "preferred_account_id": "api" }))
        .unwrap_err();
    assert!(err.contains("API-credit"), "{err}");
}

#[test]
fn update_project_allows_a_subscription_binding_and_a_cleared_one() {
    let accounts = vec![account("sub", AccountKind::Subscription), account("api", AccountKind::ApiCredit)];
    assert!(h::check_binding_patch(&accounts, &serde_json::json!({ "preferred_account_id": "sub" })).is_ok());
    assert!(h::check_binding_patch(&accounts, &serde_json::json!({ "preferred_account_id": null })).is_ok());
    assert!(h::check_binding_patch(&accounts, &serde_json::json!({ "name": "X" })).is_ok());
}

#[test]
fn fleet_eligible_is_refused_for_an_api_credit_account() {
    assert!(claude_conductor_lib::accounts::validate_fleet_eligible(&account("api", AccountKind::ApiCredit)).is_err());
    assert!(claude_conductor_lib::accounts::validate_fleet_eligible(&account("sub", AccountKind::Subscription)).is_ok());
}
