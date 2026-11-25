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
fn a_memory_only_switch_still_answers() {
    let mut s = Switches::default();
    s.set("kimi", true).unwrap();
    assert!(s.is_on("kimi"));
}
