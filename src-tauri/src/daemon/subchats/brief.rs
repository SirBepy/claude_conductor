//! The brief a main chat hands a sub at `spawn_chat`: the wire fields, the
//! validation that refuses a thin one, the record kept for later steps, and
//! the first message the daemon writes from it.
//!
//! A cleared main chat writes thin briefs, and the sub sees nothing but its
//! first message, so a missing field is refused by name rather than guessed.

use serde::{Deserialize, Serialize};

/// The optional `spawn_chat` fields that only a subchats-mode chat acts on.
/// Every other spawn ignores them, so they are all optional on the wire and
/// `validate` is where "required in this mode" is decided.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SubchatArgs {
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub done_when: Option<String>,
    #[serde(default)]
    pub writes: Option<bool>,
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub decisions: Option<String>,
    #[serde(default)]
    pub report_back: Option<bool>,
    #[serde(default)]
    pub worktree: Option<bool>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub review: Option<bool>,
    /// A push gate: runs as a sub that needs no brief fields and may push.
    #[serde(default)]
    pub gate: Option<bool>,
}

fn default_review() -> bool {
    true
}

/// A sub's validated brief, persisted in `chat_config` so it survives a daemon
/// restart and is read from there, never from the first spawn's arguments.
/// Presence of this record also marks a chat as a sub after it has ended, which
/// the registry cannot (its snapshot drops an ended chat); whatever turns a sub
/// into a normal chat must clear it. `report_back`, `after`, `review`,
/// `worktree`, `writes` and `files` are recorded here and acted on by later
/// steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubchatBrief {
    /// The main chat that spawned this sub.
    #[serde(default)]
    pub parent: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub done_when: String,
    #[serde(default)]
    pub writes: bool,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub decisions: String,
    #[serde(default)]
    pub report_back: bool,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub after: Option<String>,
    /// Whether a fresh-context reviewer must check this job. Defaults on; the
    /// main chat turns it off for a purely visual job.
    #[serde(default = "default_review")]
    pub review: bool,
    /// `HEAD` of the sub's repo when it was spawned: the base its facts count
    /// from (`facts.rs`). Set by `spawn::mark_as_sub`, so it is absent on a
    /// brief that never reached a spawn, and on one stored before this existed.
    #[serde(default)]
    pub git_head_at_spawn: Option<String>,
    /// A push-gate sub (`spawn_chat` with `gate: true`). The one sub allowed to
    /// push, and exempt from the named-job rule, the brief fields and the
    /// reviewer requirement. Read it through `subchats::is_gate`.
    #[serde(default)]
    pub gate: bool,
    /// What the repo's upstream (`@{u}`) pointed at when the gate started, so its
    /// finish card can say from git whether the upstream moved. Gate subs only.
    #[serde(default)]
    pub upstream_at_spawn: Option<String>,
}

