//! The kind of a sub's job: what the Plan card draws as the sub's icon (a build, a
//! review, a gate ...). The ids are the same eleven as `src/shared/chat/chat-kinds.ts`,
//! the one table the front end draws from; `tests/chat-kinds.spec.ts` reads this file
//! and fails when the two lists differ.

use super::SubchatBrief;

/// Every kind, in the order the front end's table lists them.
pub const KINDS: [&str; 11] = ["talk", "plan", "build", "review", "release", "fix", "gate", "test", "triage", "research", "errand"];

/// A kind the main chat named, in its canonical spelling; `None` for a word that is no kind.
pub fn normalize(raw: &str) -> Option<&'static str> {
    let low = raw.trim().to_lowercase();
    KINDS.iter().copied().find(|k| *k == low)
}

/// The kind a brief that named none gets, from the words of the sub's name first (a
/// sub called "review-x" is a review whatever else it is), then from its flags: a gate is a
/// gate, a sub that writes builds, one that answers a question of Joe's talks, any other
/// read-only job researches.
pub fn default_kind(name: Option<&str>, writes: bool, gate: bool, has_question: bool) -> &'static str {
    if gate {
        return "gate";
    }
    if let Some(by_name) = name.and_then(from_name) {
        return by_name;
    }
    if writes {
        "build"
    } else if has_question {
        "talk"
    } else {
        "research"
    }
}

/// The first kind whose own word is a whole word of `name` ("fix-pairing", "Build: x", "gate 2").
fn from_name(name: &str) -> Option<&'static str> {
    let low = name.to_lowercase();
    let words: Vec<&str> = low.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    const ALIASES: [(&str, &str); 14] = [
        ("design", "plan"),
        ("audit", "review"),
        ("fixes", "fix"),
        ("bug", "fix"),
        ("verify", "test"),
        ("e2e", "test"),
        ("push", "gate"),
        ("merge", "gate"),
        ("version", "release"),
        ("investigate", "research"),
        ("explore", "research"),
        ("question", "talk"),
        ("implement", "build"),
        ("sweep", "triage"),
    ];
    // The earliest word that names a kind wins, so "plan-review" is a plan.
    words.iter().find_map(|w| normalize(w).or_else(|| ALIASES.iter().find(|(a, _)| a == w).map(|(_, k)| *k)))
}

/// The kind to show for a stored brief: the one it carries, else the flag-only default (a brief
/// stored before kinds existed has no name to read).
pub fn of_brief(brief: &SubchatBrief) -> &'static str {
    brief.kind.as_deref().and_then(normalize).unwrap_or_else(|| default_kind(None, brief.writes, brief.gate, brief.question.is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_kind_is_canonical_and_a_stray_word_is_none() {
        assert_eq!(normalize(" Build "), Some("build"));
        assert_eq!(normalize("builder"), None);
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn the_name_decides_before_the_flags_and_a_gate_flag_beats_the_name() {
        assert_eq!(default_kind(Some("review-merged-card"), true, false, false), "review");
        assert_eq!(default_kind(Some("Fix: pairing retry"), true, false, false), "fix");
        assert_eq!(default_kind(Some("plan-review"), false, false, false), "plan");
        assert_eq!(default_kind(Some("build-review-x"), true, true, false), "gate");
        assert_eq!(default_kind(Some("builder-x"), true, false, false), "build", "no whole word names a kind: the flags decide");
    }

    #[test]
    fn with_no_name_a_writer_builds_a_questioner_talks_and_a_reader_researches() {
        assert_eq!(default_kind(None, true, false, false), "build");
        assert_eq!(default_kind(None, false, false, true), "talk");
        assert_eq!(default_kind(None, false, false, false), "research");
        assert_eq!(default_kind(Some("   "), false, false, false), "research");
    }

    #[test]
    fn an_old_stored_brief_with_no_kind_reads_by_its_flags() {
        let b: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t","writes":true}"#).unwrap();
        assert_eq!(b.kind, None, "the field is optional on disk");
        assert_eq!(of_brief(&b), "build");
        let g: SubchatBrief = serde_json::from_str(r#"{"parent":"m","gate":true}"#).unwrap();
        assert_eq!(of_brief(&g), "gate");
        let k: SubchatBrief = serde_json::from_str(r#"{"parent":"m","kind":"Triage"}"#).unwrap();
        assert_eq!(of_brief(&k), "triage");
    }
}
