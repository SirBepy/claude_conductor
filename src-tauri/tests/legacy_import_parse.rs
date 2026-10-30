use claude_conductor_lib::ipc::legacy_import_test_helpers as h;
use claude_conductor_lib::types::Settings;

#[test]
fn parses_old_config_into_project() {
    let raw = r#"{ "vault_path": "C:/Users/x/Obsidian/Vault", "auto_registered_startup": true }"#;
    let mut s = Settings::default();
    let project = h::import_into(&mut s, raw, "now").unwrap();
    assert_eq!(s.projects.len(), 1);
    assert_eq!(s.projects[0].path, std::path::PathBuf::from("C:/Users/x/Obsidian/Vault"));
    assert_eq!(project.id, s.projects[0].id);
}

#[test]
fn returns_none_when_vault_path_missing() {
    let raw = r#"{ "other": "field" }"#;
    let mut s = Settings::default();
    assert!(h::import_into(&mut s, raw, "now").is_none());
}

#[test]
fn idempotent_when_project_already_imported() {
    let raw = r#"{ "vault_path": "C:/x" }"#;
    let mut s = Settings::default();
    h::import_into(&mut s, raw, "now").unwrap();
    h::import_into(&mut s, raw, "later").unwrap();
    assert_eq!(s.projects.len(), 1);
}
