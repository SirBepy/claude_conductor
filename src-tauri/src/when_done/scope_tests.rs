use super::*;
use std::collections::HashMap;

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn parents(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs.iter().map(|(c, p)| (c.to_string(), p.to_string())).collect();
    move |id| map.get(id).cloned()
}

fn no_subs(_: &str) -> bool {
    false
}

#[test]
fn a_child_or_successor_of_an_armed_chat_joins_the_armed_set() {
    let mut s = ArmScope::new(&ids(&["a", "idle"]), &ids(&["a"]));
    s.admit(&ids(&["a", "idle", "child", "next"]), parents(&[("child", "a"), ("next", "a")]), no_subs);
    assert!(s.armed().contains("child") && s.armed().contains("next"));
    assert!(!s.is_ignored("child") && !s.is_ignored("next"));
}

#[test]
fn a_late_chat_with_no_armed_parent_is_ignored() {
    let mut s = ArmScope::new(&ids(&["a", "idle"]), &ids(&["a"]));
    s.admit(&ids(&["a", "idle", "by-hand", "of-idle"]), parents(&[("of-idle", "idle")]), no_subs);
    assert!(s.is_ignored("by-hand"), "started by hand after arming");
    assert!(s.is_ignored("of-idle"), "a chat idle at arm time was not armed, so neither is its child");
    assert!(!s.armed().contains("by-hand") && !s.armed().contains("of-idle"));
    assert!(!s.is_ignored("idle"), "chats alive at arm time keep today's handling");
}

#[test]
fn a_grandchild_seen_in_the_same_tick_as_its_parent_is_admitted() {
    let mut s = ArmScope::new(&ids(&["a"]), &ids(&["a"]));
    // Listed before its parent, so a single pass would miss it.
    s.admit(&ids(&["a", "grandchild", "child"]), parents(&[("grandchild", "child"), ("child", "a")]), no_subs);
    assert!(s.armed().contains("child") && s.armed().contains("grandchild"));
}

#[test]
fn a_child_whose_parent_link_lands_a_tick_late_is_still_admitted() {
    let mut s = ArmScope::new(&ids(&["a"]), &ids(&["a"]));
    s.admit(&ids(&["a", "x"]), parents(&[]), no_subs);
    assert!(s.is_ignored("x"));
    s.admit(&ids(&["a", "x"]), parents(&[("x", "a")]), no_subs);
    assert!(s.armed().contains("x") && !s.is_ignored("x"));
}

/// A main chat idle at arm time (waiting on its subs) is woken by a finished sub
/// and starts the next one: that sub is the work the dev let finish, so it holds
/// the run, while a plain child of the same idle chat still does not.
#[test]
fn a_sub_of_a_chat_idle_at_arm_time_joins_but_a_plain_child_does_not() {
    let mut s = ArmScope::new(&ids(&["main", "sub-1"]), &ids(&["sub-1"]));
    s.admit(&ids(&["main", "sub-1", "sub-2", "child"]), parents(&[("sub-2", "main"), ("child", "main")]), |id| id == "sub-2");
    assert!(s.armed().contains("sub-2") && !s.is_ignored("sub-2"));
    assert!(s.is_ignored("child"));
}

/// A sub of a chat that was itself ignored (started by hand after arming) stays
/// ignored: only a parent that existed at arm time vouches for it.
#[test]
fn a_sub_of_an_ignored_chat_is_ignored() {
    let mut s = ArmScope::new(&ids(&["a"]), &ids(&["a"]));
    s.admit(&ids(&["a", "by-hand", "its-sub"]), parents(&[("its-sub", "by-hand")]), |id| id == "its-sub");
    assert!(s.is_ignored("by-hand") && s.is_ignored("its-sub"));
}
