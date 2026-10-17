//! `ask_user_question` argument validation (todo 818). The `domain`/`badges`
//! enums were advertised but enforced nowhere, so a bad value vanished while
//! the tool still answered `{"acknowledged": true}`. Case/hyphen/space slips
//! normalize; anything else is rejected with the allowed set named. Option
//! `preview` HTML is required on every option of a `ux` question.

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

/// Option-level `preview` problems. A `ux` question exists to compare looks,
/// so every one of its options must show one (Joe, 2026-10-17: "whenever
/// youre asking something visual, you always show me the visual options").
fn preview_problems(q: &Value, n: usize) -> Vec<String> {
    let is_ux = q.get("domain").and_then(Value::as_str) == Some("ux");
    let Some(options) = q.get("options").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (oi, opt) in options.iter().enumerate() {
        let o = oi + 1;
        match opt.get("preview").filter(|p| !p.is_null()) {
            None if is_ux => out.push(format!("question {n} option {o}: a ux question needs a preview on every option")),
            None => {}
            Some(Value::String(s)) if s.trim().is_empty() && is_ux => {
                out.push(format!("question {n} option {o}: preview is empty"));
            }
            Some(Value::String(s)) if s.len() > MAX_PREVIEW_BYTES => out.push(format!(
                "question {n} option {o}: preview is {} bytes, over the {MAX_PREVIEW_BYTES}-byte cap",
                s.len()
            )),
            Some(Value::String(_)) => {}
            Some(_) => out.push(format!("question {n} option {o}: preview must be a string of HTML")),
        }
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
        // After domain normalization, so "UX" is held to the ux rule too.
        preview_issues.extend(preview_problems(&q, n));
        out.push(q);
    }

    if problems.is_empty() && preview_issues.is_empty() {
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
            "a ux question compares how options LOOK, so give every option a `preview`: an HTML \
fragment using the app's own classes and CSS variables (it renders with the app's stylesheets \
loaded, scripts never run); a question about behaviour rather than looks takes another domain",
        );
    }
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
    fn ux_question_without_previews_is_rejected_naming_each_option() {
        let q = json!([{
            "question": "Where should the dot sit?",
            "domain": "ux",
            "options": [
                {"label": "Left", "preview": "<div class='row'>L</div>"},
                {"label": "Right"},
                {"label": "Ring", "preview": "   "}
            ]
        }]);
        let err = normalize(&q).unwrap_err();
        assert!(err.contains("question 1 option 2: a ux question needs a preview"), "{err}");
        assert!(err.contains("question 1 option 3: preview is empty"), "{err}");
        assert!(!err.contains("option 1"), "{err}");
        assert!(err.contains("another domain"), "{err}");
    }

    #[test]
    fn ux_rule_applies_after_domain_normalization() {
        let q = json!([{"question": "Which?", "domain": " UX ", "options": [{"label": "A"}]}]);
        assert!(normalize(&q).unwrap_err().contains("needs a preview"));
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
    fn non_array_and_empty_questions_are_rejected() {
        assert!(normalize(&json!("nope")).is_err());
        assert!(normalize(&json!([])).is_err());
    }
}
