use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::TempDataDir;
use crate::sessions::message_drafts::{DraftVariant, MessageDraft};
use std::path::Path;

fn state_with(settings: crate::types::Settings) -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(settings))
}

fn state() -> Arc<DaemonState> {
    state_with(crate::types::Settings::default())
}

fn add(state: &DaemonState, id: &str) {
    state.registry.upsert_interactive(id, Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
    state.registry.set_awaiting(id, Some("done".into()));
    // Joe has looked at the chat at some point, as with any chat he used: a row with no stamp
    // and no view mark at all counts as unseen. Written only into a test's own data folder.
    if crate::daemon::names_own_data_dir(std::env::var("CC_DATA_DIR").ok().as_deref()) {
        chat_config::set_viewed_at(&crate::settings::paths::data_dir().unwrap().join("chat-config.json"), id, 1);
    }
}

/// A settled chat with nothing to view: the one every blocker case starts from.
fn clear() -> (Instance, Facts) {
    let s = state();
    add(&s, "a");
    (s.registry.get("a").unwrap(), Facts { viewed_ms: 1, ..Facts::default() })
}

const RESULT: &str = "2026-11-21T10:00:00+00:00";

fn result_ms() -> i64 {
    chrono::DateTime::parse_from_rfc3339(RESULT).unwrap().timestamp_millis()
}

#[test]
fn a_settled_chat_with_nothing_to_view_may_hide() {
    let (i, f) = clear();
    assert_eq!(blocker(&i, &f), None);
    let mut none = i.clone();
    none.awaiting = None;
    assert_eq!(blocker(&none, &f), None, "no status at all is as settled as done");
}

#[test]
fn every_listed_condition_blocks_a_hide() {
    let (base, f) = clear();
    let cases: Vec<(&str, Box<dyn Fn(&mut Instance, &mut Facts)>)> = vec![
        ("external", Box::new(|i, _| i.kind = InstanceKind::External)),
        ("jarvis", Box::new(|i, _| i.jarvis = true)),
        ("worker", Box::new(|i, _| i.worker_of = Some("j".into()))),
        ("sub", Box::new(|i, _| i.subchat_of = Some("m".into()))),
        ("machine row", Box::new(|i, _| i.machine = Some(crate::types::MachineRef { id: "m".into(), label: "m".into(), online: true }))),
        ("mirrored", Box::new(|_, f| f.mirrored = true)),
        ("pinned", Box::new(|i, _| i.pinned_to_sidebar = true)),
        ("ended", Box::new(|i, _| i.ended_at = Some("2026-11-16T10:00:00Z".into()))),
        ("closing", Box::new(|i, _| i.closing = true)),
        ("working", Box::new(|i, _| i.busy = true)),
        ("compacting", Box::new(|_, f| f.compacting = true)),
        ("a question card", Box::new(|i, _| i.awaiting = Some("question".into()))),
        ("a permission card", Box::new(|i, _| i.awaiting = Some("permission".into()))),
        ("waiting", Box::new(|i, _| i.awaiting = Some("waiting".into()))),
        ("working status", Box::new(|i, _| i.awaiting = Some("working".into()))),
        ("background task", Box::new(|i, _| i.local_task_running = true)),
        ("held message", Box::new(|i, _| i.held_count = 1)),
        ("open card", Box::new(|_, f| f.open_prompt = true)),
        ("a sub working", Box::new(|_, f| f.subs_working = true)),
        ("a draft", Box::new(|_, f| f.draft = true)),
        ("unviewed result", Box::new(|i, _| i.last_event_at = Some(RESULT.into()))),
        ("a sub finished unviewed", Box::new(|_, f| f.subs_unviewed = true)),
    ];
    for (name, mutate) in cases {
        let (mut i, mut f2) = (base.clone(), f.clone());
        mutate(&mut i, &mut f2);
        assert!(blocker(&i, &f2).is_some(), "{name} must block an auto hide");
    }
}

#[test]
fn a_result_blocks_until_joe_has_viewed_it() {
    let (mut i, mut f) = clear();
    i.last_event_at = Some(RESULT.into());
    assert_eq!(blocker(&i, &f), Some("its latest result is unviewed"), "never viewed");
    f.viewed_ms = result_ms() - 1;
    assert_eq!(blocker(&i, &f), Some("its latest result is unviewed"), "viewed before the result");
    f.viewed_ms = result_ms();
    assert_eq!(blocker(&i, &f), None, "viewed at the result");
    f.viewed_ms = result_ms() + 5_000;
    assert_eq!(blocker(&i, &f), None, "viewed after the result");
}

#[test]
fn a_restored_row_with_no_stamp_is_unseen_until_joe_has_looked_at_the_chat() {
    // A restart restores every row without `last_event_at`; its result may have arrived while Joe was away.
    let (mut i, mut f) = clear();
    i.last_event_at = None;
    f.viewed_ms = 0;
    assert!(blocker(&i, &f).is_some(), "never viewed, nothing known about its result");
    f.viewed_ms = 1;
    assert_eq!(blocker(&i, &f), None, "he has looked at it at some point");
}

#[test]
fn a_restart_is_no_new_turn_for_a_chat_the_rule_hid() {
    let (mut i, _) = clear();
    i.last_event_at = None;
    assert_eq!(comes_back(&i, false, false, false, RESULT), Verdict::Stay, "the stored stamp cannot be compared with none");
    i.last_event_at = Some("2026-11-21T11:00:00+00:00".into());
    assert!(matches!(comes_back(&i, false, false, false, RESULT), Verdict::Back(_)), "a real stamp that differs is a turn");
}

#[test]
fn hides_only_after_a_full_quiet_stretch_and_a_block_restarts_it() {
    let (i, f) = clear();
    let rows = vec![(i.clone(), f.clone())];
    let wall = chrono::Utc::now();
    let t0 = Instant::now();
    let after = Duration::from_secs(600);
    let mut seen = HashMap::new();
    assert!(due(&rows, &mut seen, t0, wall, after).is_empty(), "first sight starts the clock");
    assert!(due(&rows, &mut seen, t0 + after - Duration::from_secs(1), wall, after).is_empty());
    assert_eq!(due(&rows, &mut seen, t0 + after, wall, after), vec![i.session_id.clone()]);

    let mut busy = i.clone();
    busy.busy = true;
    due(&[(busy, f.clone())], &mut seen, t0 + after, wall, after);
    assert!(seen.is_empty(), "a blocked chat loses its clock");
    assert!(due(&rows, &mut seen, t0 + after, wall, after).is_empty(), "and starts over");
}

#[test]
fn a_chat_joe_viewed_a_moment_ago_is_not_idle_yet() {
    let (i, mut f) = clear();
    let wall = chrono::Utc::now();
    f.viewed_ms = wall.timestamp_millis() - 60_000;
    let t0 = Instant::now();
    let after = Duration::from_secs(600);
    let rows = vec![(i, f)];
    let mut seen = HashMap::new();
    due(&rows, &mut seen, t0, wall, after);
    assert!(due(&rows, &mut seen, t0 + after, wall, after).is_empty(), "he looked a minute ago, so the open chat never hides");
    let later = wall + chrono::Duration::minutes(10);
    assert_eq!(due(&rows, &mut seen, t0 + after, later, after).len(), 1, "ten minutes after he looked it hides");
}

#[test]
fn a_recent_result_keeps_the_chat_visible_even_once_viewed() {
    let (mut i, mut f) = clear();
    let wall = chrono::Utc::now();
    i.last_event_at = Some((wall - chrono::Duration::minutes(5)).to_rfc3339());
    f.viewed_ms = wall.timestamp_millis() - 4 * 60_000;
    let t0 = Instant::now();
    let after = Duration::from_secs(600);
    let rows = vec![(i, f)];
    let mut seen = HashMap::new();
    due(&rows, &mut seen, t0, wall, after);
    assert!(due(&rows, &mut seen, t0 + after, wall, after).is_empty());
}

fn back(i: &Instance, at: &str) -> Verdict {
    comes_back(i, false, false, false, at)
}

#[test]
fn a_hidden_chat_stays_while_nothing_changed() {
    let (mut i, _) = clear();
    i.last_event_at = Some(RESULT.into());
    assert_eq!(back(&i, RESULT), Verdict::Stay);
}

#[test]
fn each_change_of_state_brings_a_hidden_chat_back() {
    let (mut base, _) = clear();
    base.last_event_at = Some(RESULT.into());
    let cases: Vec<(&str, Box<dyn Fn(&mut Instance)>, bool)> = vec![
        ("a new turn", Box::new(|i| i.busy = true), false),
        ("a question card", Box::new(|i| i.awaiting = Some("question".into())), false),
        ("a permission card", Box::new(|i| i.awaiting = Some("permission".into())), false),
        ("a background task", Box::new(|i| i.local_task_running = true), false),
        ("a queued message", Box::new(|i| i.held_count = 1), false),
        ("a turn that ended", Box::new(|i| i.last_event_at = Some("2026-11-21T11:00:00+00:00".into())), false),
        ("a sub starting", Box::new(|_| {}), true),
    ];
    for (name, mutate, sub) in cases {
        let mut i = base.clone();
        mutate(&mut i);
        assert!(matches!(comes_back(&i, sub, false, false, RESULT), Verdict::Back(_)), "{name} must bring the chat back");
    }
}

#[test]
fn a_compaction_is_housekeeping_and_brings_nothing_back() {
    let (mut i, _) = clear();
    i.last_event_at = Some(RESULT.into());
    i.busy = true;
    assert_eq!(comes_back(&i, false, true, false, RESULT), Verdict::Stay, "while it runs, busy and all");
    i.busy = false;
    i.last_event_at = Some("2026-11-21T11:00:00+00:00".into());
    assert_eq!(comes_back(&i, false, false, true, RESULT), Verdict::Refresh, "its closing stamp is not a turn");
    assert!(matches!(comes_back(&i, false, false, false, RESULT), Verdict::Back(_)), "the same stamp without a compaction is");
}

#[test]
fn the_gap_after_a_compaction_ends_with_the_chat_still_busy_brings_nothing_back() {
    // The flight is cleared a moment before the registry's busy flag drops: a reconcile in
    // between sees `busy` with no compaction running.
    let (mut i, _) = clear();
    i.last_event_at = Some(RESULT.into());
    i.busy = true;
    assert_eq!(comes_back(&i, false, false, true, RESULT), Verdict::Stay);
    assert!(matches!(comes_back(&i, false, false, false, RESULT), Verdict::Back(_)), "a busy chat with no compaction behind it is a turn");
}

#[test]
fn an_ended_chat_stays_where_it_is() {
    let (mut i, _) = clear();
    i.ended_at = Some("2026-11-21T11:00:00Z".into());
    i.busy = true;
    assert_eq!(back(&i, RESULT), Verdict::Stay);
}

fn draft(state: DraftState, origin: &str, main: Option<&str>, updated: &str, sent: &[bool]) -> MessageDraft {
    MessageDraft {
        id: "d".into(),
        topic: "t".into(),
        brief: String::new(),
        receipts: vec![],
        variants: sent
            .iter()
            .map(|s| DraftVariant { recipient: "r".into(), handle_n: 1, versions: vec![], current: 1, person: None, platform: None, sent: *s })
            .collect(),
        state,
        origin_session_id: origin.into(),
        origin_label: String::new(),
        origin_main_session_id: main.map(str::to_string),
        created_at: updated.into(),
        updated_at: updated.into(),
        seen_by_origin: false,
    }
}

#[test]
fn only_an_open_fresh_unsent_draft_holds_a_chat_visible() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-21T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
    let fresh = "2026-11-21T11:00:00Z";
    let open = |d: MessageDraft| draft_owner(&[d], "me", now);
    assert!(open(draft(DraftState::NeedsYou, "me", None, fresh, &[false])), "the chat that wrote it");
    assert!(open(draft(DraftState::NeedsYou, "sub", Some("me"), fresh, &[false])), "the main chat of the sub that wrote it");
    assert!(open(draft(DraftState::NeedsYou, "me", None, fresh, &[true, false])), "one wording still waits");
    assert!(!open(draft(DraftState::NeedsYou, "other", None, fresh, &[false])), "someone else's");
    assert!(!open(draft(DraftState::Copied, "me", None, fresh, &[false])), "copied");
    assert!(!open(draft(DraftState::Archived, "me", None, fresh, &[false])), "archived");
    assert!(!open(draft(DraftState::NeedsYou, "me", None, "2026-11-10T11:00:00Z", &[false])), "stale after a week");
    assert!(!open(draft(DraftState::NeedsYou, "me", None, fresh, &[true, true])), "every wording posted");
}

