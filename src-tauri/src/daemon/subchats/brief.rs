//! The brief a main chat hands a sub at `spawn_chat`: the wire fields, the
//! validation that refuses a thin one, the record kept for later steps, and
//! the first message the daemon writes from it.
//!
//! A cleared main chat writes thin briefs, and the sub sees nothing but its
//! first message, so a missing field is refused by name rather than guessed.

use serde::{Deserialize, Serialize};

/// The optional `spawn_chat` fields that only a subchats-mode chat acts on (a
/// mode-off chat ignores them, `gate` apart, which it is refused), so they are
/// all optional on the wire and
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
    /// One sub's name, or a list of names (`"after": ["a", "b"]`): the sub waits
    /// for every one. Kept as one string, a name per line (see [`after_names`]),
    /// so the brief and a peer machine's relay carry it unchanged.
    #[serde(default, deserialize_with = "one_or_many_names")]
    pub after: Option<String>,
    #[serde(default)]
    pub review: Option<bool>,
    /// A push gate: runs as a sub that needs no brief fields and may push.
    #[serde(default)]
    pub gate: Option<bool>,
    /// An ordinary visible chat instead of a sub, from a chat with the mode on.
    /// Every other spawn already makes one, so this changes nothing there.
    #[serde(default)]
    pub plain: Option<bool>,
    /// A folder on the paired machine a `machine` spawn runs in, for when the
    /// project there could not be matched by git origin (or there is none). Only a
    /// `machine` spawn reads it.
    #[serde(default)]
    pub machine_cwd: Option<String>,
    /// Joe's question this job answers, rewritten as one clear question. Its
    /// finish card is then the answer in his Answers card (`QUESTION_MAX` chars).
    #[serde(default)]
    pub question: Option<String>,
    /// The name of an earlier writing sub whose work this one carries on: its
    /// unfinished work is committed as a WIP commit and the new sub's worktree
    /// starts from it, then the old sub is ended. For a new round of work on a
    /// sub that is too heavy to take it.
    #[serde(default)]
    pub continue_from: Option<String>,
    /// What kind of job this is (`kind::KINDS`): the icon the Plan card draws for the
    /// sub. Left out, it is derived from the name and flags (`kind::default_kind`).
    #[serde(default)]
    pub kind: Option<String>,
    /// The feature this sub belongs to, one phrase shared by every sub of the same job
    /// ("Bridge repro"): the Plan card draws all subs with the same feature as one line
    /// titled with it. Left out, the card falls back to the name's shared leading phrase.
    #[serde(default)]
    pub feature: Option<String>,
}

/// The longest feature phrase: it is a line title, not a description.
pub const FEATURE_MAX: usize = 80;

/// A `feature` argument trimmed (inner whitespace collapsed), or why it is refused. Blank is none.
pub fn feature_arg(v: Option<&str>) -> Result<Option<String>, String> {
    let Some(f) = v.map(|f| f.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|f| !f.is_empty()) else { return Ok(None) };
    let n = f.chars().count();
    if n > FEATURE_MAX {
        return Err(format!("feature is {n} chars, over {FEATURE_MAX}: it names the job in a few words (\"Bridge repro\"), so shorten it."));
    }
    Ok(Some(f))
}

/// The longest question `spawn_chat` and `subchat send` take: the Answers card's
/// own limit for a rewritten question.
pub const QUESTION_MAX: usize = 200;

/// A question argument trimmed, or why it is refused. Blank is no question.
pub fn question_arg(v: Option<&str>) -> Result<Option<String>, String> {
    let Some(q) = v.map(str::trim).filter(|q| !q.is_empty()) else { return Ok(None) };
    let n = q.chars().count();
    if n > QUESTION_MAX {
        return Err(format!("question is {n} chars, over {QUESTION_MAX}: rewrite it as one shorter question."));
    }
    Ok(Some(q.to_string()))
}

