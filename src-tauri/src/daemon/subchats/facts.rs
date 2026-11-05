//! Facts about a sub's work, read from git and its transcript and never from
//! what the sub says about itself. They ride under a sub's card in the main chat
//! (the chips), and on a final-stamp question card.
//!
//! The tree is shared with peer chats, so every figure is scoped to what this
//! sub did:
//! - Commits and the diffstat count the range from a base head to `HEAD`, limited
//!   to commits that touch files the sub itself edited (its transcript's Edit and
//!   Write inputs). With no edited files known the whole range counts, and
//!   `scoped` says so.
//! - Uncommitted is only the sub's own edited files git still reports dirty. A
//!   peer's dirty file never counts (memory `project_concurrent_autopilot_on_master`).
//!
//! Anything that cannot be read is `None` or an `unknown` state, and the chips
//! say "unknown". A sub that claims "tests pass" is never believed: the test
//! result is the last test-looking shell call's own exit status.
//!
//! A continued sub's second finish counts SINCE ITS PREVIOUS REPORT, not since
//! spawn: Joe is reading the new card for what changed this round, and the
//! earlier card already stated the earlier work. The chip words say "since its
//! last report" so the two are never mistaken for each other.

use super::git;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// What a count is measured from, in the chip's own words.
pub const SINCE_SPAWN: &str = "spawn";
pub const SINCE_LAST_REPORT: &str = "last report";

const MAX_FILES_NAMED: usize = 6;
const MAX_REVIEW_TEXT: usize = 240;
const MAX_SUMMARY: usize = 140;

/// The last test-looking command and how it ended. `state` is `unknown`
/// (no such command in the transcript, or none that returned), `passed` or `failed`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TestFact {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub command: Option<String>,
    /// One output line that states the outcome ("test result: ok. 12 passed"), when there is one.
    #[serde(default)]
    pub summary: Option<String>,
    /// True when an edit came after the run, so the result describes older code.
    #[serde(default)]
    pub stale: bool,
}

impl TestFact {
    fn unknown() -> Self {
        Self { state: "unknown".into(), ..Self::default() }
    }
}

/// What a fresh reviewer subagent returned. `state` is `ran` (a result that
/// came after the last edit), `none` (no reviewer, one that ran before the last
/// edit, or one the brief did not require) or `unknown` (transcript unreadable).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ReviewerFact {
    #[serde(default)]
    pub state: String,
    /// The reviewer's own result, cut short.
    #[serde(default)]
    pub text: Option<String>,
    /// Why it is `none`, in words a chip can show.
    #[serde(default)]
    pub note: Option<String>,
}

impl ReviewerFact {
    fn none(note: &str) -> Self {
        Self { state: "none".into(), text: None, note: Some(note.into()) }
    }
    fn unknown() -> Self {
        Self { state: "unknown".into(), ..Self::default() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Facts {
    /// [`SINCE_SPAWN`] or [`SINCE_LAST_REPORT`].
    #[serde(default)]
    pub since: String,
    /// Commits since the base head. `None` is unknown (no repo, or no base head).
    #[serde(default)]
    pub commits: Option<u32>,
    #[serde(default)]
    pub files_changed: Option<u32>,
    #[serde(default)]
    pub insertions: Option<u32>,
    #[serde(default)]
    pub deletions: Option<u32>,
    /// True when commits and the diffstat only count commits touching files the
    /// sub edited; false when the whole range was counted.
    #[serde(default)]
    pub scoped: bool,
    /// How many of the sub's own edited files are still uncommitted. `None` is unknown.
    #[serde(default)]
    pub uncommitted: Option<u32>,
    /// Up to a few of their names, for the opened words.
    #[serde(default)]
    pub uncommitted_files: Vec<String>,
    /// `Some(false)` is "not pushed". `None` when there is nothing to push or
    /// the repo has no remote to compare with.
    #[serde(default)]
    pub pushed: Option<bool>,
    #[serde(default)]
    pub test: TestFact,
    #[serde(default)]
    pub reviewer: ReviewerFact,
    #[serde(default)]
    pub head: Option<String>,
}

mod gitx {
    use super::git::run_git;
    use std::path::Path;

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).trim().to_string()
    }

    /// `abs` relative to the repo top, when it sits inside it. Case is kept (the
    /// result is a pathspec) and only compared loosely on Windows.
    fn relative_to(top: &str, abs: &str) -> Option<String> {
        let norm = |s: &str| {
            let s = s.replace('\\', "/");
            s.strip_prefix("//?/").map(str::to_string).unwrap_or(s)
        };
        let (top, abs) = (norm(top), norm(abs));
        let top = top.trim_end_matches('/');
        let same = |a: &str, b: &str| if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b };
        let head = abs.get(..top.len())?;
        (abs.len() > top.len() + 1 && same(head, top) && abs.as_bytes()[top.len()] == b'/')
            .then(|| abs[top.len() + 1..].to_string())
    }

