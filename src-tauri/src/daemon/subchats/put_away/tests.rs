use super::visiting::{visiting_leave_in, visiting_pause_in};
use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::TempDataDir;
use crate::types::{ProjectConfig, Settings};
use std::sync::Arc;
use tempfile::TempDir;

fn project(id: &str) -> ProjectConfig {
    let mut s = Settings::default();
    let (pid, _) = crate::settings::upsert_project_for_cwd(&mut s, Path::new(env!("CARGO_MANIFEST_DIR")), "2026-11-12T00:00:00Z");
    let mut p = s.projects.into_iter().find(|p| p.id == pid).unwrap();
    p.id = id.to_string();
    p.main_chat_id = None;
    p
}

fn state() -> Arc<DaemonState> {
    let mut s = Settings::default();
    s.projects = vec![project("pa")];
    DaemonState::new(new_session_map(), SettingsCache::new(s))
}

/// A daemon that came up with `cwd` holding the snapshot of `from` (a restart).
fn restarted(from: &DaemonState, cwd: &Path) -> Arc<DaemonState> {
    let snap = cwd.join("snap.json");
    crate::sessions::persistence::save_snapshot(&from.registry, &snap);
    let st = state();
    crate::sessions::persistence::populate_registry(&st.registry, crate::sessions::persistence::load_snapshot(&snap));
    st
}

fn sub(id: &str, prior: Prior) -> PausedSub {
    PausedSub { sub_id: id.into(), name: Some(format!("name-{id}")), prior, needs_continue: prior == Prior::Working, paused_at: Some("2026-11-21T10:00:00Z".into()), machine_id: None }
}

#[test]
fn putting_a_main_chat_away_writes_the_record_then_flags_the_row_and_tells_the_clients() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    let mut rx = st.notifier.subscribe();
    assert!(!is_hidden_family("m1"));

    put_away(&st, "m1", vec![sub("s1", Prior::Working), sub("s2", Prior::Finished)], "2026-11-21T10:00:00Z").unwrap();

    assert!(is_hidden_family("m1"), "the gate reads the record");
    assert_eq!(st.registry.get("m1").unwrap().hidden_at.as_deref(), Some("2026-11-21T10:00:00Z"));
    assert_eq!(paused_subs("m1"), vec![sub("s1", Prior::Working), sub("s2", Prior::Finished)]);
    let frame = rx.try_recv().expect("the sidebar is told the row changed");
    assert_eq!(frame["method"], "instances_changed");
    assert!(!is_hidden_family("another-main"), "one family's record is not another's");
}

#[test]
fn a_second_pause_keeps_the_first_prior_states_and_the_first_time() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    put_away(&st, "m1", vec![sub("s1", Prior::Working)], "2026-11-21T10:00:00Z").unwrap();
    // The sub was already frozen, so the second pass sees it idle: its first state stays.
    put_away(&st, "m1", vec![sub("s1", Prior::Idle), sub("s3", Prior::Held)], "2026-11-21T11:00:00Z").unwrap();

    let record = read("m1").unwrap();
    assert_eq!(record.hidden_at.as_deref(), Some("2026-11-21T10:00:00Z"));
    assert_eq!(record.subs, vec![sub("s1", Prior::Working), sub("s3", Prior::Held)]);
}

#[test]
fn a_hidden_chat_survives_a_daemon_restart_and_its_record_still_gates_the_family() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    st.registry.upsert_interactive("plain", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    put_away(&st, "m1", vec![sub("s1", Prior::Working)], "2026-11-21T10:00:00Z").unwrap();

    let after = restarted(&st, cwd.path());

    let row = after.registry.get("m1").expect("a put-away chat is an open row, so the snapshot keeps it");
    assert_eq!(row.hidden_at.as_deref(), Some("2026-11-21T10:00:00Z"));
    assert!(row.ended_at.is_none());
    assert_eq!(after.registry.get("plain").unwrap().hidden_at, None);
    assert!(is_hidden_family("m1"));
    assert_eq!(paused_subs("m1"), vec![sub("s1", Prior::Working)]);
}