/// A `kind` argument in its canonical spelling, or why it is refused. Blank is none.
fn kind_arg(v: Option<&str>) -> Result<Option<&'static str>, String> {
    let Some(raw) = v.map(str::trim).filter(|k| !k.is_empty()) else { return Ok(None) };
    super::kind::normalize(raw)
        .map(Some)
        .ok_or_else(|| format!("kind {raw:?} is not one of {}: pick the one that fits the job, or leave kind out and the app derives it.", super::kind::KINDS.join(", ")))
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
    /// Whether a fresh-context reviewer may be owed for this job. Defaults on; the
    /// main chat turns it off for a purely visual job. On, a reviewer is still owed
    /// only when a changed file is on the risky list (`facts::risk`).
    #[serde(default = "default_review")]
    pub review: bool,
    /// `HEAD` of the sub's repo when it was spawned: the base its facts count
    /// from (`facts/`). Set by `spawn::mark_as_sub`, so it is absent on a
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
    /// The sub's own worktree, when it has one (`subchats::worktree`). Kept in
    /// the brief so a restart, a finish and a continue all find the same tree.
    #[serde(default)]
    pub worktree_at: Option<WorktreeInfo>,
    /// The question of Joe's that this sub's next finish answers: set by the
    /// spawn or by a `subchat send` that carries one, moved onto the finish
    /// record (`finish::commit_finish_at`) and cleared there, so a later round
    /// that answers nothing is not drawn as an answer.
    #[serde(default)]
    pub question: Option<String>,
    /// Set when a follow-up turned `writes` from off to on, cleared when the sub
    /// finishes. While set, `finish_subchat` refuses the "needs writes" verdict and a
    /// repeat of an unmet one (`finish::repeat_refusal`): the sub's old read-only
    /// line no longer applies, and it must do the job or name the exact error.
    #[serde(default)]
    pub writes_on_since_finish: bool,
    /// Set only on a sub visiting this machine from a main chat on another one
    /// (`remote::host`): where its family lives. `parent` then names a main chat
    /// that is not in this machine's registry. Read it through
    /// `subchats::is_visiting`.
    #[serde(default)]
    pub home: Option<HomeRef>,
    /// The sub's kind (`kind::KINDS`), set at spawn from the brief or derived from
    /// the name and flags. Absent on a brief stored before kinds existed: read it
    /// through `kind::of_brief`.
    #[serde(default)]
    pub kind: Option<String>,
    /// The feature phrase the brief named (`SubchatArgs::feature`): the Plan card groups the
    /// subs of one feature into one line by it. Absent when none was given.
    #[serde(default)]
    pub feature: Option<String>,
}

/// The machine and main chat a visiting sub belongs to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HomeRef {
    /// The paired machine the main chat lives on. Taken from the transport of the
    /// call that spawned the sub, never from its payload.
    #[serde(default)]
    pub machine_id: String,
    /// The main chat on that machine (also the brief's `parent`).
    #[serde(default)]
    pub main_id: String,
}

/// Where a worktree sub lives and what it merges back into.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeInfo {
    /// The folder the sub runs in: the worktree root, plus the project's own
    /// subfolder when the project is not at the repo's top.
    #[serde(default)]
    pub cwd: String,
    /// The worktree's root, the folder `git worktree add` made.
    #[serde(default)]
    pub path: String,
    /// The sub's own branch.
    #[serde(default)]
    pub branch: String,
    /// The branch the main checkout had checked out when the sub was spawned,
    /// and the branch the sub's commits are merged into.
    #[serde(default)]
    pub target: String,
    /// The main checkout, where the target branch is checked out.
    #[serde(default)]
    pub repo: String,
    /// The commit the sub's facts count from. It moves when the branch is
    /// brought up to date, so commits other people made meanwhile are not
    /// counted as this job's.
    #[serde(default)]
    pub base: Option<String>,
}

/// Reads `after` as a string or a list of strings into one string, a name per line.
fn one_or_many_names<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Option::<OneOrMany>::deserialize(d)? {
        None => None,
        Some(OneOrMany::One(one)) => Some(one),
        Some(OneOrMany::Many(many)) => Some(many.iter().map(|n| n.replace('\n', " ")).collect::<Vec<_>>().join("\n")),
    })
}

/// The sub names an `after` string waits for: one per line, trimmed, empty lines and
/// repeats dropped.
pub fn after_names(after: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for n in after.lines().map(str::trim).filter(|n| !n.is_empty()) {
        if !names.iter().any(|seen| seen == n) {
            names.push(n.to_string());
        }
    }
    names
}

