//! Facts about a sub's work, read from git and its transcript and never from
//! what the sub says about itself. They ride under a sub's card in the main chat
//! (the chips), and on a final-stamp question card.
//!
//! The tree is shared with peer chats, so every figure is scoped to what this
//! sub did:
//! - Commits and the diffstat count the range from a base head to `HEAD`, limited
//!   to commits that touch files the sub itself edited (its transcript's Edit and
//!   Write inputs). With no edited file to limit the range by, the commits are
//!   unknown with a note saying why, because in a shared tree every commit in the
//!   range would be credited to the sub, a peer's included.
//! - Uncommitted is only the sub's own edited files git still reports dirty. A
//!   peer's dirty file never counts (memory `project_concurrent_autopilot_on_master`).
//!   A sub that ran the shell and edited nothing with the Edit tools may have
//!   written files with `sed -i` or a redirect, which the transcript cannot name,
//!   so its uncommitted count is unknown with a note.
//!
//! Anything that cannot be read is `None` or an `unknown` state, and the chips
//! say "unknown". A sub that claims "tests pass" is never believed: the test
//! state comes from the last test-looking shell call's own output (a failure
//! marker beats a clean exit status, which a pipe replaces with `tail`'s) and from
//! its exit status only when the command's status was the suite's own.
//!
//! A reviewer is a fresh subagent: a call counts only if it is an `Agent` or
//! `Task` tool_use ([`SUBAGENT_TOOLS`]), read by [`reviewer_fact_from_transcript`] for
//! the chip and by [`review_gap`] for the finish check.
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
    /// Why `commits` and the diffstat are unknown, in words a chip can show. Set
    /// when the figures could not be attributed to this sub.
    #[serde(default)]
    pub commits_note: Option<String>,
    /// How many of the sub's own edited files are still uncommitted. `None` is unknown.
    #[serde(default)]
    pub uncommitted: Option<u32>,
    /// Up to a few of their names, for the opened words.
    #[serde(default)]
    pub uncommitted_files: Vec<String>,
    /// Why `uncommitted` is unknown, in words a chip can show.
    #[serde(default)]
    pub uncommitted_note: Option<String>,
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
    /// A worktree sub only: the branch its commits are merged into, and whether
    /// they are in it now. `merged` is `None` when the sub made no commits.
    #[serde(default)]
    pub merged_into: Option<String>,
    #[serde(default)]
    pub merged: Option<bool>,
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

    let scan = i.transcript.and_then(scan_transcript);
    // The shell is invisible to the edit list: a sub that wrote files with `sed -i`
    // or a redirect has nothing in `edited`, so its own files cannot be counted.
    let shell_only = edited.is_empty() && scan.as_ref().is_some_and(|s| s.shell_used);

    if let (Some(base), Some(head)) = (i.base, head.as_deref()) {
        let paths = gitx::repo_relative(i.cwd, &edited);
        if paths.is_empty() {
            // The tree is shared with peer chats. With no file of this sub's own to
            // limit the range by, every commit in it would be credited to the sub,
            // and a green number nobody can vouch for is worse than "?".
            facts.commits_note = Some(
                if edited.is_empty() {
                    "it edited no files with the Edit or Write tools, so another chat's commits in this tree cannot be told apart from its own"
                } else {
                    "the files it edited are outside this repo, so another chat's commits here cannot be told apart from its own"
                }
                .to_string(),
            );
        } else {
            facts.scoped = true;
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
    }
    if let (Some(gate), Some(head)) = (&i.gate, head.as_deref()) {
        facts.pushed = gate_pushed(i.cwd, gate, head);
    }

    match (i.transcript, git::dirty_keys(i.cwd)) {
        (Some(_), Some(_)) if shell_only => {
            facts.uncommitted_note = Some("this sub only used the shell, so its files can't be tracked".to_string());
        }
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

    match scan {
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
    /// The sub ran at least one shell command.
    shell_used: bool,
    /// Every `Agent`/`Task` call as (line index, tool_use id), in transcript order.
    agent_uses: Vec<(usize, String)>,
    /// Subagent id -> (line index, report): the hand-back a subagent's report
    /// arrives in when its tool_result is only a launch or delivery stub.
    handbacks: std::collections::HashMap<String, (usize, String)>,
}

/// A foreground subagent whose report went to the caller as a message: the
/// tool_result is this note and the report itself is a later transcript entry.
const DELIVERED_STUB: &str = "delivered to you as a message from \"";
/// A subagent run in the background: the tool_result is the launch note and the
/// report arrives later, if at all.
const LAUNCHED_STUB: &str = "Async agent launched successfully";

/// The subagent id inside a [`DELIVERED_STUB`] result.
fn delivered_agent(text: &str) -> Option<String> {
    let at = text.find(DELIVERED_STUB)? + DELIVERED_STUB.len();
    let id: String = text[at..].chars().take_while(|c| *c != '"').collect();
    (!id.is_empty()).then_some(id)
}

/// The subagent id inside a [`LAUNCHED_STUB`] result.
fn launched_agent(text: &str) -> Option<String> {
    if !text.trim_start().starts_with(LAUNCHED_STUB) {
        return None;
    }
    let at = text.find("agentId:")? + "agentId:".len();
    let id: String = text[at..].trim_start().chars().take_while(|c| !c.is_whitespace()).collect();
    (!id.is_empty()).then_some(id)
}

/// Every `<agent-message from="ID">` block in `v`'s strings, as (id, report).
/// The harness frames a subagent's hand-back this way wherever it lands (a
/// queue entry, a queued-command attachment, a user line).
fn handback_reports(v: &Value, out: &mut Vec<(String, String)>, depth: u8) {
    const OPEN: &str = "<agent-message from=\"";
    match v {
        Value::String(s) if s.contains(OPEN) => {
            let mut rest = s.as_str();
            while let Some(at) = rest.find(OPEN) {
                rest = &rest[at + OPEN.len()..];
                let Some(end) = rest.find('"') else { break };
                let id = rest[..end].to_string();
                let body_start = rest.find('>').map_or(0, |g| g + 1);
                let body = &rest[body_start..rest.find("</agent-message>").unwrap_or(rest.len()).max(body_start)];
                // The frame's own preamble ends at this line; the report follows it.
                let report = body.split_once("The report follows:").map_or(body, |(_, r)| r);
                let report = report
                    .lines()
                    .map(|l| l.strip_prefix("  ").unwrap_or(l))
                    .collect::<Vec<_>>()
                    .join("\n");
                let report = report.trim();
                if !id.is_empty() && !report.is_empty() {
                    out.push((id, report.to_string()));
                }
            }
        }
        Value::Array(items) if depth < 6 => items.iter().for_each(|i| handback_reports(i, out, depth + 1)),
        Value::Object(map) if depth < 6 => map.values().for_each(|i| handback_reports(i, out, depth + 1)),
        _ => {}
    }
}

/// What became of a reviewer subagent call.
enum AgentOutcome {
    /// It returned. `None` text: the result said the report was delivered as a
    /// message and that message is not in the transcript, so the words are unknown.
    Returned(Option<String>),
    /// No result yet, or a background launch whose report never arrived.
    Pending,
    /// The call was refused (a dispatch hook) or errored, or returned nothing.
    Failed,
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
        shell_used: false,
        agent_uses: Vec::new(),
        handbacks: std::collections::HashMap::new(),
    };
    // (line index, tool_use id) of every edit call. Whether it counts depends on
    // its result, which comes later, so the last real edit is settled after the pass.
    let mut edits: Vec<(usize, Option<String>)> = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let has_handback = line.contains("agent-message from=");
        if !has_handback && !line.contains("tool_use") && !line.contains("tool_result") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        // A request log line replays earlier entries with a later position, which
        // would move an edit or a call past the work that came after it.
        if matches!(v["type"].as_str(), Some("api-request-blob" | "api-request")) {
            continue;
        }
        if has_handback {
            let mut found = Vec::new();
            handback_reports(&v, &mut found, 0);
            for (agent, report) in found {
                scan.handbacks.entry(agent).or_insert((idx, report));
            }
        }
        // The same report rides on the tool_result line itself in some builds.
        if let (Some(agent), Some(report)) = (v["toolUseResult"]["agentId"].as_str(), v["toolUseResult"]["handbackReport"]["text"].as_str()) {
            if !report.trim().is_empty() {
                scan.handbacks.entry(agent.to_string()).or_insert((idx, report.trim().to_string()));
            }
        }
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks {
            match b["type"].as_str() {
                Some("tool_use") => {
                    let name = b["name"].as_str().unwrap_or("");
                    if let Some(id) = b["id"].as_str() {
                        scan.uses.insert(id.to_string(), idx);
                        scan.use_names.insert(id.to_string(), name.to_string());
                        if SUBAGENT_TOOLS.contains(&name) {
                            scan.agent_uses.push((idx, id.to_string()));
                        }
                    }
                    if git::EDIT_TOOLS.contains(&name) {
                        edits.push((idx, b["id"].as_str().map(str::to_string)));
                    }
                    if matches!(name, "Bash" | "PowerShell") {
                        scan.shell_used = true;
                        if let (Some(cmd), Some(id)) = (b["input"]["command"].as_str(), b["id"].as_str()) {
                            if looks_like_test(cmd) {
                                scan.tests.push((idx, cmd.to_string(), id.to_string()));
                            }
                        }
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = b["tool_use_id"].as_str() {
                        // A hook refusal counts as an error even when the flag is absent.
                        let is_error = git::result_failed(b);
                        scan.results.insert(id.to_string(), (idx, is_error, block_text(&b["content"])));
                    }
                }
                _ => {}
            }
        }
    }
    // A refused or failed edit changed nothing (a read-only sub's guard says no),
    // so only edits that were not turned down move the "last edit" line.
    scan.last_edit = edits
        .iter()
        .filter(|(_, id)| !id.as_deref().and_then(|id| scan.results.get(id)).is_some_and(|(_, failed, _)| *failed))
        .map(|(idx, _)| *idx)
        .max();
    Some(scan)
}

/// The reviewer chip for `reviewer_tool_use_id` read straight from a transcript.
/// The one check for "did a fresh reviewer run on the final code": `compute`
/// uses it for the chip and `finish_subchat` uses it to refuse a finish. `unknown`
/// when the transcript cannot be read.
pub fn reviewer_fact_from_transcript(transcript: &Path, reviewer_tool_use_id: Option<&str>) -> ReviewerFact {
    match scan_transcript(transcript) {
        Some(scan) => scan.reviewer_fact(reviewer_tool_use_id),
        None => ReviewerFact::unknown(),
    }
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

/// The run of ASCII numerals that ends `text`, as a number.
fn trailing_count(text: &str) -> Option<u64> {
    let run: String = text.chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
    run.parse().ok()
}

/// The first number after `needle` in `haystack`, when there is one.
fn number_after(haystack: &str, needle: &str) -> Option<u64> {
    let at = haystack.find(needle)? + needle.len();
    let run: String = haystack[at..].chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
    run.parse().ok()
}

/// Whether `lower` has `<N> <word>` with N above zero ("1 failed", "31 passed").
fn has_nonzero_count_before(lower: &str, word: &str) -> bool {
    let mut rest = lower;
    while let Some(at) = rest.find(word) {
        if trailing_count(&rest[..at]).is_some_and(|n| n > 0) {
            return true;
        }
        rest = &rest[at + word.len()..];
    }
    false
}

/// Whether `output` says something failed. Conservative on purpose: a false
/// "passed" is the bug this exists for, and a false "failed" only costs a look.
fn has_failure_marker(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    if lower.contains("test result: failed")
        || lower.contains("could not compile")
        || lower.contains("panicked at")
        || lower.lines().any(|l| l.trim() == "failures:")
    {
        return true;
    }
    // `FAIL` / `FAILED` opening a line is vitest, jest, pytest and go.
    if output.lines().map(str::trim_start).any(|l| l.starts_with("FAIL") || l.starts_with("--- FAIL")) {
        return true;
    }
    // "N failed" with N above zero ("1 failed", "2 failed | 30 passed").
    if has_nonzero_count_before(&lower, " failed") {
        return true;
    }
    // A non-zero exit code the tool printed ("exit code 1").
    ["exit code", "exited with code", "exit status"].iter().any(|needle| {
        let mut rest = lower.as_str();
        while let Some(at) = rest.find(needle) {
            rest = &rest[at..];
            if number_after(rest, needle).is_some_and(|n| n > 0) {
                return true;
            }
            rest = &rest[needle.len()..];
        }
        false
    })
}

/// Whether `output` says the suite passed.
fn has_pass_marker(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("test result: ok")
        || lower.contains("all tests passed")
        || output.lines().any(|l| l.starts_with("ok ") || l.starts_with("ok\t"))
        || has_nonzero_count_before(&lower, " passed")
}

/// Whether the tool's exit status was the test command's own: one command, or an
/// `&&` chain that ends in it. A pipe reports the last stage's status (`tail`'s),
/// and `;` or `||` report whatever ran last.
fn exit_status_is_the_suites(command: &str) -> bool {
    !command.contains(['|', ';', '\n'])
}

/// A test run's state from its own output, not from the exit status alone.
/// `failed` on the tool's error flag or any failure marker; `passed` on a pass
/// marker or a clean exit that was the suite's own; `unknown` otherwise.
fn judge_test(command: &str, is_error: bool, output: &str) -> &'static str {
    if is_error || has_failure_marker(output) {
        "failed"
    } else if has_pass_marker(output) || exit_status_is_the_suites(command) {
        "passed"
    } else {
        "unknown"
    }
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
            state: judge_test(cmd, *is_error, output).into(),
            command: Some(one_line(cmd, 80)),
            summary: outcome_line(output),
            stale: self.last_edit.is_some_and(|e| e > *idx),
        }
    }

    /// The report a hand-back entry carries for `agent`, when it came after `used_at`.
    fn handback(&self, agent: &str, used_at: usize) -> Option<String> {
        self.handbacks.get(agent).filter(|(at, _)| *at > used_at).map(|(_, report)| report.clone())
    }

    /// What became of the subagent call `id`, which started at line `used_at`.
    /// The tool_result of a subagent that reported through a message is a stub
    /// ("This agent's report was delivered to you as a message ..."), never the
    /// report; the stub is not shown and the real words come from the hand-back.
    fn agent_outcome(&self, id: &str, used_at: usize) -> AgentOutcome {
        match self.results.get(id) {
            None => AgentOutcome::Pending,
            Some((_, true, _)) => AgentOutcome::Failed,
            Some((_, false, text)) if text.trim().is_empty() => AgentOutcome::Failed,
            Some((_, false, text)) => {
                if let Some(agent) = delivered_agent(text) {
                    // The stub says the report was delivered, so the subagent did
                    // return; if the message itself is not in the transcript the
                    // words are unknown, which is still a run.
                    return AgentOutcome::Returned(self.handback(&agent, used_at));
                }
                if let Some(agent) = launched_agent(text) {
                    // A background launch has returned nothing until its hand-back
                    // lands; "ran" with the launch note as its words would be a lie.
                    return match self.handback(&agent, used_at) {
                        Some(report) => AgentOutcome::Returned(Some(report)),
                        None => AgentOutcome::Pending,
                    };
                }
                AgentOutcome::Returned(Some(text.clone()))
            }
        }
    }

    /// The reviewer call to judge when the sub named none: the last subagent call
    /// after the last edit, preferring one that returned (a later call that a
    /// dispatch hook refused is not a review and must not hide an earlier good one).
    fn find_reviewer(&self) -> Result<String, ReviewGap> {
        let Some(last_edit) = self.last_edit else { return Err(ReviewGap::NotNamed) };
        let after: Vec<&(usize, String)> = self.agent_uses.iter().filter(|(at, _)| *at > last_edit).collect();
        let returned = after
            .iter()
            .rev()
            .find(|(at, id)| matches!(self.agent_outcome(id, *at), AgentOutcome::Returned(_)));
        if let Some((_, id)) = returned.or(after.last()) {
            return Ok(id.clone());
        }
        // Subagents ran, but all before the last edit, so none saw the final code.
        Err(if self.agent_uses.is_empty() { ReviewGap::NotNamed } else { ReviewGap::BeforeLastEdit })
    }

    /// The one check for "did a fresh subagent review the code the sub ends
    /// with": `Ok(report words)` when it did, else why not. `explicit` is a
    /// reviewer id the sub passed; without one the daemon finds the call itself.
    fn check_reviewer(&self, explicit: Option<&str>) -> Result<Option<String>, ReviewGap> {
        let id = match explicit {
            Some(id) => id.to_string(),
            None => self.find_reviewer()?,
        };
        let Some(&used_at) = self.uses.get(&id) else { return Err(ReviewGap::NotInTranscript) };
        let name = self.use_names.get(&id).map(String::as_str).unwrap_or("");
        if !SUBAGENT_TOOLS.contains(&name) {
            return Err(ReviewGap::NotASubagent(name.to_string()));
        }
        // A reviewer that read the code before the last edit says nothing about
        // the code that shipped. Level counts as before: an edit and a review
        // started in one assistant message cannot have seen each other.
        if self.last_edit.is_some_and(|e| e >= used_at) {
            return Err(ReviewGap::BeforeLastEdit);
        }
        match self.agent_outcome(&id, used_at) {
            AgentOutcome::Returned(text) => Ok(text),
            AgentOutcome::Pending | AgentOutcome::Failed => Err(ReviewGap::NoResult),
        }
    }

    fn reviewer_fact(&self, explicit: Option<&str>) -> ReviewerFact {
        match self.check_reviewer(explicit) {
            Ok(text) => ReviewerFact { state: "ran".into(), text: text.map(|t| one_line(&t, MAX_REVIEW_TEXT)), note: None },
            Err(gap) => ReviewerFact::none(gap.chip_note()),
        }
    }
}