#[test]
fn reopening_opens_the_gate_and_keeps_the_paused_subs_until_cleared() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    put_away(&st, "m1", vec![sub("s1", Prior::Working)], "2026-11-21T10:00:00Z").unwrap();

    let paused = reopen(&st, "m1").unwrap();

    assert_eq!(paused, vec![sub("s1", Prior::Working)]);
    assert!(!is_hidden_family("m1"), "the user's message must be able to start the family");
    assert_eq!(st.registry.get("m1").unwrap().hidden_at, None);
    assert_eq!(paused_subs("m1"), vec![sub("s1", Prior::Working)], "the resume answer comes later");
    clear("m1").unwrap();
    assert!(read("m1").is_none());
    clear("m1").unwrap();
}

#[test]
fn clearing_a_family_that_is_still_put_away_does_nothing() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    put_away(&st, "m1", vec![sub("s1", Prior::Idle)], "2026-11-21T10:00:00Z").unwrap();
    clear("m1").unwrap();
    assert!(is_hidden_family("m1"));
    assert_eq!(paused_subs("m1").len(), 1);
}

#[test]
fn a_damaged_record_reads_as_hidden_and_is_kept_aside() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    std::fs::write(path_in(&root, "m1"), "{ nope").unwrap();

    assert!(is_hidden_family("m1"), "a wrongly open gate would start a paused sub");
    assert!(root.join("subchats").join("m1.hidden.json.bad").exists());
}

#[test]
fn a_record_with_one_sub_that_will_not_decode_keeps_the_rest() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    std::fs::write(
        path_in(&root, "m1"),
        r#"{"hidden_at":"2026-11-21T10:00:00Z","future_field":1,"subs":[{"sub_id":"s1","prior":"working","needs_continue":true},{"sub_id":7},{"sub_id":"s2","prior":"from_a_newer_build"},{"sub_id":"s3"}]}"#,
    )
    .unwrap();

    let record = read("m1").unwrap();
    assert_eq!(record.hidden_at.as_deref(), Some("2026-11-21T10:00:00Z"));
    let ids: Vec<&str> = record.subs.iter().map(|s| s.sub_id.as_str()).collect();
    assert_eq!(ids, ["s1", "s2", "s3"]);
    assert_eq!(record.subs[1].prior, Prior::Unknown);
    assert_eq!(record.subs[2].prior, Prior::Idle);
}

#[test]
fn restore_repairs_a_crash_between_the_record_and_the_row_flag() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("rec-only", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    st.registry.upsert_interactive("flag-only", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    st.registry.upsert_interactive("reopened", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    // Crash after the record: hidden record, unflagged row.
    write_in(&root, "rec-only", &Record { hidden_at: Some("2026-11-21T10:00:00Z".into()), subs: vec![sub("s1", Prior::Idle)] }).unwrap();
    // A flag with no record: a put-away writes the record first, so this is a reopen that was
    // cleared before the snapshot caught up.
    st.registry.set_hidden_at("flag-only", Some("2026-11-21T10:30:00Z".into()));
    // Crash inside a reopen: the open record was written, the row still carries the flag.
    write_in(&root, "reopened", &Record { hidden_at: None, subs: vec![sub("s2", Prior::Working)] }).unwrap();
    st.registry.set_hidden_at("reopened", Some("2026-11-21T10:45:00Z".into()));

    assert!(restore(&st));

    assert_eq!(st.registry.get("rec-only").unwrap().hidden_at.as_deref(), Some("2026-11-21T10:00:00Z"));
    assert_eq!(st.registry.get("flag-only").unwrap().hidden_at, None, "a cleared reopen is not hidden again by a stale snapshot");
    assert!(!is_hidden_family("flag-only"));
    assert_eq!(st.registry.get("reopened").unwrap().hidden_at, None);
    assert!(!is_hidden_family("reopened"));
    assert!(!restore(&st), "a second pass changes nothing");
}

#[test]
fn a_damaged_record_never_puts_its_sentinel_text_into_an_unflagged_row() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    std::fs::write(path_in(&root, "m1"), "{ nope").unwrap();

    assert!(!restore(&st));

    assert_eq!(st.registry.get("m1").unwrap().hidden_at, None);
    assert!(is_hidden_family("m1"), "the gate still holds");
}

#[test]
fn a_hidden_at_of_the_wrong_type_reads_as_hidden() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    std::fs::write(path_in(&root, "m1"), r#"{"hidden_at":5,"subs":[]}"#).unwrap();
    assert!(is_hidden_family("m1"));
    assert!(root.join("subchats").join("m1.hidden.json.bad").exists());
}

#[test]
fn a_subs_value_of_the_wrong_type_is_kept_aside_not_dropped_silently() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    std::fs::write(path_in(&root, "m1"), r#"{"hidden_at":"2026-11-21T10:00:00Z","subs":{}}"#).unwrap();
    assert!(is_hidden_family("m1"));
    assert!(paused_subs("m1").is_empty());
    assert!(root.join("subchats").join("m1.hidden.json.bad").exists());
}

#[test]
fn a_pause_after_a_reopen_starts_a_new_list_and_drops_subs_that_are_gone() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    put_away(&st, "m1", vec![sub("s1", Prior::Working)], "2026-11-21T10:00:00Z").unwrap();
    reopen(&st, "m1").unwrap();
    // s1 finished and was never resumed or cleared; only s2 is frozen by the next pause.
    put_away(&st, "m1", vec![sub("s2", Prior::Idle)], "2026-11-21T12:00:00Z").unwrap();
    assert_eq!(paused_subs("m1"), vec![sub("s2", Prior::Idle)]);
}