fn text(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Phrases that name a posting action: a job that does one needs a body file, and the
/// Write that makes the file is refused for a read-only sub.
const POSTING_PHRASES: [&str; 5] = ["kickoff.py comment", "kickoff.py describe", "kickoff.py create", "gh pr comment", "post it"];

/// Words that, just before a posting phrase, say the job must NOT post ("do not post it").
/// Also the words of a draft handed to Joe or someone else to post ("ready to post it",
/// "so he can post it", "before we post it").
const NEGATIONS: [&str; 18] = [
    " not ", "n't ", " never ", " without ", " no ", " whether ", " will ", " he can ", " joe can ", " he should ", " joe should ", " they can ",
    " they should ", "before we ", "before joe ", "before he ", "ready to ", "instead of ",
];

/// The refusal for a read-only brief whose goal or done_when names a posting action.
pub const READ_ONLY_POSTING_REFUSAL: &str = "This brief says writes false but its goal or done_when names a posting action (kickoff.py comment/describe/create, gh pr comment, post it). Posting needs a body file, and a read-only sub cannot Write one, so it could only finish with \"needs writes\". Spawn it with writes true and files naming the body file (for example C:/tmp/<name>.md), or drop the posting step from the brief.";

/// The posting phrase `text` asks for, unless the words just before it forbid it.
fn names_a_post(text: &str) -> bool {
    let low = text.to_lowercase().replace('\u{2019}', "'");
    POSTING_PHRASES.iter().any(|phrase| {
        low.match_indices(phrase).any(|(at, _)| {
            let whole_word = !low[..at].chars().next_back().is_some_and(char::is_alphanumeric)
                && !low[at + phrase.len()..].chars().next().is_some_and(char::is_alphanumeric);
            // The clause before the phrase: back to the last sentence end (a dot followed by
            // a space, never the dot inside "kickoff.py"), at most 40 characters.
            let before: String = low[..at].chars().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect();
            let clause = before.rsplit(". ").next().unwrap_or("").rsplit([';', '\n']).next().unwrap_or("");
            let clause = format!(" {clause}");
            whole_word && !NEGATIONS.iter().any(|n| clause.contains(n))
        })
    })
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
    let question = question_arg(args.question.as_deref())?;
    let kind = kind_arg(args.kind.as_deref())?;
    let feature = feature_arg(args.feature.as_deref())?;
    if args.writes == Some(false) && [&goal, &done_when].into_iter().flatten().any(|t| names_a_post(t)) {
        return Err(READ_ONLY_POSTING_REFUSAL.to_string());
    }
    if !missing.is_empty() {
        return Err(format!(
            "Subchats mode: this spawn_chat call is missing {}. Send it again with every one of them filled in; the sub sees nothing but this brief. When the job has more than one sub, also set feature (the job in a few words, the same on every sub of it) so the Plan card shows one line for the job. If this is a push gate (code-check, e2e, push), pass gate: true with the gate's prompt instead: a gate needs none of these fields.",
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
        worktree_at: None,
        kind: Some(kind.unwrap_or_else(|| super::kind::default_kind(name, args.writes.unwrap_or(false), false, question.is_some())).to_string()),
        question,
        writes_on_since_finish: false,
        home: None,
        feature,
    })
}

/// Opens the line of a first message, or of a follow-up, that hands a sub one
/// of Joe's questions. Its finish card is drawn as the answer, so the verdict and
/// text have to be the answer itself, not a report on the work.
pub const QUESTION_JOB: &str = "This answers Joe's question, and your finish_subchat verdict and text are the answer he reads in his Answers card, so make them the answer itself, not a report on what you did. The question: ";

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
        worktree_at: None,
        question: None,
        writes_on_since_finish: false,
        home: None,
        kind: Some("gate".to_string()),
        feature: None,
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
    if let Some(q) = &brief.question {
        out.push_str(&format!("\n\n{QUESTION_JOB}{q}"));
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
    fn a_read_only_brief_that_names_a_posting_action_is_refused_with_the_body_file_reason() {
        for (goal, done) in [
            ("Post the reply to Stevan", "posted with kickoff.py comment 56680 --body-file x"),
            ("Reply on the PR", "gh pr comment 12 posted"),
            ("Approved reply is sent", "Joe approves and you post it"),
            ("Update the ticket", "kickoff.py describe 5 done"),
            ("Make the ticket", "KICKOFF.PY CREATE ran"),
            ("Reply to Stevan", "You should post it"),
            ("Reply to Stevan", "The sub can post it with gh pr comment"),
            ("Reply to Stevan", "Run the tests before you post it"),
        ] {
            let mut args = complete();
            args.writes = Some(false);
            args.files = None;
            args.goal = Some(goal.into());
            args.done_when = Some(done.into());
            let err = validate(Some("n"), &args, "m").unwrap_err();
            assert!(err.contains("body file") && err.contains("writes true"), "{goal} / {done}: {err}");
        }
    }

    #[test]
    fn a_read_only_draft_for_review_or_a_word_that_merely_contains_post_it_is_not_refused() {
        for (goal, done) in [
            ("Draft the reply for Joe to review", "The draft is in the finish text; he decides whether to post it"),
            ("Check the thread", "The main chat will post it after Joe approves"),
            ("Summarise the repost it flow", "A summary is in the finish text"),
            ("Read the thread", "Do not run kickoff.py describe or kickoff.py comment"),
            ("Read the thread", "Make no gh pr comment calls; never use kickoff.py create or gh pr comment"),
            ("Draft the reply", "Draft ready for Joe to review so he can post it"),
            ("Draft the reply", "Reply is ready to post it once Joe agrees"),
            ("Draft the reply", "Joe should post it, or we post it before the standup"),
            ("Read the thread", "We don\u{2019}t post it from here"),
        ] {
            let mut args = complete();
            args.writes = Some(false);
            args.files = None;
            args.goal = Some(goal.into());
            args.done_when = Some(done.into());
            validate(Some("n"), &args, "m").unwrap_or_else(|e| panic!("{goal} / {done}: {e}"));
        }
    }

    #[test]
    fn a_writing_brief_or_a_read_only_one_that_forbids_the_post_is_not_refused() {
        let mut args = complete();
        args.goal = Some("Post the reply".into());
        args.done_when = Some("kickoff.py comment ran".into());
        validate(Some("n"), &args, "m").expect("writes true may post");
        args.writes = Some(false);
        args.files = None;
        args.goal = Some("Draft the reply, do not post it".into());
        args.done_when = Some("The draft is in the finish text and nothing was posted, never with kickoff.py comment".into());
        validate(Some("n"), &args, "m").expect("a negated post is a read-only draft");
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
    fn a_question_is_kept_on_the_brief_told_to_the_sub_and_refused_past_its_cap() {
        let mut args = complete();
        args.question = Some("  Why does Gboard swipe fail?  ".into());
        let b = validate(Some("ime"), &args, "main").unwrap();
        assert_eq!(b.question.as_deref(), Some("Why does Gboard swipe fail?"));
        let first = compose_first_message(&b, None);
        assert!(first.contains(&format!("{QUESTION_JOB}Why does Gboard swipe fail?")), "{first}");
        assert!(!compose_first_message(&validate(Some("x"), &complete(), "main").unwrap(), None).contains(QUESTION_JOB));
        args.question = Some("x".repeat(QUESTION_MAX + 1));
        let err = validate(Some("ime"), &args, "main").unwrap_err();
        assert!(err.contains("question is 201 chars"), "{err}");
        assert_eq!(question_arg(Some("   ")), Ok(None), "blank is no question");
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
    fn a_brief_stores_the_feature_it_names_trimmed_and_one_spaced() {
        let mut args = complete();
        args.feature = Some("  Bridge   repro 
".into());
        assert_eq!(validate(Some("bridge-sub-1"), &args, "m").unwrap().feature.as_deref(), Some("Bridge repro"));
        for none in [None, Some(String::new()), Some("   ".to_string())] {
            args.feature = none;
            assert_eq!(validate(Some("bridge-sub-1"), &args, "m").unwrap().feature, None, "a blank feature is none");
        }
        args.feature = Some("x".repeat(FEATURE_MAX + 1));
        let err = validate(Some("bridge-sub-1"), &args, "m").unwrap_err();
        assert!(err.contains("feature") && err.contains(&FEATURE_MAX.to_string()), "{err}");
        let wire: SubchatArgs = serde_json::from_str(r#"{"feature":"Bridge repro"}"#).unwrap();
        assert_eq!(wire.feature.as_deref(), Some("Bridge repro"), "spawn_chat's feature key reaches the brief args");
    }

    #[test]
    fn a_stored_brief_from_before_features_existed_has_none_and_a_gate_names_none() {
        let b: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t"}"#).unwrap();
        assert_eq!(b.feature, None);
        assert_eq!(gate_brief(Some("go"), "m").unwrap().feature, None);
        let round: SubchatBrief = serde_json::from_str(&serde_json::to_string(&SubchatBrief { feature: Some("F".into()), ..b }).unwrap()).unwrap();
        assert_eq!(round.feature.as_deref(), Some("F"), "a feature survives the chat_config round trip");
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
    fn a_brief_stores_the_kind_it_names_or_the_one_its_name_and_flags_derive() {
        let mut args = complete();
        args.kind = Some(" Review ".into());
        assert_eq!(validate(Some("header"), &args, "m").unwrap().kind.as_deref(), Some("review"));
        args.kind = None;
        assert_eq!(validate(Some("fix-header"), &args, "m").unwrap().kind.as_deref(), Some("fix"), "the name decides");
        assert_eq!(validate(Some("header"), &args, "m").unwrap().kind.as_deref(), Some("build"), "a writer builds");
        args.writes = Some(false);
        assert_eq!(validate(Some("header"), &args, "m").unwrap().kind.as_deref(), Some("research"));
        assert_eq!(gate_brief(Some("go"), "m").unwrap().kind.as_deref(), Some("gate"));
    }

    #[test]
    fn an_unknown_kind_is_refused_with_the_valid_ones_listed() {
        let mut args = complete();
        args.kind = Some("wizard".into());
        let err = validate(Some("n"), &args, "m").unwrap_err();
        assert!(err.contains("kind") && err.contains("errand") && err.contains("wizard"), "{err}");
    }

    #[test]
    fn the_thin_brief_error_points_a_push_gate_at_gate_true() {
        let err = validate(Some("Gate: repo push"), &SubchatArgs::default(), "m").unwrap_err();
        assert!(err.contains("gate: true") && err.contains("push gate"), "{err}");
    }
}
