use super::*;
use serde_json::json;

// default_question_answers builds the `{ question_text: first_option_label }`
// map the auto-resolver hands to respond_question. It is fully pure over a
// serde_json::Value, so it can be unit-tested without the engine task,
// AppState, or the daemon.

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
