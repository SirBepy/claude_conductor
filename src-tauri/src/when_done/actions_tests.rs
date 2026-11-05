use super::*;
use serde_json::json;

// default_question_answers builds the `{ question_text: first_option_label }`
// map the auto-resolver hands to respond_question. It is fully pure over a
// serde_json::Value, so it can be unit-tested without the engine task,
// AppState, or the daemon.

// A sub is admitted to the armed set through its parent, so its own question
// (session_id = the sub, the card shows in the main chat) is auto-answered while
// the sub's parent runs. The daemon half, the card that names the answer, is
// tested in `daemon::subchats::card_log` and `daemon::methods::permission`.
#[test]
fn a_subs_question_is_in_scope_once_the_sub_joined_through_its_armed_parent() {
    use std::collections::HashSet;
    let armed: HashSet<String> = ["main".to_string(), "sub".to_string()].into_iter().collect();
    let sub_question = json!({"id": "q1", "session_id": "sub", "display_session_id": "main"});
    assert!(prompt_in_armed_scope(&armed, &sub_question));
    let main_only: HashSet<String> = ["main".to_string()].into_iter().collect();
    assert!(!prompt_in_armed_scope(&main_only, &sub_question), "a sub that never joined is left pending for Joe");
}

#[test]
fn picks_the_first_option_label_per_question() {
    let questions = json!([
        {
            "question": "Proceed with the risky thing?",
            "options": [
                { "label": "Yes, proceed" },
                { "label": "No, abort" }
            ]
        }
    ]);
    let answers = default_question_answers(Some(&questions));
    assert_eq!(
        answers,
        json!({ "Proceed with the risky thing?": "Yes, proceed" })
    );
}

#[test]
fn maps_every_question_independently() {
    let questions = json!([
        { "question": "Q1", "options": [{ "label": "A1" }, { "label": "B1" }] },
        { "question": "Q2", "options": [{ "label": "A2" }] }
    ]);
    let answers = default_question_answers(Some(&questions));
    assert_eq!(answers, json!({ "Q1": "A1", "Q2": "A2" }));
}

#[test]
fn handles_missing_options_and_blank_questions() {
    // No options -> empty-string answer; blank question text -> skipped;
    // None payload -> empty object. Never panics on malformed input.
    let questions = json!([
        { "question": "No options here" },
        { "question": "", "options": [{ "label": "ignored" }] }
    ]);
    let answers = default_question_answers(Some(&questions));
    assert_eq!(answers, json!({ "No options here": "" }));

    assert_eq!(default_question_answers(None), json!({}));
    assert_eq!(default_question_answers(Some(&json!("not-an-array"))), json!({}));
}

#[test]
fn only_a_chat_busy_at_arm_time_gets_its_prompt_auto_resolved() {
    let armed: std::collections::HashSet<String> = ["a".to_string()].into_iter().collect();
    assert!(prompt_in_armed_scope(&armed, &json!({ "id": "r1", "session_id": "a", "tool_name": "Bash" })));
    assert!(!prompt_in_armed_scope(&armed, &json!({ "id": "r2", "session_id": "b", "tool_name": "Bash" })));
    assert!(!prompt_in_armed_scope(&armed, &json!({ "id": "r3" })));
    assert!(!prompt_in_armed_scope(&std::collections::HashSet::new(), &json!({ "id": "r4", "session_id": "a" })));
}
