//! `ask_user_question` argument validation (todo 818). The `domain`/`badges`
//! enums were advertised but enforced nowhere, so a bad value vanished while
//! the tool still answered `{"acknowledged": true}`. Case/hyphen/space slips
//! normalize; anything else is rejected with the allowed set named. A `ux`
//! question needs a `preview` on at least one option or on the question.

use serde_json::Value;

use crate::mcp::tool_schemas::{OPTION_BADGES, QUESTION_DOMAINS};

/// `"  Long-Term "` -> `"long_term"`, `"TOOLING"` -> `"tooling"`. Only ever
/// maps onto the enum's own spelling; it never invents a value.
fn canonical(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
}

fn allowed(list: &[&str]) -> String {
    list.join(", ")
}

/// One option's `preview` HTML. The card renders it in a sandboxed frame with
/// the app's stylesheets, so a realistic fragment is a few KB; this caps a
/// runaway paste before it rides every pending-prompt snapshot.
const MAX_PREVIEW_BYTES: usize = 64 * 1024;

/// What a missing or blank `preview` means for the caller: `None` accepts it,
/// `Some(message)` is the problem to report. A question's preview and an
/// option's differ only here (and in the label), so one check serves both.
struct PreviewRule<'a> {
    missing: Option<&'a str>,
    empty: Option<&'a str>,
}

/// The one definition of "this `preview` value counts": a string of HTML that is
/// under the byte cap, and not blank where the rule rejects blanks. `label`
/// prefixes the problem (`question 2`, `question 2 option 1`).
fn check_preview(value: Option<&Value>, label: &str, rule: &PreviewRule) -> Option<String> {
    let problem = match value.filter(|p| !p.is_null()) {
        None => rule.missing?.to_string(),
        // The cap is checked before blankness: a rule that tolerates a blank
        // preview must still refuse a whitespace paste over the cap.
        Some(Value::String(s)) if s.len() > MAX_PREVIEW_BYTES => {
            format!("preview is {} bytes, over the {MAX_PREVIEW_BYTES}-byte cap", s.len())
        }
        Some(Value::String(s)) if s.trim().is_empty() => rule.empty?.to_string(),
        Some(Value::String(_)) => return None,
        Some(_) => "preview must be a string of HTML".to_string(),
    };
    Some(format!("{label}: {problem}"))
}

/// The question's own `preview`: optional, never required, but when present it
/// must be a non-empty string under the same cap as an option's.
fn question_preview_problems(q: &Value, n: usize) -> Vec<String> {
    let rule = PreviewRule { missing: None, empty: Some("preview is empty, leave it out instead") };
    check_preview(q.get("preview"), &format!("question {n}"), &rule).into_iter().collect()
}

/// True when `value` is a non-blank string: a preview that will actually draw.
fn has_preview(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
}

/// Option-level `preview` problems. A `ux` question exists to show how things
/// LOOK, so it needs a picture somewhere: on at least one option, or on the
/// question itself. An option without one renders as a plain option (Joe,
/// 2026-11-19: a model that had one screenshot copied it onto every option
/// because every option was required to carry one). A present preview is
/// still type- and size-checked on every domain.
fn preview_problems(q: &Value, n: usize) -> Vec<String> {
    let options = q.get("options").and_then(Value::as_array);
    let rule = PreviewRule { missing: None, empty: None };
    let mut out: Vec<String> = options
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(oi, opt)| check_preview(opt.get("preview"), &format!("question {n} option {}", oi + 1), &rule))
        .collect();
    let is_ux = q.get("domain").and_then(Value::as_str) == Some("ux");
    let shown = has_preview(q.get("preview")) || options.into_iter().flatten().any(|o| has_preview(o.get("preview")));
    // A question preview that is present but bad is already reported by
    // question_preview_problems; a second "needs a preview" would contradict it.
    let own_given = q.get("preview").is_some_and(|p| !p.is_null());
    if is_ux && !shown && out.is_empty() && !own_given {
        out.push(format!("question {n}: a ux question needs a preview on at least one option or on the question itself"));
    }
    out
}

/// `ordered` asks Joe to put the options in order, so it needs something to
/// order, and it is a different gesture from `multiSelect` (a ticked set with no
/// positions): both on one question would leave the card with no right reading.
fn ordered_problems(q: &Value, n: usize) -> Vec<String> {
    let Some(ordered) = q.get("ordered").filter(|v| !v.is_null()) else { return Vec::new() };
    let Some(on) = ordered.as_bool() else {
        return vec![format!("question {n}: ordered must be true or false")];
    };
    if !on {
        return Vec::new();
    }
    let mut out = Vec::new();
    let options = q.get("options").and_then(Value::as_array).map_or(0, Vec::len);
    if options < 2 {
        out.push(format!("question {n}: an ordered question needs at least two options to put in order"));
    }
    if q.get("multiSelect").and_then(Value::as_bool) == Some(true) {
        out.push(format!("question {n}: ordered and multiSelect cannot be combined, pick one"));
    }
    out
}

