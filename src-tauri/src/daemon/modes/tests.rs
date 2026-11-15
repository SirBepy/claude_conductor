use super::*;
use chrono::Duration as Span;
use std::sync::Mutex;

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-15T22:00:00Z").unwrap().with_timezone(&Utc)
}

fn req(mode: &str, flags: &[&str], until: Option<DateTime<Utc>>) -> ModeRequest {
    ModeRequest {
        mode: Some(mode.to_string()),
        flags: flags.iter().map(|f| f.to_string()).collect(),
        until: until.map(|u| u.to_rfc3339()),
        set_by: None,
    }
}

/// Records every park and resume instead of touching gaming mode.
#[derive(Default)]
struct Recorder(Mutex<Vec<bool>>);

impl Recorder {
    fn calls(&self) -> Vec<bool> {
        self.0.lock().unwrap().clone()
    }
}

impl PauseEffects for Recorder {
    fn set_paused(&self, on: bool) -> GamingModeSummary {
        self.0.lock().unwrap().push(on);
        GamingModeSummary { on, ..Default::default() }
    }
}

/// Points the state file at a scratch dir for the closure.
fn in_scratch_dir(f: impl FnOnce()) {
    let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("CC_DATA_DIR", tmp.path());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    std::env::remove_var("CC_DATA_DIR");
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

#[test]
fn clearing_needs_no_name_and_ignores_the_rest() {
    let n = normalize(&ModeRequest { flags: vec![PAUSE_CHATS.into()], ..Default::default() }, now()).unwrap();
    assert_eq!(n.state, ModeState::default());
}

#[test]
fn a_name_is_lowercased_and_a_bad_one_is_refused_with_the_reason() {
    assert_eq!(normalize(&req("  Sleep ", &[], None), now()).unwrap().state.mode.as_deref(), Some("sleep"));
    for bad in ["", "   ", "two words", "a/b", &"x".repeat(41)] {
        let err = normalize(&req(bad, &[], None), now()).unwrap_err();
        assert!(err.starts_with("mode must be"), "{bad:?} -> {err}");
    }
}

#[test]
fn unknown_flags_are_dropped_and_named_never_an_error() {
    let n = normalize(&req("sleep", &["Test_Without_Asking", "dance", "test_without_asking", "dance"], None), now()).unwrap();
    assert_eq!(n.state.flags, vec![TEST_WITHOUT_ASKING.to_string()]);
    assert_eq!(n.dropped, vec!["dance".to_string()]);
}

#[test]
fn gaming_always_carries_pause_chats() {
    let n = normalize(&req("Gaming", &[MUTE_CONDUCTOR], None), now()).unwrap();
    assert!(n.state.flags.contains(&PAUSE_CHATS.to_string()));
    assert!(n.state.flags.contains(&MUTE_CONDUCTOR.to_string()));
}

#[test]
fn an_end_time_must_be_a_real_time_in_the_future() {
    let past = normalize(&req("sleep", &[], Some(now() - Span::minutes(1))), now()).unwrap_err();
    assert_eq!(past, "until has already passed");
    let mut garbled = req("sleep", &[], None);
    garbled.until = Some("tomorrow".into());
    assert!(normalize(&garbled, now()).unwrap_err().starts_with("until is not an RFC 3339 time"));
    let ok = normalize(&req("sleep", &[], Some(now() + Span::hours(9))), now()).unwrap();
    assert!(ok.state.until.is_some());
}

#[test]
fn set_by_is_trimmed_capped_and_blank_means_none() {
    let mut r = req("sleep", &[], None);
    r.set_by = Some(format!("  {}  ", "p".repeat(80)));
    assert_eq!(normalize(&r, now()).unwrap().state.set_by.unwrap().chars().count(), 40);
    r.set_by = Some("   ".into());
    assert_eq!(normalize(&r, now()).unwrap().state.set_by, None);
}

#[test]
fn a_mode_expires_when_its_end_time_passes_and_one_with_none_never_does() {
    let mut s = normalize(&req("sleep", &[], Some(now() + Span::hours(1))), now()).unwrap().state;
    assert!(!s.is_expired(now()));
    assert!(s.is_expired(now() + Span::hours(1)));
    s.until = Some("garbage".into());
    assert!(s.is_expired(now()), "a mode that can never end is worse than one that ends early");
    s.until = None;
    assert!(!s.is_expired(now() + Span::days(400)));
}

#[test]
fn pause_chats_only_acts_when_the_mode_gains_or_loses_it() {
    let gaming = normalize(&req("gaming", &[], None), now()).unwrap().state;
    let other_pausing = normalize(&req("focus", &[PAUSE_CHATS], None), now()).unwrap().state;
    let sleep = normalize(&req("sleep", &[TEST_WITHOUT_ASKING], None), now()).unwrap().state;
    let none = ModeState::default();
    assert_eq!(pause_step(&none, &gaming), PauseStep::Park);
    assert_eq!(pause_step(&gaming, &sleep), PauseStep::Resume);
    assert_eq!(pause_step(&gaming, &none), PauseStep::Resume);
    assert_eq!(pause_step(&gaming, &other_pausing), PauseStep::Nothing, "no resume-then-park churn");
    assert_eq!(pause_step(&sleep, &none), PauseStep::Nothing);
}

#[test]
fn a_state_file_with_a_missing_field_still_loads() {
    in_scratch_dir(|| {
        let path = persist::config_path().unwrap();
        std::fs::write(&path, r#"{"mode":"sleep"}"#).unwrap();
        match persist::load() {
            Loaded::Ok(s) => {
                assert_eq!(s.mode.as_deref(), Some("sleep"));
                assert!(s.flags.is_empty() && s.until.is_none());
            }
            other => panic!("{other:?}"),
        }
    });
}

#[test]
fn an_unreadable_state_file_is_kept_as_bad_never_read_as_empty_and_overwritten() {
    in_scratch_dir(|| {
        let path = persist::config_path().unwrap();
        assert_eq!(persist::load(), Loaded::Missing);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(persist::load(), Loaded::Bad);
        assert!(!path.exists(), "moved aside");
        assert_eq!(std::fs::read_to_string(path.with_extension("json.bad")).unwrap(), "{ not json");
        assert_eq!(persist::current(), ModeState::default());
    });
}

#[test]
fn switching_gaming_to_sleep_resumes_gaming_before_sleep_is_stored() {
    in_scratch_dir(|| {
        let fx = Recorder::default();
        let on = apply_with(&req("gaming", &[], None), now(), &fx).unwrap();
        assert!(on.gaming.is_some());
        let sleep = apply_with(&req("sleep", &[TEST_WITHOUT_ASKING], Some(now() + Span::hours(9))), now(), &fx).unwrap();
        assert_eq!(fx.calls(), vec![true, false]);
        assert!(sleep.gaming.is_some_and(|g| !g.on));
        assert_eq!(current().mode.as_deref(), Some("sleep"));
    });
}

#[test]
fn the_same_mode_again_replaces_flags_and_end_time_and_never_re_parks() {
    in_scratch_dir(|| {
        let fx = Recorder::default();
        apply_with(&req("gaming", &[], None), now(), &fx).unwrap();
        let again = apply_with(&req("gaming", &[MUTE_CONDUCTOR], Some(now() + Span::hours(2))), now(), &fx).unwrap();
        assert_eq!(fx.calls(), vec![true], "one park, no churn");
        assert!(again.gaming.is_none());
        let s = current();
        assert!(s.flags.contains(&MUTE_CONDUCTOR.to_string()) && s.until.is_some());
    });
}

#[test]
fn a_refused_request_changes_nothing() {
    in_scratch_dir(|| {
        let fx = Recorder::default();
        apply_with(&req("sleep", &[TEST_WITHOUT_ASKING], None), now(), &fx).unwrap();
        assert!(apply_with(&req("sleep", &[], Some(now() - Span::hours(1))), now(), &fx).is_err());
        assert_eq!(current().flags, vec![TEST_WITHOUT_ASKING.to_string()]);
    });
}

#[test]
fn an_end_time_that_passed_while_the_pc_was_off_clears_at_the_first_check_and_resumes() {
    in_scratch_dir(|| {
        let fx = Recorder::default();
        apply_with(&req("gaming", &[], Some(now() + Span::hours(1))), now(), &fx).unwrap();
        assert!(expire_with(now() + Span::minutes(30), &fx).is_none(), "not due yet");
        let ended = expire_with(now() + Span::hours(5), &fx).expect("due");
        assert_eq!(ended.state, ModeState::default());
        assert_eq!(fx.calls(), vec![true, false]);
        assert_eq!(current(), ModeState::default());
        assert!(expire_with(now() + Span::hours(6), &fx).is_none(), "nothing left to end");
    });
}

/// Sits inside the park until released, like gaming mode's supervisor and docker calls.
struct BlockedPark {
    entered: Mutex<std::sync::mpsc::Sender<()>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl PauseEffects for BlockedPark {
    fn set_paused(&self, on: bool) -> GamingModeSummary {
        if on {
            self.entered.lock().unwrap().send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
        GamingModeSummary { on, ..Default::default() }
    }
}

/// While one transition is parking, a second one and the end-time tick wait for it:
/// without the lock the tick could clear a mode set at the moment the old one ended,
/// and the tray toggle and a route call could both park.
#[test]
fn a_transition_in_progress_holds_back_a_second_one_and_the_tick() {
    use std::sync::mpsc::channel;
    use std::time::Duration;
    in_scratch_dir(|| {
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        let blocked = Arc::new(BlockedPark { entered: Mutex::new(entered_tx), release: Mutex::new(release_rx) });
        let first = std::thread::spawn(move || apply_with(&req("gaming", &[], None), now(), &*blocked));
        entered_rx.recv_timeout(Duration::from_secs(5)).expect("the first transition is parking");

        let (done_tx, done_rx) = channel();
        let set_done = done_tx.clone();
        std::thread::spawn(move || {
            let _ = apply_with(&req("sleep", &[TEST_WITHOUT_ASKING], None), now(), &Recorder::default());
            set_done.send("set").unwrap();
        });
        std::thread::spawn(move || {
            let _ = expire_with(now() + Span::days(1), &Recorder::default());
            done_tx.send("tick").unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(300)).is_err(), "both wait for the transition in progress");

        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        for _ in 0..2 {
            done_rx.recv_timeout(Duration::from_secs(5)).expect("both finish once the first is done");
        }
        assert_eq!(current().mode.as_deref(), Some("sleep"), "they ran after it, in order");
    });
}

/// A stored mode that cannot be read is not "no mode": a transition stops instead of
/// overwriting the record that says chats are parked.
#[test]
fn an_unreadable_state_file_stops_a_transition_and_the_tick() {
    in_scratch_dir(|| {
        let path = persist::config_path().unwrap();
        std::fs::create_dir(&path).unwrap(); // a directory where the file should be: exists, cannot be read
        let fx = Recorder::default();
        let err = apply_with(&req("sleep", &[], None), now(), &fx).unwrap_err();
        assert!(err.contains("could not be read"), "{err}");
        assert!(fx.calls().is_empty(), "nothing was parked or resumed");
        assert!(path.is_dir(), "nothing was written over it");
        assert!(expire_with(now(), &fx).is_none());
        assert_eq!(persist::load(), Loaded::Unreadable);
        assert_eq!(current(), ModeState::default(), "a look-only read still answers");
    });
}

#[test]
fn a_mode_with_no_end_time_is_never_expired() {
    in_scratch_dir(|| {
        let fx = Recorder::default();
        apply_with(&req("sleep", &[], None), now(), &fx).unwrap();
        assert!(expire_with(now() + Span::days(30), &fx).is_none());
        assert_eq!(current().mode.as_deref(), Some("sleep"));
    });
}

#[test]
fn gaming_that_was_on_before_modes_existed_becomes_the_current_mode_once() {
    in_scratch_dir(|| {
        adopt_running_gaming(false, now());
        assert_eq!(persist::load(), Loaded::Missing, "gaming off adopts nothing");
        adopt_running_gaming(true, now());
        let s = current();
        assert_eq!(s.mode.as_deref(), Some(GAMING));
        assert!(s.has_flag(PAUSE_CHATS));
        // A later boot with a mode already stored never overwrites it.
        persist::save(&normalize(&req("sleep", &[], None), now()).unwrap().state);
        adopt_running_gaming(true, now());
        assert_eq!(current().mode.as_deref(), Some("sleep"));
    });
}
