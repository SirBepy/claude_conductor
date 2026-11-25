use super::*;

fn temp_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-switch-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(FILE_NAME)
}

#[test]
fn an_account_with_no_answer_is_off() {
    let s = Switches::default();
    assert!(!s.is_on("kimi"));
}

#[test]
fn an_answer_survives_a_restart() {
    let path = temp_path("restart");
    let mut s = Switches::default();
    s.load_from(path.clone());
    s.set("kimi", true).unwrap();
    s.set("other", false).unwrap();

    let mut again = Switches::default();
    again.load_from(path);
    assert!(again.is_on("kimi"), "consent given before a restart still holds after it");
    assert!(!again.is_on("other"));
    assert_eq!(again.snapshot().len(), 2);
}

#[test]
fn an_unreadable_file_reads_as_all_off_and_is_set_aside() {
    let path = temp_path("bad");
    std::fs::write(&path, "{ not json").unwrap();
    let mut s = Switches::default();
    s.load_from(path.clone());
    assert!(!s.is_on("kimi"), "garbage is never read as consent");
    assert!(path.with_extension("json.bad").exists(), "the broken file is kept, not deleted");
    s.set("kimi", true).unwrap();
    assert!(path.exists(), "a fresh file is written over the set-aside one");
}

#[test]
fn a_failed_save_takes_an_on_back_but_leaves_an_off_off() {
    let mut s = Switches::default();
    // The parent folder does not exist, so the temp file cannot be written.
    let dir = std::env::temp_dir().join(format!("cc-switch-test-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    s.load_from(dir.join("nope").join(FILE_NAME));

    assert!(s.set("kimi", true).is_err());
    assert!(!s.is_on("kimi"), "the page shows off after the error, so the daemon must not call");

    s.map.insert("kimi".to_string(), true);
    assert!(s.set("kimi", false).is_err());
    assert!(!s.is_on("kimi"), "a failed save never keeps a call going");

    s.map.insert("kimi".to_string(), false);
    assert!(s.set("kimi", true).is_err());
    assert!(!s.is_on("kimi"), "a failed turn-on goes back to the earlier off");
}

#[test]
fn a_memory_only_switch_still_answers() {
    let mut s = Switches::default();
    s.set("kimi", true).unwrap();
    assert!(s.is_on("kimi"));
}