    /// Most pathspecs one git call is handed; a sub that edited more than this is
    /// counted over the files it touched first, which is still its own work.
    const MAX_PATHSPECS: usize = 200;

    /// `files` (absolute) as pathspecs relative to the repo containing `cwd`. Files
    /// outside the repo are dropped.
    pub(super) fn repo_relative(cwd: &Path, files: &[String]) -> Vec<String> {
        let Some((true, top)) = run_git(cwd, &["rev-parse", "--show-toplevel"]) else { return Vec::new() };
        let top = text(&top);
        files.iter().filter_map(|f| relative_to(&top, f)).take(MAX_PATHSPECS).collect()
    }

    /// Runs `git <args> [-- <paths>]` with literal pathspecs, so a file name with a
    /// glob character in it matches only itself.
    fn run_scoped(cwd: &Path, args: &[&str], paths: &[String]) -> Option<String> {
        let mut all: Vec<&str> = vec!["--literal-pathspecs"];
        all.extend_from_slice(args);
        if !paths.is_empty() {
            all.push("--");
            all.extend(paths.iter().map(String::as_str));
        }
        let (ok, out) = run_git(cwd, &all)?;
        ok.then(|| text(&out))
    }

    /// Commits in `base..head`, limited to those touching `paths` when given.
    pub(super) fn commits_between(cwd: &Path, base: &str, head: &str, paths: &[String]) -> Option<u32> {
        let range = format!("{base}..{head}");
        run_scoped(cwd, &["rev-list", "--count", &range], paths)?.parse().ok()
    }

    /// (files changed, insertions, deletions) of `base` to `head`, limited to `paths` when given.
    pub(super) fn diffstat_between(cwd: &Path, base: &str, head: &str, paths: &[String]) -> Option<(u32, u32, u32)> {
        let out = run_scoped(cwd, &["diff", "--shortstat", base, head], paths)?;
        // " 2 files changed, 3 insertions(+), 1 deletion(-)"; an empty diff prints nothing.
        let mut nums = (0u32, 0u32, 0u32);
        for part in out.split(',') {
            let n: u32 = part.split_whitespace().next().and_then(|w| w.parse().ok()).unwrap_or(0);
            if part.contains("file") {
                nums.0 = n;
            } else if part.contains("insertion") {
                nums.1 = n;
            } else if part.contains("deletion") {
                nums.2 = n;
            }
        }
        Some(nums)
    }

    /// Whether `head` is on any remote branch. `None` when the repo has no remote
    /// to compare with, because "not pushed" would then be a guess.
    pub(super) fn is_pushed(cwd: &Path, head: &str) -> Option<bool> {
        let (ok, remotes) = run_git(cwd, &["remote"])?;
        if !ok || text(&remotes).is_empty() {
            return None;
        }
        let (ok, branches) = run_git(cwd, &["branch", "-r", "--contains", head])?;
        ok.then(|| !text(&branches).is_empty())
    }

}

/// Everything [`compute`] reads.
pub struct Inputs<'a> {
    pub cwd: &'a Path,
    /// The sub's transcript, `None` when it cannot be found.
    pub transcript: Option<&'a Path>,
    /// The head the counts run from: the previous report's, else the spawn's.
    pub base: Option<&'a str>,
    pub since: &'a str,
    /// The `tool_use` id the sub named as its reviewer run.
    pub reviewer_tool_use_id: Option<&'a str>,
    /// False when the brief opted out of a reviewer (a purely visual job).
    pub review_required: bool,
    /// Set for a gate sub: `pushed` is then read from whether the upstream moved
    /// past `upstream_before` and now contains `HEAD`, not from this sub's own
    /// commits (a gate that only pushes makes none). Every other sub leaves it
    /// `None` and keeps the commit-based reading.
    pub gate: Option<GateBase<'a>>,
}

/// What a gate sub's push is measured against.
#[derive(Clone, Copy, Debug, Default)]
pub struct GateBase<'a> {
    /// The upstream's commit when the gate started; `None` when the branch had none.
    pub upstream_before: Option<&'a str>,
}

/// Whether a gate pushed: the upstream moved since it started and now holds
/// `head`. `None` when either end of the comparison is unknown (no upstream
/// before or after), because "not pushed" would then be a guess.
fn gate_pushed(cwd: &Path, base: &GateBase, head: &str) -> Option<bool> {
    let before = base.upstream_before?;
    let now = git::upstream(cwd)?;
    if now == before {
        return Some(false);
    }
    git::is_ancestor(cwd, head, &now)
}

