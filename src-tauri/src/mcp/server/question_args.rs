//! `ask_user_question` argument validation (todo 818). The `domain`/`badges`
//! enums were advertised but enforced nowhere, so a bad value vanished while
//! the tool still answered `{"acknowledged": true}`. Case/hyphen/space slips
//! normalize; anything else is rejected with the allowed set named.

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

/// Normalize `domain` and option `badges` in place, or list every value that
/// could not be recovered. `Err` means nothing was posted to the user.
pub fn normalize(questions: &Value) -> Result<Value, String> {
    let Some(items) = questions.as_array() else {
        return Err("`questions` must be an array of question objects.".to_string());
    };
    if items.is_empty() {
        return Err("`questions` must contain at least one question.".to_string());
    }

    let mut problems: Vec<String> = Vec::new();
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
        out.push(q);
    }

    if problems.is_empty() {
        Ok(Value::Array(out))
    } else {
        Err(format!(
            "{}. Nothing was shown to the user - badges and domains are fixed \
enum tokens, not free text (put wording like \"fastest, matches current focus\" \
in the option's `description`). Fix the value(s) and call ask_user_question again.",
            problems.join("; ")
        ))
    }
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
    fn non_array_and_empty_questions_are_rejected() {
        assert!(normalize(&json!("nope")).is_err());
        assert!(normalize(&json!([])).is_err());
    }
}