fn text(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Checks the brief a mode-on `spawn_chat` carries and turns it into the stored
/// record. Every missing field is named in one error, so the main chat fixes the
/// call in one retry instead of one field at a time.
pub fn validate(name: Option<&str>, args: &SubchatArgs, parent: &str) -> Result<SubchatBrief, String> {
    let mut missing: Vec<&str> = Vec::new();
    if name.map(str::trim).filter(|s| !s.is_empty()).is_none() {
        missing.push("name (a short label for the sub)");
    }
    let task = text(&args.task);
    if task.is_none() {
        missing.push("task (the job, in one or two sentences)");
    }
    let goal = text(&args.goal);
    if goal.is_none() {
        missing.push("goal (what this job is for)");
    }
    let done_when = text(&args.done_when);
    if done_when.is_none() {
        missing.push("done_when (what makes it finished)");
    }
    if args.writes.is_none() {
        missing.push("writes (true if it edits files, false if it is read-only)");
    }
    let files: Vec<String> = args
        .files
        .iter()
        .flatten()
        .map(|f| f.trim())
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .collect();
    if args.writes == Some(true) && files.is_empty() {
        missing.push("files (the paths it may write, required because writes is true)");
    }
    if !missing.is_empty() {
        return Err(format!(
            "Subchats mode: this spawn_chat call is missing {}. Send it again with every one of them filled in; the sub sees nothing but this brief. If this is a push gate (code-check, e2e, push), pass gate: true with the gate's prompt instead: a gate needs none of these fields.",
            missing.join("; ")
        ));
    }
    Ok(SubchatBrief {
        parent: parent.to_string(),
        task: task.unwrap_or_default(),
        goal: goal.unwrap_or_default(),
        done_when: done_when.unwrap_or_default(),
        writes: args.writes.unwrap_or(false),
        files,
        decisions: text(&args.decisions).unwrap_or_default(),
        report_back: args.report_back.unwrap_or(false),
        worktree: args.worktree.unwrap_or(false),
        after: text(&args.after),
        review: args.review.unwrap_or(true),
        git_head_at_spawn: None,
        gate: false,
        upstream_at_spawn: None,
    })
}

/// The task a gate sub's card shows, since it is spawned without one.
pub const GATE_TASK: &str = "Gate and push";

/// The gate sub's brief. A gate is spawned by `/gate-chat` with only a name and
/// a prompt, so there is nothing to validate: the prompt is its whole task and is
/// required, because it quotes Joe's push request and the sub sees nothing else.
/// `writes` is true (a fix the gate makes is a commit, and a push is a write to
/// the repo) so the writer slot sees it, and `review` is false because the gate's
/// own `/code-check` already reviewed whatever it changed.
pub fn gate_brief(prompt: Option<&str>, parent: &str) -> Result<SubchatBrief, String> {
    if prompt.map(str::trim).filter(|p| !p.is_empty()).is_none() {
        return Err("gate: true needs a prompt: the gate's first message, quoting Joe's push request word for word and describing the gate to run (a gate sub sees nothing else). It needs no task, goal, done_when or writes.".to_string());
    }
    Ok(SubchatBrief {
        parent: parent.to_string(),
        task: GATE_TASK.to_string(),
        goal: "Run the push gate the first message describes, and push if it says Joe asked.".to_string(),
        done_when: "The gate has passed and the push is done, or it stopped on a red check or a question for Joe.".to_string(),
        writes: true,
        files: Vec::new(),
        decisions: String::new(),
        report_back: false,
        worktree: false,
        after: None,
        review: false,
        git_head_at_spawn: None,
        gate: true,
        upstream_at_spawn: None,
    })
}

/// The sub's first message, written by code from the brief. `extra` is the
/// caller's own `prompt`, kept as context under the brief rather than replacing
/// it, so a main chat that still passes one loses nothing.
pub fn compose_first_message(brief: &SubchatBrief, extra: Option<&str>) -> String {
    let files = if brief.writes {
        format!("You may write only these paths: {}.", brief.files.join(", "))
    } else {
        "This job is read-only: do not edit, create or delete any file.".to_string()
    };
    let mut out = format!(
        "Job: {}\n\nGoal: {}\n\nDone means: {}\n\nFiles: {}",
        brief.task, brief.goal, brief.done_when, files
    );
    if !brief.decisions.is_empty() {
        out.push_str(&format!("\n\nDecisions already made (treat as settled):\n{}", brief.decisions));
    }
    out.push_str(
        "\n\nIf you cannot finish the job as briefed, you may stop and report it as blocked instead of forcing a result. \
         Never weaken a test, a check or the product to make something go green.",
    );
    if let Some(extra) = extra.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str(&format!("\n\nExtra context from the main chat:\n{extra}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete() -> SubchatArgs {
        SubchatArgs {
            task: Some("Rename the header component".into()),
            goal: Some("Match the new design system".into()),
            done_when: Some("cargo check and pnpm typecheck pass".into()),
            writes: Some(true),
            files: Some(vec!["src/header.ts".into()]),
            ..Default::default()
        }
    }

    #[test]
    fn a_complete_brief_validates_with_review_on_by_default() {
        let b = validate(Some("header"), &complete(), "main-1").unwrap();
        assert_eq!(b.parent, "main-1");
        assert!(b.writes && b.review && !b.report_back && !b.worktree);
        assert_eq!(b.files, vec!["src/header.ts".to_string()]);
        assert_eq!(b.after, None);
    }

    #[test]
    fn every_missing_field_is_named_in_one_error() {
        let err = validate(None, &SubchatArgs::default(), "m").unwrap_err();
        for field in ["name", "task", "goal", "done_when", "writes"] {
            assert!(err.contains(field), "{field} not named in: {err}");
        }
        assert!(!err.contains("files (the paths"), "files is only required when writes is true: {err}");
    }

    #[test]
    fn a_writing_sub_without_files_is_refused_but_a_read_only_one_is_not() {
        let mut args = complete();
        args.files = Some(vec!["  ".into()]);
        let err = validate(Some("n"), &args, "m").unwrap_err();
        assert!(err.contains("files"), "{err}");
        args.writes = Some(false);
        validate(Some("n"), &args, "m").expect("a read-only job needs no files");
    }

    #[test]
    fn blank_strings_count_as_missing() {
        let mut args = complete();
        args.goal = Some("   ".into());
        let err = validate(Some("n"), &args, "m").unwrap_err();
        assert!(err.contains("goal"), "{err}");
    }

    #[test]
    fn the_first_message_carries_the_brief_the_stop_clause_and_the_extra_prompt() {
        let mut args = complete();
        args.decisions = Some("Use the shared Button".into());
        let b = validate(Some("n"), &args, "m").unwrap();
        let msg = compose_first_message(&b, Some("see also pc-12"));
        for needle in [
            "Rename the header component",
            "Match the new design system",
            "cargo check and pnpm typecheck pass",
            "src/header.ts",
            "Use the shared Button",
            "stop and report it as blocked",
            "Never weaken a test",
            "see also pc-12",
        ] {
            assert!(msg.contains(needle), "missing {needle:?} in:\n{msg}");
        }
        assert!(!msg.contains('\u{2014}'), "no em dash in generated text");
    }

    #[test]
    fn a_read_only_brief_says_so_and_lists_no_files() {
        let mut args = complete();
        args.writes = Some(false);
        let b = validate(Some("n"), &args, "m").unwrap();
        let msg = compose_first_message(&b, None);
        assert!(msg.contains("read-only"), "{msg}");
        assert!(!msg.contains("You may write only"), "{msg}");
        assert!(!msg.contains("Extra context"), "{msg}");
    }

    #[test]
    fn a_stored_brief_from_before_a_field_existed_still_loads() {
        let b: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t"}"#).unwrap();
        assert!(b.review, "review defaults on when the key is absent");
        assert!(b.files.is_empty());
        assert!(!b.gate && b.upstream_at_spawn.is_none(), "an old brief is not a gate");
    }

    #[test]
    fn a_gate_brief_needs_only_a_prompt_and_is_a_writing_unreviewed_gate() {
        let b = gate_brief(Some("Joe said: push it.\n\nRun the gate. /close"), "main-1").unwrap();
        assert!(b.gate && b.writes && !b.review, "the writer slot sees it, and its own code-check is the review");
        assert_eq!((b.parent.as_str(), b.task.as_str()), ("main-1", GATE_TASK));
        assert!(b.files.is_empty() && b.after.is_none());
        for missing in [None, Some(""), Some("   \n")] {
            let err = gate_brief(missing, "main-1").unwrap_err();
            assert!(err.contains("gate: true needs a prompt") && err.contains("push request"), "{err}");
            assert!(!err.contains("done_when (what"), "a gate is never asked for brief fields: {err}");
        }
    }

    #[test]
    fn the_thin_brief_error_points_a_push_gate_at_gate_true() {
        let err = validate(Some("Gate: repo push"), &SubchatArgs::default(), "m").unwrap_err();
        assert!(err.contains("gate: true") && err.contains("push gate"), "{err}");
    }
}