#[test]
fn the_secs_override_is_a_positive_number_or_the_default() {
    assert_eq!(parse_secs(None), AUTO_HIDE_AFTER);
    assert_eq!(parse_secs(Some("30")), Duration::from_secs(30));
    assert_eq!(parse_secs(Some("0")), AUTO_HIDE_AFTER, "a typo must not make the rule instant");
    assert_eq!(parse_secs(Some("soon")), AUTO_HIDE_AFTER);
}

// ---- the rule against a real registry, hidden list and notifier ----

fn hidden_ids(state: &DaemonState) -> Vec<String> {
    merged_lists(state).sessions
}

#[tokio::test]
async fn a_hide_lands_in_the_shared_hidden_list_and_is_recorded_as_the_rules() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "h1");
    hide(&st, "h1").await;
    assert_eq!(hidden_ids(&st), vec!["h1".to_string()]);
    assert!(auto_hidden::list().hidden.contains_key("h1"));
}

#[tokio::test]
async fn a_hide_is_refused_when_a_blocker_arrived_since_the_tick() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "h1");
    st.registry.set_held_count("h1", 1);
    hide(&st, "h1").await;
    assert!(hidden_ids(&st).is_empty());
    assert!(auto_hidden::list().hidden.is_empty());
}

#[tokio::test]
async fn a_chat_with_a_working_sub_does_not_hide_and_one_with_a_finished_viewed_sub_does() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "main");
    add(&st, "sub");
    st.registry.set_subchat_of("sub", Some("main".into()));
    hide(&st, "main").await;
    assert!(hidden_ids(&st).is_empty(), "the sub has not finished");
    st.registry.set_subchat_finished("sub", true);
    hide(&st, "main").await;
    assert_eq!(hidden_ids(&st), vec!["main".to_string()], "the sub finished and left no unviewed result");
}