/// Blocking: runs git and reads the transcript. Call from a thread or
/// `spawn_blocking`.
pub fn compute(i: &Inputs) -> Facts {
    let head = git::head(i.cwd);
    let edited: Vec<String> = i.transcript.map(|t| git::edited_files(t, i.cwd)).unwrap_or_default();
    let mut facts = Facts { since: i.since.to_string(), head: head.clone(), ..Facts::default() };

    if let (Some(base), Some(head)) = (i.base, head.as_deref()) {
        let paths = gitx::repo_relative(i.cwd, &edited);
        facts.scoped = !paths.is_empty();
        facts.commits = gitx::commits_between(i.cwd, base, head, &paths);
        if let Some((files, ins, del)) = gitx::diffstat_between(i.cwd, base, head, &paths) {
            facts.files_changed = Some(files);
            facts.insertions = Some(ins);
            facts.deletions = Some(del);
        }
        if facts.commits.unwrap_or(0) > 0 {
            facts.pushed = gitx::is_pushed(i.cwd, head);
        }
    }
    if let (Some(gate), Some(head)) = (&i.gate, head.as_deref()) {
        facts.pushed = gate_pushed(i.cwd, gate, head);
    }

    match (i.transcript, git::dirty_keys(i.cwd)) {
        (Some(t), Some(_)) => {
            let own = git::own_uncommitted(t, i.cwd);
            facts.uncommitted = Some(own.len() as u32);
            facts.uncommitted_files = own
                .iter()
                .take(MAX_FILES_NAMED)
                .map(|p| file_name(p))
                .collect();
        }
        // Not a repo, or no transcript to say which files were the sub's own.
        _ => {}
    }

    match i.transcript.and_then(scan_transcript) {
        Some(scan) => {
            facts.test = scan.test_fact();
            facts.reviewer = if !i.review_required {
                ReviewerFact::none("not required for this job")
            } else {
                scan.reviewer_fact(i.reviewer_tool_use_id)
            };
        }
        None => {
            facts.test = TestFact::unknown();
            facts.reviewer = if i.review_required { ReviewerFact::unknown() } else { ReviewerFact::none("not required for this job") };
        }
    }
    facts
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// Whether a shell command runs a test suite. Matches the START of each
/// `&&`/`;`/`|`/newline separated segment, so `git commit -m "fix vitest"` is
/// not a test run but `cd app && cargo test --lib` is.
pub fn looks_like_test(command: &str) -> bool {
    const RUNNERS: [&str; 24] = [
        "cargo test", "cargo nextest", "pnpm test", "pnpm run test", "pnpm vitest", "pnpm exec vitest",
        "pnpm exec playwright", "pnpm playwright", "npm test", "npm run test", "yarn test", "npx vitest",
        "npx playwright", "vitest", "jest", "pytest", "python -m pytest", "go test", "dotnet test",
        "flutter test", "dart test", "mocha", "wdio", "playwright test",
    ];
    command
        .split(['\n', ';', '|', '&'])
        .map(str::trim)
        .filter(|seg| !seg.is_empty())
        .any(|seg| {
            // Leading `VAR=value` words and PowerShell `$env:X=...` set-ups are not the command.
            let seg = seg
                .split_whitespace()
                .skip_while(|w| w.contains('=') && !w.starts_with('-'))
                .collect::<Vec<_>>()
                .join(" ");
            let seg = seg.to_ascii_lowercase();
            RUNNERS.iter().any(|r| seg.starts_with(r))
        })
}

/// One pass over a transcript: where the last edit sits, every test-looking
/// shell call with its outcome, and every tool result by id.
struct Scan {
    last_edit: Option<usize>,
    /// (line index, command, tool_use id)
    tests: Vec<(usize, String, String)>,
    /// tool_use id -> (line index, is_error, text)
    results: std::collections::HashMap<String, (usize, bool, String)>,
    /// tool_use id -> line index
    uses: std::collections::HashMap<String, usize>,
    /// tool_use id -> the tool's name, so a reviewer id can be checked to name a
    /// subagent call and not, say, a Read.
    use_names: std::collections::HashMap<String, String>,
}

fn block_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn scan_transcript(path: &Path) -> Option<Scan> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut scan = Scan {
        last_edit: None,
        tests: Vec::new(),
        results: std::collections::HashMap::new(),
        uses: std::collections::HashMap::new(),
        use_names: std::collections::HashMap::new(),
    };
    for (idx, line) in raw.lines().enumerate() {
        if !line.contains("tool_use") && !line.contains("tool_result") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks {
            match b["type"].as_str() {
                Some("tool_use") => {
                    let name = b["name"].as_str().unwrap_or("");
                    if let Some(id) = b["id"].as_str() {
                        scan.uses.insert(id.to_string(), idx);
                        scan.use_names.insert(id.to_string(), name.to_string());
                    }
                    if git::EDIT_TOOLS.contains(&name) {
                        scan.last_edit = Some(idx);
                    }
                    if matches!(name, "Bash" | "PowerShell") {
                        if let (Some(cmd), Some(id)) = (b["input"]["command"].as_str(), b["id"].as_str()) {
                            if looks_like_test(cmd) {
                                scan.tests.push((idx, cmd.to_string(), id.to_string()));
                            }
                        }
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = b["tool_use_id"].as_str() {
                        let is_error = b["is_error"].as_bool().unwrap_or(false);
                        scan.results.insert(id.to_string(), (idx, is_error, block_text(&b["content"])));
                    }
                }
                _ => {}
            }
        }
    }
    Some(scan)
}

fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}\u{2026}")
    }
}