/// Tool names under which the CLI runs a subagent (`Task` is the older name).
const SUBAGENT_TOOLS: [&str; 2] = ["Agent", "Task"];

/// Why a sub that changed files has not shown a review of its own diff. Each
/// variant maps to a refusal that names its fix (`finish::request_finish`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewGap {
    /// No subagent ran after the last edit (and none was named).
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

impl ReviewGap {
    /// The reason in words a chip can show.
    fn chip_note(&self) -> &'static str {
        match self {
            ReviewGap::NotNamed => "no reviewer ran",
            ReviewGap::NotInTranscript => "the named reviewer run is not in the transcript",
            ReviewGap::NotASubagent(_) => "the named reviewer run is not a subagent call",
            ReviewGap::BeforeLastEdit => "the reviewer ran before the last edit",
            ReviewGap::NoResult => "the reviewer has not returned a result",
        }
    }
}

/// Whether the sub, which edited files, has a fresh subagent's result for its
/// own diff after its last edit. `None` is "nothing owed": the sub made no edit
/// or the review is in order. An unreadable transcript is also `None`, because a
/// finish that can never be accepted would trap the sub, and the chip says
/// "unknown" for it.
///
/// `reviewer_tool_use_id` is optional and normally absent: a model cannot see
/// its own tool_use ids, so the daemon takes the last `Agent`/`Task` call after
/// the last edit. An id that is passed is still checked.
///
/// What this cannot see: whether the subagent really started with no shared
/// context (a subagent resumed from an earlier one, or told to approve, reads
/// the same), and edits made through Bash.
pub fn review_gap(transcript: &Path, reviewer_tool_use_id: Option<&str>) -> Option<ReviewGap> {
    let scan = scan_transcript(transcript)?;
    scan.last_edit?;
    scan.check_reviewer(reviewer_tool_use_id).err()
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
    use super::git::test_repo::{
        fixture_transcript, git as run, init, landed_edit, transcript, BACKGROUND_REVIEWER_FIXTURE, REFUSED_EDIT_FIXTURE,
    };
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
        assert_eq!(review_gap(&tp, None), None, "no id passed: the daemon finds the Agent call after the edit itself");
        let no_agent = edit_then(vec![subagent("r", "Read"), result("r", false, "text")]);
        assert_eq!(review_gap(&no_agent, None), Some(ReviewGap::NotNamed), "a Read is not a reviewer");
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

    fn tool_use(id: &str, name: &str, input: Value) -> Value {
        assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": input}]))
    }

    fn reviewer_with(tool: &str, command_or_empty: &str) -> ReviewerFact {
        let (dir, root) = init();
        let input = if command_or_empty.is_empty() { json!({}) } else { json!({"command": command_or_empty}) };
        let tp = write_transcript(
            dir.path(),
            &[edit("e1", &root.join("base.txt")), tool_use("rev1", tool, input), result("rev1", false, "all fine, nothing found")],
        );
        let mut i = inputs(&root, Some(&tp), None);
        i.reviewer_tool_use_id = Some("rev1");
        compute(&i).reviewer
    }

    #[test]
    fn a_shell_call_named_as_the_reviewer_is_not_a_reviewer() {
        // `echo ok` has an id, comes after the last edit and returns text, which was
        // all the old check asked. A reviewer is a fresh subagent.
        for tool in ["Bash", "PowerShell", "Read", "Edit"] {
            let r = reviewer_with(tool, "echo ok");
            assert_eq!(r.state, "none", "{tool} is not a subagent: {r:?}");
            assert!(r.note.unwrap().contains("not a subagent"), "the chip says why");
        }
        assert_eq!(reviewer_with("Agent", "").state, "ran", "the Agent tool is a subagent");
        assert_eq!(reviewer_with("Task", "").state, "ran", "an older CLI calls it Task");
    }

    #[test]
    fn the_shared_reviewer_check_reads_the_transcript_the_same_way() {
        let (dir, root) = init();
        let tp = write_transcript(
            dir.path(),
            &[
                edit("e1", &root.join("base.txt")),
                tool_use("sh", "Bash", json!({"command": "echo ok"})),
                result("sh", false, "ok"),
                tool_use("ag", "Agent", json!({"prompt": "review"})),
                result("ag", false, "No problems."),
            ],
        );
        assert_eq!(reviewer_fact_from_transcript(&tp, Some("sh")).state, "none");
        assert_eq!(reviewer_fact_from_transcript(&tp, Some("ag")).state, "ran");
        assert_eq!(reviewer_fact_from_transcript(&tp, None).state, "ran", "the Agent call after the edit is found without an id");
        assert_eq!(reviewer_fact_from_transcript(&dir.path().join("missing.jsonl"), Some("ag")).state, "unknown");
    }

    /// First real run: a read-only sub's only Edit was refused by the write guard,
    /// and the finish gate still said "you changed files". A refused edit is not one.
    #[test]
    fn a_refused_edit_is_not_the_last_edit_so_no_review_is_owed() {
        let (dir, root) = init();
        // The file exists and is untracked, as it would be had the Edit landed.
        std::fs::write(root.join("index.html"), "x").unwrap();
        // The fixture's first two lines: the Edit and the guard's refusal.
        let tp = fixture_transcript(dir.path(), REFUSED_EDIT_FIXTURE, &root.join("index.html"), 2, &[], false);
        assert_eq!(review_gap(&tp, None), None, "nothing was changed, so nothing is owed");
        let f = compute(&inputs(&root, Some(&tp), None));
        assert_eq!(f.uncommitted, Some(0), "the refused file is not the sub's uncommitted work");
        assert_eq!(f.reviewer.note.as_deref(), Some("no reviewer ran"));
        // The same Edit with a landed result is an edit, and then a review is owed.
        let landed = write_transcript(dir.path(), &landed_edit("e1", &root.join("index.html")));
        assert_eq!(review_gap(&landed, None), Some(ReviewGap::NotNamed));
    }

    /// An edit that failed for any reason (a stale `old_string`) changed nothing either.
    #[test]
    fn an_edit_that_errored_does_not_move_the_last_edit_line() {
        let (dir, root) = init();
        let tp = write_transcript(
            dir.path(),
            &[
                assistant(json!([{"type": "tool_use", "id": "rev", "name": "Agent", "input": {}}])),
                result("rev", false, "No problems."),
                edit("e1", &root.join("base.txt")),
                result("e1", true, "String to replace not found in file"),
            ],
        );
        // The review came before the only edit attempt, which did not land.
        assert_eq!(review_gap(&tp, None), None);
    }

    /// The model cannot see its own tool_use ids, so the daemon takes the last
    /// subagent call after the last edit, and a later call a dispatch hook refused
    /// does not hide an earlier good one.
    #[test]
    fn the_reviewer_is_the_last_subagent_call_after_the_last_edit_without_any_id() {
        let (dir, root) = init();
        let agent = |id: &str| assistant(json!([{"type": "tool_use", "id": id, "name": "Agent", "input": {}}]));
        let tp = write_transcript(
            dir.path(),
            &[
                agent("before"),
                result("before", false, "old review of old code"),
                edit("e1", &root.join("base.txt")),
                agent("good"),
                result("good", false, "Found 1 problem: the loop never exits."),
                agent("refused"),
                result("refused", true, "PreToolUse:Agent hook error: dispatch-preamble-guard"),
            ],
        );
        assert_eq!(review_gap(&tp, None), None);
        let r = reviewer_fact_from_transcript(&tp, None);
        assert_eq!(r.state, "ran");
        assert!(r.text.unwrap().starts_with("Found 1 problem"), "the good call after the edit, not the refused one");
        // An id that is passed is still checked.
        assert_eq!(review_gap(&tp, Some("ghost")), Some(ReviewGap::NotInTranscript));
        assert_eq!(review_gap(&tp, Some("before")), Some(ReviewGap::BeforeLastEdit));
        // Only a refused call after the edit: not a review.
        let only_refused = write_transcript(
            dir.path(),
            &[edit("e1", &root.join("base.txt")), agent("refused"), result("refused", true, "PreToolUse:Agent hook error: x")],
        );
        assert_eq!(review_gap(&only_refused, None), Some(ReviewGap::NoResult));
        // Subagents ran, but all before the last edit.
        let early = write_transcript(dir.path(), &[agent("a"), result("a", false, "ok"), edit("e1", &root.join("base.txt"))]);
        assert_eq!(review_gap(&early, None), Some(ReviewGap::BeforeLastEdit));
    }

    /// First real run: a foreground subagent's tool_result is "This agent's report was
    /// delivered to you as a message from ...", and the chip showed that as the
    /// reviewer's words. The words are the hand-back entry; the stub is never shown.
    #[test]
    fn a_reviewer_chip_shows_the_handed_back_report_never_the_delivery_stub() {
        let (dir, root) = init();
        let file = root.join("index.html");
        let tp = fixture_transcript(dir.path(), REFUSED_EDIT_FIXTURE, &file, 8, &landed_edit("e0", &file), false);
        let r = reviewer_fact_from_transcript(&tp, None);
        assert_eq!(r.state, "ran");
        let text = r.text.expect("the hand-back words");
        assert!(text.contains("git status --short") && text.contains("printed nothing"), "{text}");
        assert!(!text.contains("delivered to you") && !text.contains("Read it there"), "the stub is noise: {text}");
        // The report entry is missing from the transcript: still a run (the stub says it
        // was delivered), with no words rather than the stub's.
        let stub_only = fixture_transcript(dir.path(), REFUSED_EDIT_FIXTURE, &file, 8, &landed_edit("e0", &file), true);
        let r = reviewer_fact_from_transcript(&stub_only, None);
        assert_eq!((r.state.as_str(), r.text), ("ran", None));
        assert_eq!(review_gap(&stub_only, None), None);
    }

    /// A background reviewer's report arrives after its launch note. Until then it has
    /// not run: counting it would let a sub finish on a review nobody has read.
    #[test]
    fn a_background_reviewer_counts_only_once_its_report_came_back() {
        let (dir, root) = init();
        let file = root.join("index.html");
        let done = fixture_transcript(dir.path(), BACKGROUND_REVIEWER_FIXTURE, &file, 4, &landed_edit("e0", &file), false);
        let r = reviewer_fact_from_transcript(&done, None);
        assert_eq!(r.state, "ran");
        let text = r.text.unwrap();
        assert!(text.starts_with("None found. Commit 1e739f2"), "{text}");
        assert!(!text.contains("Async agent launched"), "{text}");
        assert_eq!(review_gap(&done, None), None);
        // Only the launch: no hand-back yet.
        let pending = fixture_transcript(dir.path(), BACKGROUND_REVIEWER_FIXTURE, &file, 2, &landed_edit("e0", &file), false);
        let r = reviewer_fact_from_transcript(&pending, None);
        assert_eq!(r.state, "none", "a launch is not a review");
        assert!(r.text.is_none() && r.note.as_deref().unwrap().contains("has not returned"), "{r:?}");
        assert_eq!(review_gap(&pending, None), Some(ReviewGap::NoResult));
        // The same through the explicit id.
        assert_eq!(review_gap(&pending, Some("toolu_012WiDJwoK5rsMK59Ka8xWLR")), Some(ReviewGap::NoResult));
    }

    fn test_state_of(cmd: &str, is_error: bool, output: &str) -> TestFact {
        let (dir, root) = init();
        let tp = write_transcript(dir.path(), &[shell("t1", cmd), result("t1", is_error, output)]);
        compute(&inputs(&root, Some(&tp), None)).test
    }

    #[test]
    fn a_failing_suite_run_through_a_pipe_is_failed_not_passed() {
        let t = test_state_of(
            "cargo test --lib 2>&1 | tail -5",
            false,
            "running 12 tests\ntest result: FAILED. 11 passed; 1 failed; 0 ignored",
        );
        assert_eq!(t.state, "failed", "the exit status was tail's, the summary line is the truth: {t:?}");
        assert!(t.summary.unwrap().contains("FAILED"));
        for output in [
            "Test Files  1 failed | 4 passed (5)\n      Tests  2 failed | 30 passed (32)",
            " FAIL  tests/a.test.mjs > it works\nAssertionError",
            "failures:\n    a::b\n",
            "error: could not compile `app` due to 2 previous errors",
            "thread 'x' panicked at src/lib.rs:1:1",
            "Process finished with exit code 1",
        ] {
            assert_eq!(test_state_of("pnpm vitest run | tail -20", false, output).state, "failed", "{output}");
        }
    }

    #[test]
    fn passed_needs_a_pass_marker_or_a_clean_unpiped_exit() {
        let ok = "running 4 tests\ntest result: ok. 4 passed; 0 failed; 0 ignored";
        assert_eq!(test_state_of("cargo test --lib 2>&1 | tail -5", false, ok).state, "passed", "a pass marker, even through a pipe");
        assert_eq!(test_state_of("pnpm vitest run | tail", false, "Tests  31 passed (31)").state, "passed");
        assert_eq!(test_state_of("cargo test --lib", false, "").state, "passed", "unpiped, exit 0");
        assert_eq!(test_state_of("cd app && cargo test", false, "").state, "passed", "&& keeps the test's own status");
        // The exit status was some other command's, or no output says anything.
        assert_eq!(test_state_of("cargo test --lib 2>&1 | tail -5", false, "").state, "unknown");
        assert_eq!(test_state_of("cargo test --lib 2>&1 | tail -5", false, "Finished dev profile").state, "unknown");
        assert_eq!(test_state_of("cargo test --lib; echo done", false, "done").state, "unknown", "echo's status, not the suite's");
        assert_eq!(test_state_of("cargo test --lib || true", false, "").state, "unknown");
        // A zero failure count is not a failure.
        assert_eq!(test_state_of("cargo test", false, "test result: ok. 12 passed; 0 failed").state, "passed");
        assert_eq!(test_state_of("cargo test", true, "test result: ok. 12 passed").state, "failed", "the tool's own error flag still wins");
    }

    #[test]
    fn a_sub_that_edited_nothing_is_not_credited_with_a_peers_commit() {
        let (dir, root) = init();
        let base = git::head(&root).unwrap();
        commit_file(&root, "peers.txt", "p\n");
        // Only reads and a shell call: no Edit or Write to scope the range by.
        let tp = write_transcript(dir.path(), &[shell("s1", "ls"), result("s1", false, "a b")]);
        let f = compute(&inputs(&root, Some(&tp), Some(&base)));
        assert_eq!((f.commits, f.files_changed, f.insertions, f.deletions), (None, None, None, None));
        assert!(!f.scoped);
        assert!(f.commits_note.as_deref().unwrap().contains("another chat"), "{:?}", f.commits_note);
        // No transcript at all is the same: nothing says which commits were its own.
        let f = compute(&inputs(&root, None, Some(&base)));
        assert_eq!(f.commits, None);
        assert!(f.commits_note.is_some());
    }

    #[test]
    fn a_shell_only_sub_shows_uncommitted_as_unknown_not_a_green_zero() {
        let (dir, root) = init();
        std::fs::write(root.join("by-shell.txt"), "written by sed -i or a redirect").unwrap();
        let tp = write_transcript(dir.path(), &[shell("s1", "echo x > by-shell.txt"), result("s1", false, "")]);
        let f = compute(&inputs(&root, Some(&tp), None));
        assert_eq!(f.uncommitted, None);
        assert!(f.uncommitted_note.as_deref().unwrap().contains("only used the shell"), "{:?}", f.uncommitted_note);
        // A sub that ran no shell and edited nothing is a plain zero.
        let tp = write_transcript(dir.path(), &[tool_use("r1", "Read", json!({"file_path": "x"})), result("r1", false, "x")]);
        assert_eq!(compute(&inputs(&root, Some(&tp), None)).uncommitted, Some(0));
        // Edit-tool edits make the count trustworthy even when the sub also used the shell.
        let tp = write_transcript(dir.path(), &[shell("s1", "ls"), result("s1", false, ""), edit("e1", &root.join("by-shell.txt"))]);
        assert_eq!(compute(&inputs(&root, Some(&tp), None)).uncommitted, Some(1));
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