#[tokio::test]
async fn a_main_chat_whose_sub_finished_unviewed_stays_until_joe_views_it() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "main");
    add(&st, "sub");
    st.registry.set_subchat_of("sub", Some("main".into()));
    st.registry.set_subchat_finished("sub", true);
    // The sub's turn ended after anything Joe saw: busy flips stamp `last_event_at`.
    st.registry.set_busy("sub", true);
    st.registry.set_busy("sub", false);
    st.registry.set_awaiting("sub", Some("done".into()));
    hide(&st, "main").await;
    assert!(hidden_ids(&st).is_empty(), "he has not seen what the sub finished");
    chat_config::set_viewed_at(&crate::settings::paths::data_dir().unwrap().join("chat-config.json"), "main", chrono::Utc::now().timestamp_millis() + 60_000);
    hide(&st, "main").await;
    assert_eq!(hidden_ids(&st), vec!["main".to_string()], "he viewed the main chat after the sub finished");
}

#[tokio::test]
async fn a_chat_that_ran_and_was_viewed_afterwards_hides_through_the_real_facts() {
    // `add` leaves `last_event_at` empty, so the other registry-backed tests never put a result
    // in front of the viewed check; a chat that really ran has one.
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "ran");
    st.registry.set_busy("ran", true);
    st.registry.set_busy("ran", false);
    st.registry.set_awaiting("ran", Some("done".into()));
    assert!(st.registry.get("ran").unwrap().last_event_at.is_some(), "the turn stamped its end");
    hide(&st, "ran").await;
    assert!(hidden_ids(&st).is_empty(), "Joe never looked at that result");
    chat_config::set_viewed_at(&crate::settings::paths::data_dir().unwrap().join("chat-config.json"), "ran", chrono::Utc::now().timestamp_millis() + 60_000);
    let rows = candidates(&st).await;
    let (i, f) = rows.iter().find(|(i, _)| i.session_id == "ran").expect("a viewed, settled chat is a candidate");
    assert_eq!(blocker(i, f), None, "the facts the sweep reads must carry the viewed mark");
    hide(&st, "ran").await;
    assert_eq!(hidden_ids(&st), vec!["ran".to_string()], "he viewed it after the result");
}