/// Normalize `domain` and option `badges` in place and check option
/// `preview`s, or list every value that could not be recovered. `Err` means
/// nothing was posted to the user.
pub fn normalize(questions: &Value) -> Result<Value, String> {
    let Some(items) = questions.as_array() else {
        return Err("`questions` must be an array of question objects.".to_string());
    };
    if items.is_empty() {
        return Err("`questions` must contain at least one question.".to_string());
    }

    let mut problems: Vec<String> = Vec::new();
    let mut preview_issues: Vec<String> = Vec::new();
    let mut question_preview_issues: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::with_capacity(items.len());
    for (qi, item) in items.iter().enumerate() {
        let mut q = item.clone();
        let n = qi + 1;
        let domain = q.get("domain").filter(|d| !d.is_null()).cloned();
        if let Some(domain) = domain {
            let canon = domain.as_str().map(canonical);
            match canon {
                Some(c) if QUESTION_DOMAINS.contains(&c.as_str()) => {
                    q["domain"] = Value::String(c);
                }
                _ => problems.push(format!(
                    "question {n}: domain {domain} is not one of {}",
                    allowed(&QUESTION_DOMAINS)
                )),
            }
        }
        if let Some(options) = q.get_mut("options").and_then(Value::as_array_mut) {
            for (oi, opt) in options.iter_mut().enumerate() {
                let Some(badges) = opt.get_mut("badges").filter(|b| !b.is_null()) else {
                    continue;
                };
                let Some(list) = badges.as_array_mut() else {
                    problems.push(format!("question {n} option {}: badges must be an array", oi + 1));
                    continue;
                };
                for badge in list.iter_mut() {
                    let canon = badge.as_str().map(canonical);
                    match canon {
                        Some(c) if OPTION_BADGES.contains(&c.as_str()) => {
                            *badge = Value::String(c);
                        }
                        _ => problems.push(format!(
                            "question {n} option {}: badge {badge} is not one of {}",
                            oi + 1,
                            allowed(&OPTION_BADGES)
                        )),
                    }
                }
            }
        }
        problems.extend(ordered_problems(&q, n));
        // After domain normalization, so "UX" is held to the ux rule too.
        question_preview_issues.extend(question_preview_problems(&q, n));
        preview_issues.extend(preview_problems(&q, n));
        out.push(q);
    }

    if problems.is_empty() && preview_issues.is_empty() && question_preview_issues.is_empty() {
        return Ok(Value::Array(out));
    }
    let mut hints: Vec<&str> = Vec::new();
    if !problems.is_empty() {
        hints.push(
            "badges and domains are fixed enum tokens, not free text (put wording like \
\"fastest, matches current focus\" in the option's `description`)",
        );
    }
    if !preview_issues.is_empty() {
        hints.push(
            "a ux question compares how things LOOK, so give at least one option a `preview` (an HTML \
fragment using the app's own classes and CSS variables; it renders with the app's stylesheets \
loaded, scripts never run), or give the question itself one when a single picture is what it is \
about. Give an option a preview only when it differs from the others, never copy one image onto \
every option; a question about behaviour rather than looks takes another domain",
        );
    }
    if !question_preview_issues.is_empty() {
        hints.push(
            "a question's own `preview` is optional: one HTML fragment (or <img> of a screenshot) showing what the question is about; leave it out when there is nothing to show",
        );
    }
    problems.extend(question_preview_issues);
    problems.extend(preview_issues);
    Err(format!(
        "{}. Nothing was shown to the user - {}. Fix the value(s) and call ask_user_question again.",
        problems.join("; "),
        hints.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_payload_passes_through_unchanged() {
        let q = json!([{
            "question": "Tabs or spaces?",
            "domain": "tooling",
            "options": [{"label": "Tabs", "badges": ["recommended", "long_term"]}]
        }]);
        assert_eq!(normalize(&q).unwrap(), q);
    }

    #[test]
    fn case_and_hyphen_slips_are_normalized() {
        let q = json!([{
            "question": "Which?",
            "domain": " TOOLING ",
            "options": [{"label": "A", "badges": ["Recommended", "long-term"]}]
        }]);
        let out = normalize(&q).unwrap();
        assert_eq!(out[0]["domain"], "tooling");
        assert_eq!(out[0]["options"][0]["badges"], json!(["recommended", "long_term"]));
    }

    #[test]
    fn descriptive_badge_is_rejected_with_the_allowed_set() {
        let q = json!([{
            "question": "Which?",
            "options": [{"label": "A", "badges": ["recommended", "long-term best"]}]
        }]);
        let err = normalize(&q).unwrap_err();
        assert!(err.contains("question 1 option 1"), "{err}");
        assert!(err.contains("long-term best"), "{err}");
        assert!(err.contains("short_term"), "{err}");
    }

    #[test]
    fn every_bad_value_is_reported_in_one_error() {
        let q = json!([
            {"question": "A", "domain": "process"},
            {"question": "B", "options": [{"label": "x", "badges": ["best"]}]}
        ]);
        let err = normalize(&q).unwrap_err();
        assert!(err.contains("question 1: domain"), "{err}");
        assert!(err.contains("question 2 option 1"), "{err}");
    }

    #[test]
    fn absent_optional_fields_are_left_alone() {
        let q = json!([{"question": "A", "options": [{"label": "x"}]}]);
        assert_eq!(normalize(&q).unwrap(), q);
    }

    #[test]
    fn ux_question_with_no_preview_anywhere_is_rejected() {
        let q = json!([{
            "question": "Where should the dot sit?",
            "domain": "ux",
            "options": [{"label": "Left"}, {"label": "Right", "preview": "   "}]
        }]);
        let err = normalize(&q).unwrap_err();
        assert!(
            err.contains("question 1: a ux question needs a preview on at least one option or on the question itself"),
            "{err}"
        );
        assert!(err.contains("never copy one image onto every option"), "{err}");
        assert!(err.contains("another domain"), "{err}");
    }

    #[test]
    fn a_ux_question_with_a_bad_question_preview_is_reported_once() {
        let q = json!([{"question": "Is this good?", "domain": "ux", "preview": "  ", "options": [{"label": "Good"}]}]);
        let err = normalize(&q).unwrap_err();
        assert!(err.contains("question 1: preview is empty, leave it out instead"), "{err}");
        assert!(!err.contains("needs a preview on at least one option"), "{err}");
    }

    #[test]
    fn ux_rule_applies_after_domain_normalization() {
        let q = json!([{"question": "Which?", "domain": " UX ", "options": [{"label": "A"}]}]);
        assert!(normalize(&q).unwrap_err().contains("needs a preview"));
    }

    /// The relaxed rule (pc-1787): one previewed option, or the question's own
    /// picture, is enough, and the options left without one are plain options.
    #[test]
    fn ux_question_needs_only_one_preview_somewhere() {
        let one_option = json!([{
            "question": "Which?", "domain": "ux",
            "options": [{"label": "A", "preview": "<b>A</b>"}, {"label": "B"}, {"label": "C", "preview": "  "}]
        }]);
        assert_eq!(normalize(&one_option).unwrap(), one_option);
        let on_question = json!([{
            "question": "Is this good?", "domain": "ux", "preview": "<b>the screen</b>",
            "options": [{"label": "Good"}, {"label": "Change something"}]
        }]);
        assert_eq!(normalize(&on_question).unwrap(), on_question);
    }

    #[test]
    fn ux_question_with_previews_passes_through_unchanged() {
        let q = json!([{
            "question": "Which?",
            "domain": "ux",
            "options": [{"label": "A", "preview": "<b>A</b>"}, {"label": "B", "preview": "<b>B</b>"}]
        }]);
        assert_eq!(normalize(&q).unwrap(), q);
    }

    #[test]
    fn previews_are_optional_outside_ux_but_still_type_and_size_checked() {
        let ok = json!([{"question": "Which?", "domain": "arch", "options": [{"label": "A"}, {"label": "B", "preview": "<i>B</i>"}]}]);
        assert!(normalize(&ok).is_ok());
        let not_string = json!([{"question": "Which?", "options": [{"label": "A", "preview": 3}]}]);
        assert!(normalize(&not_string).unwrap_err().contains("preview must be a string"));
        let huge = json!([{"question": "Which?", "options": [{"label": "A", "preview": "x".repeat(MAX_PREVIEW_BYTES + 1)}]}]);
        assert!(normalize(&huge).unwrap_err().contains("byte cap"));
    }

    #[test]
    fn a_question_level_preview_is_optional_and_passes_through_on_any_domain() {
        let q = json!([
            {"question": "Is this good?", "domain": "ux", "preview": "<b>the header</b>",
             "options": [{"label": "Good", "preview": "<i>a</i>"}, {"label": "Change", "preview": "<i>b</i>"}]},
            {"question": "Fine?", "preview": "<b>x</b>", "options": [{"label": "Yes"}]}
        ]);
        assert_eq!(normalize(&q).unwrap(), q);
    }

    #[test]
    fn a_bad_question_level_preview_is_rejected_without_the_ux_or_badge_hint() {
        for bad in [json!(3), json!("  "), json!("x".repeat(MAX_PREVIEW_BYTES + 1))] {
            let q = json!([{"question": "Which?", "preview": bad, "options": [{"label": "A"}]}]);
            let err = normalize(&q).unwrap_err();
            assert!(err.contains("question 1: preview"), "{err}");
            assert!(err.contains("Nothing was shown to the user"), "{err}");
            assert!(!err.contains("ux question compares"), "{err}");
            assert!(!err.contains("fixed enum tokens"), "{err}");
        }
    }

    /// The question-level and option-level checks share one helper; the wording
    /// the model reads back differs only in the label and in whether an empty
    /// string is a problem, so every message is pinned whole.
    #[test]
    fn question_and_option_preview_errors_keep_their_exact_wording() {
        let over = MAX_PREVIEW_BYTES + 1;
        let cap = format!("preview is {over} bytes, over the {MAX_PREVIEW_BYTES}-byte cap");
        let err_of = |q: serde_json::Value| normalize(&json!([q])).unwrap_err();

        let q = |preview: serde_json::Value| json!({"question": "Q", "preview": preview, "options": [{"label": "A"}]});
        assert!(err_of(q(json!(3))).starts_with("question 1: preview must be a string of HTML. "));
        assert!(err_of(q(json!("  "))).starts_with("question 1: preview is empty, leave it out instead. "));
        assert!(err_of(q(json!("x".repeat(over)))).starts_with(&format!("question 1: {cap}. ")));

        let o = |domain: &str, preview: serde_json::Value| {
            json!({"question": "Q", "domain": domain, "options": [{"label": "A", "preview": preview}]})
        };
        assert!(err_of(o("arch", json!(3))).starts_with("question 1 option 1: preview must be a string of HTML. "));
        assert!(err_of(o("arch", json!("x".repeat(over)))).starts_with(&format!("question 1 option 1: {cap}. ")));
        assert!(err_of(o("ux", json!(null))).starts_with("question 1: a ux question needs a preview on at least one option or on the question itself. "));
        assert!(normalize(&json!([o("arch", json!("  "))])).is_ok(), "an empty option preview on a non-ux question is plain");
        assert!(
            err_of(o("arch", json!(" ".repeat(over)))).starts_with(&format!("question 1 option 1: {cap}. ")),
            "a whitespace paste over the cap is refused even where a blank preview is tolerated"
        );
    }

    #[test]
    fn an_ordered_question_with_options_passes_through_unchanged() {
        let q = json!([{"question": "What is first?", "ordered": true,
            "options": [{"label": "A"}, {"label": "B"}, {"label": "C"}]}]);
        assert_eq!(normalize(&q).unwrap(), q);
        let off = json!([{"question": "Which?", "ordered": false, "multiSelect": true, "options": [{"label": "A"}]}]);
        assert_eq!(normalize(&off).unwrap(), off, "ordered:false is the plain question it always was");
    }

    #[test]
    fn an_ordered_question_needs_options_and_refuses_multi_select() {
        let few = json!([{"question": "Order?", "ordered": true, "options": [{"label": "A"}]}]);
        assert!(normalize(&few).unwrap_err().contains("question 1: an ordered question needs at least two options"));
        let none = json!([{"question": "Order?", "ordered": true}]);
        assert!(normalize(&none).unwrap_err().contains("at least two options"));
        let both = json!([{"question": "Order?", "ordered": true, "multiSelect": true,
            "options": [{"label": "A"}, {"label": "B"}]}]);
        assert!(normalize(&both).unwrap_err().contains("ordered and multiSelect cannot be combined"));
        let bad = json!([{"question": "Order?", "ordered": "yes", "options": [{"label": "A"}, {"label": "B"}]}]);
        assert!(normalize(&bad).unwrap_err().contains("ordered must be true or false"));
    }

    #[test]
    fn non_array_and_empty_questions_are_rejected() {
        assert!(normalize(&json!("nope")).is_err());
        assert!(normalize(&json!([])).is_err());
    }
}