/// The output line that states the outcome, when a runner printed one.
fn outcome_line(output: &str) -> Option<String> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("test result:") || l.contains(" passed") || l.contains(" failed") || l.starts_with("tests ")
        })
        .map(|l| one_line(l, MAX_SUMMARY))
}

impl Scan {
    fn test_fact(&self) -> TestFact {
        // The last test-looking call that actually returned: one still running
        // when the transcript was read has no result and proves nothing.
        let Some((idx, cmd, id)) = self.tests.iter().rev().find(|(_, _, id)| self.results.contains_key(id)) else {
            return TestFact::unknown();
        };
        let (_, is_error, output) = &self.results[id];
        TestFact {
            state: if *is_error { "failed" } else { "passed" }.into(),
            command: Some(one_line(cmd, 80)),
            summary: outcome_line(output),
            stale: self.last_edit.is_some_and(|e| e > *idx),
        }
    }

    fn reviewer_fact(&self, id: Option<&str>) -> ReviewerFact {
        let Some(id) = id else { return ReviewerFact::none("no reviewer ran") };
        let Some(&used_at) = self.uses.get(id) else {
            return ReviewerFact::none("the named reviewer run is not in the transcript");
        };
        if !SUBAGENT_TOOLS.contains(&self.use_names.get(id).map(String::as_str).unwrap_or("")) {
            return ReviewerFact::none("the named reviewer run is not a subagent call");
        }
        // A reviewer that read the code before the last edit says nothing about
        // the code that shipped. Level counts as before: an edit and a review
        // started in one assistant message cannot have seen each other.
        if self.last_edit.is_some_and(|e| e >= used_at) {
            return ReviewerFact::none("the reviewer ran before the last edit");
        }
        match self.results.get(id) {
            Some((_, _, text)) if !text.trim().is_empty() => {
                ReviewerFact { state: "ran".into(), text: Some(one_line(text, MAX_REVIEW_TEXT)), note: None }
            }
            _ => ReviewerFact::none("the reviewer has not returned a result"),
        }
    }
}

/// Tool names under which the CLI runs a subagent (`Task` is the older name).
const SUBAGENT_TOOLS: [&str; 2] = ["Agent", "Task"];

/// Why a sub that changed files has not shown a review of its own diff. Each
/// variant maps to a refusal that names its fix (`finish::request_finish`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewGap {
    /// No `reviewer_tool_use_id` was passed.
    NotNamed,
    /// The id matches no tool call in the transcript.
    NotInTranscript,
    /// The id names a call to this tool, which is not a subagent.
    NotASubagent(String),
    /// The subagent started at or before the sub's last edit, so it read older code.
    BeforeLastEdit,
    /// The subagent has no result yet, or returned an error or nothing.
    NoResult,
}

/// Whether the sub, which edited files, has a fresh subagent's result for its
/// own diff after its last edit. `None` is "nothing owed": the sub made no edit
/// or the review is in order. An unreadable transcript is also `None`, because a
/// finish that can never be accepted would trap the sub, and the chip says
/// "unknown" for it.
///
/// What this cannot see: whether the subagent really started with no shared
/// context (a subagent resumed from an earlier one, or told to approve, reads
/// the same), and edits made through Bash.
pub fn review_gap(transcript: &Path, reviewer_tool_use_id: Option<&str>) -> Option<ReviewGap> {
    let scan = scan_transcript(transcript)?;
    let last_edit = scan.last_edit?;
    let Some(id) = reviewer_tool_use_id else { return Some(ReviewGap::NotNamed) };
    let Some(&used_at) = scan.uses.get(id) else { return Some(ReviewGap::NotInTranscript) };
    let name = scan.use_names.get(id).map(String::as_str).unwrap_or("");
    if !SUBAGENT_TOOLS.contains(&name) {
        return Some(ReviewGap::NotASubagent(name.to_string()));
    }
    if last_edit >= used_at {
        return Some(ReviewGap::BeforeLastEdit);
    }
    match scan.results.get(id) {
        Some((_, false, text)) if !text.trim().is_empty() => None,
        _ => Some(ReviewGap::NoResult),
    }
}