#[test]
fn a_pause_after_a_reopen_replaces_the_stale_prior_states() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    put_away(&st, "m1", vec![sub("s1", Prior::Idle)], "2026-11-21T10:00:00Z").unwrap();
    reopen(&st, "m1").unwrap();
    // The resume ran, the record was never cleared, and s1 is working when the next pause comes.
    put_away(&st, "m1", vec![sub("s1", Prior::Working)], "2026-11-21T12:00:00Z").unwrap();
    assert_eq!(paused_subs("m1"), vec![sub("s1", Prior::Working)]);
    assert_eq!(read("m1").unwrap().hidden_at.as_deref(), Some("2026-11-21T12:00:00Z"));
}

#[test]
fn only_an_open_main_chat_can_be_put_away() {
    let _data = TempDataDir::new();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    st.registry.upsert_interactive("s1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    st.registry.set_subchat_of("s1", Some("m1".into()));
    assert!(put_away(&st, "nobody", Vec::new(), "2026-11-21T10:00:00Z").is_err());
    assert!(put_away(&st, "s1", Vec::new(), "2026-11-21T10:00:00Z").is_err());
    assert!(!is_hidden_family("nobody") && !is_hidden_family("s1"), "no orphan record holds a gate");
}

#[test]
fn restore_leaves_a_chat_flagged_when_its_record_is_damaged() {
    let _data = TempDataDir::new();
    let root = data_root().unwrap();
    let cwd = TempDir::new().unwrap();
    let st = state();
    st.registry.upsert_interactive("m1", cwd.path(), "pa", "2026-11-21T09:00:00Z");
    st.registry.set_hidden_at("m1", Some("2026-11-21T10:00:00Z".into()));
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    std::fs::write(path_in(&root, "m1"), "{ nope").unwrap();

    restore(&st);

    assert_eq!(st.registry.get("m1").unwrap().hidden_at.as_deref(), Some("2026-11-21T10:00:00Z"));
}

#[test]
fn with_no_data_folder_nothing_is_hidden_and_a_put_away_says_why_it_failed() {
    // No CC_DATA_DIR in a unit test: `data_root` is None, so no test of another
    // area ever reads or writes the developer's real app data.
    let _lock = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var("CC_DATA_DIR");
    let st = state();
    assert!(!is_hidden_family("m1"));
    assert!(put_away(&st, "m1", Vec::new(), "2026-11-21T10:00:00Z").is_err());
    assert!(!restore(&st));
}

// ---- the host's record of paused visiting subs (pc-1806 step 4) ----------------------------

fn visitor(id: &str) -> PausedSub {
    PausedSub { machine_id: None, ..sub(id, Prior::Working) }
}

#[test]
fn a_visiting_pause_closes_the_gate_for_the_homes_main_chat_id_and_no_other() {
    let root = TempDir::new().unwrap();
    assert!(!is_hidden_in(root.path(), "home-main"));
    visiting_pause_in(root.path(), "home-main", visitor("v1"), "2026-11-21T10:00:00Z").unwrap();
    assert!(is_hidden_in(root.path(), "home-main"), "every door asks the home's main id");
    assert!(!is_hidden_in(root.path(), "another-main"));
    assert!(!path_in(root.path(), "home-main").exists(), "the home's own record is not written for a chat this machine does not have");
}

#[test]
fn a_resume_opens_the_gate_and_the_other_paused_visitors_stay_listed() {
    let root = TempDir::new().unwrap();
    visiting_pause_in(root.path(), "hm", visitor("v1"), "t1").unwrap();
    visiting_pause_in(root.path(), "hm", visitor("v2"), "t1").unwrap();

    visiting_leave_in(root.path(), "hm", "v1", true).unwrap();

    assert!(!is_hidden_in(root.path(), "hm"), "the home reopened: nothing of the family is gated");
    let left = read_path(&visiting_path_in(root.path(), "hm")).unwrap().unwrap();
    assert_eq!(left.subs.iter().map(|s| s.sub_id.as_str()).collect::<Vec<_>>(), ["v2"], "v2 is still frozen and waits for its own resume");

    visiting_leave_in(root.path(), "hm", "v2", true).unwrap();
    assert!(!visiting_path_in(root.path(), "hm").exists(), "the file goes with the last sub");
}

#[test]
fn a_sub_that_ends_leaves_the_list_but_never_opens_the_gate_for_the_others() {
    let root = TempDir::new().unwrap();
    visiting_pause_in(root.path(), "hm", visitor("v1"), "t1").unwrap();
    visiting_pause_in(root.path(), "hm", visitor("v2"), "t1").unwrap();

    visiting_leave_in(root.path(), "hm", "v1", false).unwrap();
    assert!(is_hidden_in(root.path(), "hm"), "v2 is still paused");

    visiting_leave_in(root.path(), "hm", "v2", false).unwrap();
    assert!(!is_hidden_in(root.path(), "hm"), "nothing is left to gate");
    assert!(!visiting_path_in(root.path(), "hm").exists());
}

#[test]
fn a_second_visiting_pause_of_the_same_sub_keeps_the_first_state_and_a_pause_after_a_resume_closes_the_gate_again() {
    let root = TempDir::new().unwrap();
    visiting_pause_in(root.path(), "hm", visitor("v1"), "t1").unwrap();
    visiting_pause_in(root.path(), "hm", sub("v1", Prior::Idle), "t2").unwrap();
    let rec = read_path(&visiting_path_in(root.path(), "hm")).unwrap().unwrap();
    assert_eq!((rec.hidden_at.as_deref(), rec.subs.len(), rec.subs[0].prior), (Some("t1"), 1, Prior::Working));

    visiting_pause_in(root.path(), "hm", visitor("v2"), "t3").unwrap();
    visiting_leave_in(root.path(), "hm", "v1", true).unwrap();
    assert!(!is_hidden_in(root.path(), "hm"));
    visiting_pause_in(root.path(), "hm", visitor("v1"), "t4").unwrap();
    assert!(is_hidden_in(root.path(), "hm"), "paused again");
}

#[test]
fn a_damaged_visiting_record_keeps_the_gate_shut_and_only_a_resume_opens_it() {
    let root = TempDir::new().unwrap();
    let path = visiting_path_in(root.path(), "hm");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ not json").unwrap();
    assert!(is_hidden_in(root.path(), "hm"), "fail closed");
    visiting_leave_in(root.path(), "hm", "v1", false).unwrap();
    assert!(is_hidden_in(root.path(), "hm"), "an ending sub cannot lift a gate the file cannot explain");
    visiting_leave_in(root.path(), "hm", "v1", true).unwrap();
    assert!(!is_hidden_in(root.path(), "hm"), "the home's resume does");
}