#[tokio::test]
async fn a_new_turn_brings_a_hidden_chat_back_through_the_instances_broadcast() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "h1");
    hide(&st, "h1").await;
    st.registry.set_busy("h1", true);
    crate::daemon::machines::publish_instances_changed(&st);
    assert!(hidden_ids(&st).is_empty(), "the chat is back the moment it works");
    assert!(auto_hidden::list().hidden.is_empty());
}

#[tokio::test]
async fn a_card_brings_a_hidden_chat_back() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "h1");
    hide(&st, "h1").await;
    st.registry.set_awaiting("h1", Some("question".into()));
    reconcile(&st);
    assert!(hidden_ids(&st).is_empty());
}

#[tokio::test]
async fn a_sub_starting_brings_a_hidden_main_chat_back() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "main");
    hide(&st, "main").await;
    add(&st, "sub");
    st.registry.set_subchat_of("sub", Some("main".into()));
    reconcile(&st);
    assert!(hidden_ids(&st).is_empty());
}

#[tokio::test]
async fn a_hand_hidden_chat_is_never_brought_back_by_the_rule() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "mine");
    add(&st, "rules");
    // A chat the rule hid makes `reconcile` do real work, so the check below is not an early return.
    hide(&st, "rules").await;
    assert_eq!(auto_hidden::list().hidden.len(), 1);
    update_local(&st, &HiddenDelta { add: vec!["mine".into()], ..Default::default() });
    st.registry.set_busy("mine", true);
    st.registry.set_busy("rules", true);
    reconcile(&st);
    assert_eq!(hidden_ids(&st), vec!["mine".to_string()], "Joe hid it, so only Joe shows it; the rule's own chat came back");
}