/// Facts of several subs added up for the "all finished" card. Each field is the
/// sum of what is KNOWN; a sub whose figure is unknown is counted in
/// `unknown_subs` instead of being guessed at, so the words can say "and 1 sub
/// unknown" next to a total.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SumFacts {
    #[serde(default)]
    pub subs: u32,
    #[serde(default)]
    pub commits: u32,
    #[serde(default)]
    pub files_changed: u32,
    #[serde(default)]
    pub uncommitted: u32,
    #[serde(default)]
    pub unpushed: u32,
    #[serde(default)]
    pub tests_passed: u32,
    #[serde(default)]
    pub tests_failed: u32,
    #[serde(default)]
    pub tests_unknown: u32,
    #[serde(default)]
    pub reviewed: u32,
    #[serde(default)]
    pub unreviewed: u32,
    /// Subs with no stored facts at all, or whose git figures were unknown.
    #[serde(default)]
    pub unknown_subs: u32,
}

/// `None` stands for a sub whose card (and so facts) was never stored.
pub fn sum(per_sub: &[Option<&Facts>]) -> SumFacts {
    let mut s = SumFacts { subs: per_sub.len() as u32, ..SumFacts::default() };
    for f in per_sub {
        let Some(f) = f else {
            s.unknown_subs += 1;
            s.tests_unknown += 1;
            continue;
        };
        match (f.commits, f.files_changed) {
            (Some(c), Some(n)) => {
                s.commits += c;
                s.files_changed += n;
            }
            _ => s.unknown_subs += 1,
        }
        s.uncommitted += f.uncommitted.unwrap_or(0);
        if f.pushed == Some(false) {
            s.unpushed += 1;
        }
        match f.test.state.as_str() {
            "passed" => s.tests_passed += 1,
            "failed" => s.tests_failed += 1,
            _ => s.tests_unknown += 1,
        }
        if f.reviewer.state == "ran" {
            s.reviewed += 1;
        } else {
            s.unreviewed += 1;
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::git::test_repo::{git as run, init, transcript};
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn write_transcript(dir: &Path, lines: &[Value]) -> PathBuf {
        let path = dir.join("t.jsonl");
        std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        path
    }

    fn assistant(blocks: Value) -> Value {
        json!({"type": "assistant", "message": {"content": blocks}})
    }

    fn user(blocks: Value) -> Value {
        json!({"type": "user", "message": {"content": blocks}})
    }

    fn edit(id: &str, path: &Path) -> Value {
        assistant(json!([{"type": "tool_use", "id": id, "name": "Edit", "input": {"file_path": path.to_string_lossy()}}]))
    }

    fn shell(id: &str, cmd: &str) -> Value {
        assistant(json!([{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": cmd}}]))
    }

    fn result(id: &str, is_error: bool, text: &str) -> Value {
        user(json!([{"type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": text}]))
    }

    fn commit_file(root: &Path, name: &str, body: &str) {
        std::fs::write(root.join(name), body).unwrap();
        run(root, &["add", name]);
        run(root, &["commit", "-q", "-m", name]);
    }

    fn inputs<'a>(root: &'a Path, tp: Option<&'a Path>, base: Option<&'a str>) -> Inputs<'a> {
        Inputs { cwd: root, transcript: tp, base, since: SINCE_SPAWN, reviewer_tool_use_id: None, review_required: true, gate: None }
    }

    #[test]
    fn commits_and_diffstat_come_from_git_since_the_base() {
        let (dir, root) = init();
        let base = git::head(&root).unwrap();
        commit_file(&root, "a.txt", "one\ntwo\n");
        commit_file(&root, "b.txt", "x\n");
        let tp = transcript(dir.path(), &[("Write", &root.join("a.txt")), ("Write", &root.join("b.txt"))]);
        let f = compute(&inputs(&root, Some(&tp), Some(&base)));
        assert_eq!(f.commits, Some(2));
        assert_eq!(f.files_changed, Some(2));
        assert_eq!(f.insertions, Some(3));
        assert_eq!(f.deletions, Some(0));
        assert_eq!(f.since, SINCE_SPAWN);
        assert_eq!(f.head, git::head(&root));
    }

    #[test]
    fn a_peers_commit_does_not_count_when_the_sub_edited_known_files() {
        let (dir, root) = init();
        let base = git::head(&root).unwrap();
        commit_file(&root, "mine.txt", "m\n");
        commit_file(&root, "peers.txt", "p\n");
        let tp = transcript(dir.path(), &[("Write", &root.join("mine.txt"))]);
        let f = compute(&inputs(&root, Some(&tp), Some(&base)));
        assert!(f.scoped);
        assert_eq!(f.commits, Some(1), "only the commit touching the sub's own file");
        assert_eq!(f.files_changed, Some(1));
    }

    #[test]
    fn with_no_known_edits_the_whole_range_counts_and_says_it_is_not_scoped() {
        let (_dir, root) = init();
        let base = git::head(&root).unwrap();
        commit_file(&root, "x.txt", "x\n");
        let f = compute(&inputs(&root, None, Some(&base)));
        assert!(!f.scoped);
        assert_eq!(f.commits, Some(1));
    }

    #[test]
    fn uncommitted_counts_only_the_subs_own_files_never_a_peers() {
        let (dir, root) = init();
        std::fs::write(root.join("mine.txt"), "m").unwrap();
        std::fs::write(root.join("peers.txt"), "p").unwrap();
        std::fs::write(root.join("base.txt"), "peer edit\n").unwrap();
        let tp = transcript(dir.path(), &[("Write", &root.join("mine.txt"))]);
        let f = compute(&inputs(&root, Some(&tp), None));
        assert_eq!(f.uncommitted, Some(1));
        assert_eq!(f.uncommitted_files, ["mine.txt"]);
    }

    #[test]
    fn nothing_is_claimed_outside_a_repo_or_without_a_base() {
        let dir = tempfile::tempdir().unwrap();
        let f = compute(&inputs(dir.path(), None, None));
        assert_eq!(f.commits, None);
        assert_eq!(f.files_changed, None);
        assert_eq!(f.uncommitted, None, "unknown, not zero");
        assert_eq!(f.test.state, "unknown");
        assert_eq!(f.reviewer.state, "unknown", "no transcript to read");
        assert_eq!(f.pushed, None);
    }

    #[test]
    fn a_pushed_commit_and_an_unpushed_one_are_told_apart() {
        let (dir, root) = init();
        let remote = tempfile::tempdir().unwrap();
        run(remote.path(), &["init", "-q", "--bare"]);
        run(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
        let base = git::head(&root).unwrap();
        commit_file(&root, "a.txt", "a\n");
        let tp = transcript(dir.path(), &[("Write", &root.join("a.txt"))]);
        assert_eq!(compute(&inputs(&root, Some(&tp), Some(&base))).pushed, Some(false));
        run(&root, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        assert_eq!(compute(&inputs(&root, Some(&tp), Some(&base))).pushed, Some(true));
    }

    /// A repo whose branch tracks a bare remote it has pushed once.
    fn tracked_repo() -> (tempfile::TempDir, PathBuf, tempfile::TempDir) {
        let (dir, root) = init();
        let remote = tempfile::tempdir().unwrap();
        run(remote.path(), &["init", "-q", "--bare"]);
        run(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
        run(&root, &["push", "-q", "-u", "origin", "HEAD:refs/heads/main"]);
        (dir, root, remote)
    }

    fn gate_inputs<'a>(root: &'a Path, before: Option<&'a str>) -> Inputs<'a> {
        Inputs { gate: Some(GateBase { upstream_before: before }), ..inputs(root, None, None) }
    }

    #[test]
    fn a_gate_that_pushed_says_pushed_even_though_it_made_no_commit_of_its_own() {
        let (_dir, root, _remote) = tracked_repo();
        commit_file(&root, "a.txt", "work the main chat left unpushed\n");
        let before = git::upstream(&root).unwrap();
        let f = compute(&gate_inputs(&root, Some(&before)));
        assert_eq!(f.pushed, Some(false), "the upstream has not moved: it did not push");
        run(&root, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        let f = compute(&gate_inputs(&root, Some(&before)));
        assert_eq!(f.pushed, Some(true), "the upstream moved and holds HEAD");
        assert_eq!(f.commits, None, "no spawn base was given, and the count is not what makes the chip");
    }

    #[test]
    fn a_gate_pushed_chip_is_unknown_when_either_end_of_the_comparison_is_missing() {
        let (_dir, root, _remote) = tracked_repo();
        assert_eq!(compute(&gate_inputs(&root, None)).pushed, None, "no upstream recorded at the start");
        let (_d2, bare_root) = init();
        let any = git::head(&bare_root).unwrap();
        assert_eq!(compute(&gate_inputs(&bare_root, Some(&any))).pushed, None, "no upstream now: a guess would mislead");
    }

    #[test]
    fn a_gate_that_moved_the_upstream_without_holding_head_did_not_push_this_head() {
        let (_dir, root, remote) = tracked_repo();
        let before = git::upstream(&root).unwrap();
        // Someone else pushed a commit this clone never had, then this clone fetched it
        // and went on to commit locally on a diverged line.
        let other = tempfile::tempdir().unwrap();
        run(other.path(), &["clone", "-q", "-b", "main", &remote.path().to_string_lossy(), "."]);
        run(other.path(), &["config", "user.email", "t@example.com"]);
        run(other.path(), &["config", "user.name", "t"]);
        run(other.path(), &["config", "commit.gpgsign", "false"]);
        commit_file(other.path(), "theirs.txt", "t\n");
        run(other.path(), &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        commit_file(&root, "mine.txt", "m\n");
        run(&root, &["fetch", "-q"]);
        assert_eq!(compute(&gate_inputs(&root, Some(&before))).pushed, Some(false));
    }

    #[test]
    fn a_plain_sub_keeps_the_commit_based_reading_and_never_gets_the_gate_one() {
        let (dir, root, _remote) = tracked_repo();
        let base = git::head(&root).unwrap();
        // No commits of its own: nothing to say about pushing.
        assert_eq!(compute(&inputs(&root, None, Some(&base))).pushed, None);
        commit_file(&root, "a.txt", "a\n");
        let tp = transcript(dir.path(), &[("Write", &root.join("a.txt"))]);
        assert_eq!(compute(&inputs(&root, Some(&tp), Some(&base))).pushed, Some(false), "a plain sub that committed says not pushed");
    }

    #[test]
    fn the_last_test_run_reports_its_exit_status_and_is_unknown_when_there_was_none() {
        let (dir, root) = init();
        let none = write_transcript(dir.path(), &[shell("t0", "ls"), result("t0", false, "a b")]);
        assert_eq!(compute(&inputs(&root, Some(&none), None)).test.state, "unknown");

        let tp = write_transcript(
            dir.path(),
            &[
                shell("t1", "cargo test --lib"),
                result("t1", true, "error\ntest result: FAILED. 3 passed; 1 failed"),
                shell("t2", "cd src-tauri && cargo test --lib x"),
                result("t2", false, "running 4 tests\ntest result: ok. 4 passed; 0 failed"),
            ],
        );
        let t = compute(&inputs(&root, Some(&tp), None)).test;
        assert_eq!(t.state, "passed");
        assert!(t.summary.as_deref().unwrap().contains("4 passed"), "{t:?}");
        assert!(!t.stale);
    }

    #[test]
    fn a_failed_run_and_a_run_that_never_returned_are_not_passes() {
        let (dir, root) = init();
        let failed = write_transcript(dir.path(), &[shell("t1", "pnpm vitest run"), result("t1", true, "1 failed")]);
        assert_eq!(compute(&inputs(&root, Some(&failed), None)).test.state, "failed");
        let pending = write_transcript(dir.path(), &[shell("t1", "pnpm vitest run")]);
        assert_eq!(compute(&inputs(&root, Some(&pending), None)).test.state, "unknown");
    }

    #[test]
    fn a_test_run_before_the_last_edit_is_marked_stale() {
        let (dir, root) = init();
        let tp = write_transcript(
            dir.path(),
            &[shell("t1", "cargo test"), result("t1", false, "ok"), edit("e1", &root.join("base.txt"))],
        );
        let t = compute(&inputs(&root, Some(&tp), None)).test;
        assert_eq!(t.state, "passed");
        assert!(t.stale, "the code changed after this run");
    }

    #[test]
    fn a_command_that_merely_mentions_a_runner_is_not_a_test_run() {
        assert!(!looks_like_test("git commit -m \"fix vitest flake\""));
        assert!(!looks_like_test("echo cargo test"));
        assert!(looks_like_test("cd src-tauri && cargo test --lib"));
        assert!(looks_like_test("$env:CARGO_TARGET_DIR='x'; cargo test --lib"));
        assert!(looks_like_test("CI=1 pnpm vitest run"));
        assert!(looks_like_test("pnpm exec playwright test foo"));
    }

    #[test]
    fn a_reviewer_result_after_the_last_edit_is_read_from_the_transcript() {
        let (dir, root) = init();
        let tp = write_transcript(
            dir.path(),
            &[
                edit("e1", &root.join("base.txt")),
                assistant(json!([{"type": "tool_use", "id": "rev1", "name": "Task", "input": {}}])),
                result("rev1", false, "Found 1 problem:\n  the loop never exits. Fixed."),
            ],
        );
        let mut i = inputs(&root, Some(&tp), None);
        i.reviewer_tool_use_id = Some("rev1");
        let r = compute(&i).reviewer;
        assert_eq!(r.state, "ran");
        assert!(r.text.unwrap().starts_with("Found 1 problem: the loop never exits"));
    }

    #[test]
    fn a_reviewer_that_ran_before_the_last_edit_counts_as_no_reviewer() {
        let (dir, root) = init();
        let tp = write_transcript(
            dir.path(),
            &[
                assistant(json!([{"type": "tool_use", "id": "rev1", "name": "Task", "input": {}}])),
                result("rev1", false, "all fine"),
                edit("e1", &root.join("base.txt")),
            ],
        );
        let mut i = inputs(&root, Some(&tp), None);
        i.reviewer_tool_use_id = Some("rev1");
        let r = compute(&i).reviewer;
        assert_eq!(r.state, "none");
        assert!(r.note.unwrap().contains("before the last edit"));
    }

    #[test]
    fn a_claimed_reviewer_id_that_is_not_in_the_transcript_is_no_reviewer() {
        let (dir, root) = init();
        let tp = write_transcript(dir.path(), &[edit("e1", &root.join("base.txt"))]);
        let mut i = inputs(&root, Some(&tp), None);
        i.reviewer_tool_use_id = Some("ghost");
        assert_eq!(compute(&i).reviewer.state, "none");
        i.reviewer_tool_use_id = None;
        assert_eq!(compute(&i).reviewer.state, "none");
    }

    #[test]
    fn the_chip_and_the_finish_rule_agree_on_what_counts_as_a_review() {
        let (dir, root) = init();
        let edit_then = |rest: Vec<Value>| {
            let mut lines = vec![edit("e1", &root.join("base.txt"))];
            lines.extend(rest);
            write_transcript(dir.path(), &lines)
        };
        let subagent = |id: &str, tool: &str| assistant(json!([{"type": "tool_use", "id": id, "name": tool, "input": {}}]));
        // A Read call named as the reviewer is neither a chip's "ran" nor a gate pass.
        let tp = edit_then(vec![subagent("r", "Read"), result("r", false, "text")]);
        assert_eq!(review_gap(&tp, Some("r")), Some(ReviewGap::NotASubagent("Read".into())));
        let mut i = inputs(&root, Some(&tp), None);
        i.reviewer_tool_use_id = Some("r");
        assert_eq!(compute(&i).reviewer.state, "none");
        // A subagent after the edit with a result passes both.
        let tp = edit_then(vec![subagent("r", "Agent"), result("r", false, "ok")]);
        assert_eq!(review_gap(&tp, Some("r")), None);
        let mut i = inputs(&root, Some(&tp), None);
        i.reviewer_tool_use_id = Some("r");
        assert_eq!(compute(&i).reviewer.state, "ran");
        assert_eq!(review_gap(&tp, None), Some(ReviewGap::NotNamed));
        // No edit at all: nothing is owed, named or not.
        let no_edit = write_transcript(dir.path(), &[shell("b", "ls")]);
        assert_eq!(review_gap(&no_edit, None), None);
        // An edit in the same message as the review cannot have been reviewed.
        let same = write_transcript(
            dir.path(),
            &[
                assistant(json!([
                    {"type": "tool_use", "id": "e", "name": "Edit", "input": {"file_path": root.join("base.txt").to_string_lossy()}},
                    {"type": "tool_use", "id": "r", "name": "Agent", "input": {}}
                ])),
                result("r", false, "ok"),
            ],
        );
        assert_eq!(review_gap(&same, Some("r")), Some(ReviewGap::BeforeLastEdit));
    }

    #[test]
    fn a_job_that_opted_out_of_a_reviewer_says_so() {
        let (dir, root) = init();
        let tp = write_transcript(dir.path(), &[edit("e1", &root.join("base.txt"))]);
        let mut i = inputs(&root, Some(&tp), None);
        i.review_required = false;
        let r = compute(&i).reviewer;
        assert_eq!((r.state.as_str(), r.note.as_deref()), ("none", Some("not required for this job")));
    }

    #[test]
    fn sum_adds_what_is_known_and_counts_the_unknown_apart() {
        let known = Facts {
            commits: Some(2),
            files_changed: Some(3),
            uncommitted: Some(1),
            pushed: Some(false),
            test: TestFact { state: "passed".into(), ..TestFact::default() },
            reviewer: ReviewerFact { state: "ran".into(), ..ReviewerFact::default() },
            ..Facts::default()
        };
        let git_unknown = Facts { test: TestFact::unknown(), reviewer: ReviewerFact::none("x"), ..Facts::default() };
        let s = sum(&[Some(&known), Some(&known), Some(&git_unknown), None]);
        assert_eq!(s.subs, 4);
        assert_eq!((s.commits, s.files_changed), (4, 6));
        assert_eq!(s.uncommitted, 2);
        assert_eq!(s.unpushed, 2);
        assert_eq!((s.tests_passed, s.tests_failed, s.tests_unknown), (2, 0, 2));
        assert_eq!((s.reviewed, s.unreviewed), (2, 1));
        assert_eq!(s.unknown_subs, 2, "the git-unknown sub and the sub with no stored facts");
    }
}
