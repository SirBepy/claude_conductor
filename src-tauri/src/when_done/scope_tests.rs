use super::*;
use std::collections::HashMap;

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn parents(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs.iter().map(|(c, p)| (c.to_string(), p.to_string())).collect();
    move |id| map.get(id).cloned()
}

#[test]
fn a_child_or_successor_of_an_armed_chat_joins_the_armed_set() {
    let mut s = ArmScope::new(&ids(&["a", "idle"]), &ids(&["a"]));
    s.admit(&ids(&["a", "idle", "child", "next"]), parents(&[("child", "a"), ("next", "a")]));
    assert!(s.armed().contains("child") && s.armed().contains("next"));
    assert!(!s.is_ignored("child") && !s.is_ignored("next"));
}

#[test]
fn a_late_chat_with_no_armed_parent_is_ignored() {
    let mut s = ArmScope::new(&ids(&["a", "idle"]), &ids(&["a"]));
    s.admit(&ids(&["a", "idle", "by-hand", "of-idle"]), parents(&[("of-idle", "idle")]));
    assert!(s.is_ignored("by-hand"), "started by hand after arming");
    assert!(s.is_ignored("of-idle"), "a chat idle at arm time was not armed, so neither is its child");
    assert!(!s.armed().contains("by-hand") && !s.armed().contains("of-idle"));
    assert!(!s.is_ignored("idle"), "chats alive at arm time keep today's handling");
}

#[test]
fn a_grandchild_seen_in_the_same_tick_as_its_parent_is_admitted() {
    let mut s = ArmScope::new(&ids(&["a"]), &ids(&["a"]));
    // Listed before its parent, so a single pass would miss it.
    s.admit(&ids(&["a", "grandchild", "child"]), parents(&[("grandchild", "child"), ("child", "a")]));
    assert!(s.armed().contains("child") && s.armed().contains("grandchild"));
}

#[test]
fn a_child_whose_parent_link_lands_a_tick_late_is_still_admitted() {
    let mut s = ArmScope::new(&ids(&["a"]), &ids(&["a"]));
    s.admit(&ids(&["a", "x"]), parents(&[]));
    assert!(s.is_ignored("x"));
    s.admit(&ids(&["a", "x"]), parents(&[("x", "a")]));
    assert!(s.armed().contains("x") && !s.is_ignored("x"));
}
