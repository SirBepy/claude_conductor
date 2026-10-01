use super::*;

// dry_run_enabled takes the env var's raw value as a parameter rather than
// reading std::env itself, so these tests exercise the switch without
// mutating process environment (shared across parallel test threads).

#[test]
fn dry_run_disabled_when_var_unset() {
    assert!(!dry_run_enabled(None));
}

#[test]
fn dry_run_disabled_when_var_empty() {
    // "set but empty" does not count: the spec is "any non-empty value".
    assert!(!dry_run_enabled(Some("")));
}

#[test]
fn dry_run_enabled_for_any_non_empty_value() {
    assert!(dry_run_enabled(Some("1")));
    assert!(dry_run_enabled(Some("true")));
    assert!(dry_run_enabled(Some("0"))); // presence, not truthiness, is the switch
}

// run_terminal_action: only the dry_run=true branch is exercised here. The
// dry_run=false branch calls crate::system_control::sleep_pc/shutdown_pc for
// real, which must never run in a test (CRITICAL SAFETY: never fire a real
// terminal action in this repo's test suite).

#[test]
fn dry_run_terminal_action_is_a_no_op_ok() {
    assert_eq!(run_terminal_action(TerminalAction::Sleep, true), Ok(()));
    assert_eq!(run_terminal_action(TerminalAction::Shutdown, true), Ok(()));
}
