use claude_conductor_lib::sessions::kinds::InstanceKind;
use claude_conductor_lib::sessions::registry::{Registry, RegisterInput};
use claude_conductor_lib::types::{EndReason, Instance, Settings};
use std::path::PathBuf;
use std::sync::Mutex;

fn reg() -> Registry { Registry::new() }

fn input(session_id: &str, cwd: &str, pid: u32) -> RegisterInput {
    RegisterInput {
        session_id: session_id.into(),
        cwd: PathBuf::from(cwd),
        pid,
        kind: InstanceKind::External,
        is_remote: false,
        transcript_path: None,
        started_at: "2026-04-21T00:00:00Z".into(),
    }
}

#[test]
fn register_inserts_and_assigns_project_id() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    let (id, _) = r.register(input("s1", "C:/a", 100), &settings, "now");
    let got = r.list();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].session_id, "s1");
    assert_eq!(got[0].project_id, id);
    assert_eq!(settings.lock().unwrap().projects.len(), 1);
}

#[test]
fn register_is_idempotent_on_session_id() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    r.register(input("s1", "C:/a", 100), &settings, "now");
    r.register(input("s1", "C:/a", 100), &settings, "now");
    assert_eq!(r.list().len(), 1);
}

#[test]
fn mark_ended_sets_end_reason_idempotently() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    r.register(input("s1", "C:/a", 100), &settings, "now");
    assert!(r.mark_ended("s1", EndReason::HookSessionEnd, "ended-at"));
    let got = &r.list()[0];
    assert_eq!(got.end_reason, Some(EndReason::HookSessionEnd));
    assert_eq!(got.ended_at.as_deref(), Some("ended-at"));
    // Second mark_ended is a no-op (returns false, keeps first reason).
    assert!(!r.mark_ended("s1", EndReason::ProcessGone, "later"));
    let got2 = &r.list()[0];
    assert_eq!(got2.end_reason, Some(EndReason::HookSessionEnd));
}

#[test]
fn prune_removes_ended_past_the_kept_count() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    r.register(input("s1", "C:/a", 100), &settings, "now");
    r.mark_ended("s1", EndReason::Manual, "2026-04-21T00:00:00Z");
    // Retention is by volume, not age: keeping zero ended entries drops it
    // however recently it ended.
    r.prune_ended_keeping_newest(0);
    assert!(r.list().is_empty());
}

#[test]
fn by_project_filters_by_project_id() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    let (proj_a, _) = r.register(input("s1", "C:/a", 100), &settings, "now");
    let (proj_b, _) = r.register(input("s2", "C:/b", 200), &settings, "now");
    let a = r.by_project(&proj_a);
    let b = r.by_project(&proj_b);
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].cwd, PathBuf::from("C:/a"));
    assert_eq!(b[0].cwd, PathBuf::from("C:/b"));
}

// Todo 856: `by_project` used to also require `pid_is_live(i.pid)`, a raw
// single-sample check with no hysteresis, unlike the confirmed-dead signal
// (`end_reason`) it now keys on. These two tests pin both directions so a
// future change to either signal can't silently regress the other.

#[test]
fn by_project_keeps_a_live_peer_with_a_dead_looking_pid() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    // A pid that is almost certainly not a running process on this machine,
    // standing in for a peer whose per-turn child has already exited or a
    // flaky liveness sample - not yet confirmed dead by the registry itself.
    let (proj, _) = r.register(input("s1", "C:/a", 999_999), &settings, "now");
    let peers = r.by_project(&proj);
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].session_id, "s1");
}

#[test]
fn by_project_excludes_a_confirmed_dead_peer() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    let (proj, _) = r.register(input("s1", "C:/a", 100), &settings, "now");
    assert!(r.mark_ended("s1", EndReason::ProcessGone, "2026-09-02T17:16:00Z"));
    assert!(r.by_project(&proj).is_empty());
}