#[tokio::test]
async fn a_chat_joe_hid_between_the_ticks_read_and_the_hide_is_not_recorded_as_the_rules() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "raced");
    // Joe's hand-hide landed after the sweep chose the chat: the list already holds it.
    update_local(&st, &HiddenDelta { add: vec!["raced".into()], ..Default::default() });
    hide(&st, "raced").await;
    assert!(auto_hidden::list().hidden.is_empty(), "it is his, so the rule must not own it and bring it back");
}

#[tokio::test]
async fn a_chat_joe_showed_by_hand_stays_shown_until_its_state_changes() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "c1");
    hide(&st, "c1").await;
    // What `update_hidden_chats` does when Joe unhides it.
    note_hand_change(&st, &[], &["c1".to_string()]);
    update_local(&st, &HiddenDelta { remove: vec!["c1".into()], ..Default::default() });
    assert!(auto_hidden::list().hidden.is_empty());
    assert!(candidates(&st).await.iter().all(|(i, _)| i.session_id != "c1"), "the rule leaves it alone while nothing changed");
    // A restored row has no stamp at all, which is no change either: Joe's choice stands.
    auto_hidden::shown_by_hand("c1", "a stamp from before the restart");
    assert!(candidates(&st).await.iter().all(|(i, _)| i.session_id != "c1"));
    // Its stamp moves (a new turn ended): the choice is spent and the chat counts again.
    st.registry.set_busy("c1", true);
    st.registry.set_busy("c1", false);
    st.registry.set_awaiting("c1", Some("done".into()));
    chat_config::set_viewed_at(&crate::settings::paths::data_dir().unwrap().join("chat-config.json"), "c1", chrono::Utc::now().timestamp_millis() + 60_000);
    auto_hidden::shown_by_hand("c1", "an older stamp");
    assert!(candidates(&st).await.iter().any(|(i, _)| i.session_id == "c1"));
    assert!(auto_hidden::list().shown.is_empty(), "a spent choice is forgotten");
}

#[tokio::test]
async fn a_chat_joe_hides_over_the_rules_hide_is_his_from_then_on() {
    let _data = TempDataDir::new();
    let st = state();
    add(&st, "c1");
    hide(&st, "c1").await;
    note_hand_change(&st, &["c1".to_string()], &[]);
    assert!(auto_hidden::list().hidden.is_empty(), "no longer the rule's to bring back");
    st.registry.set_busy("c1", true);
    reconcile(&st);
    assert_eq!(hidden_ids(&st), vec!["c1".to_string()]);
}

#[tokio::test]
async fn switching_the_rule_off_brings_back_what_it_hid_and_hides_nothing_more() {
    let _data = TempDataDir::new();
    let mut settings = crate::types::Settings::default();
    let st = state_with(settings.clone());
    add(&st, "c1");
    hide(&st, "c1").await;
    settings.extra.insert("autoHideIdleChats".into(), serde_json::json!(false));
    st.settings.replace(settings);
    reconcile(&st);
    assert!(hidden_ids(&st).is_empty());
    sweep(&st).await;
    assert!(hidden_ids(&st).is_empty());
    assert!(!seen_idle().contains_key("c1"), "no clock runs while it is off");
}

#[test]
fn the_switch_defaults_on_and_only_a_real_false_turns_it_off() {
    let mut s = crate::types::Settings::default();
    assert!(s.auto_hide_idle_chats());
    s.extra.insert("autoHideIdleChats".into(), serde_json::json!(false));
    assert!(!s.auto_hide_idle_chats());
    s.extra.insert("autoHideIdleChats".into(), serde_json::json!("no"));
    assert!(s.auto_hide_idle_chats(), "a stray string is not an off switch");
}
