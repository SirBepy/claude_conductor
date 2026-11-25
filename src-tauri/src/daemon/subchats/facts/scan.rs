//! The transcript side of the facts: one pass over a sub's transcript
//! ([`scan_transcript`]), the judging of its test runs and the reviewer check.

use super::{git, ReviewerFact, TestFact};
use crate::util::text::flat_clip;
use serde_json::Value;
use std::path::Path;

const MAX_REVIEW_TEXT: usize = 240;
const MAX_SUMMARY: usize = 140;

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

/// Whether a shell command runs `git push` (not a dry run). Matches the START of
/// each `&&`/`;`/`|`/newline separated segment, like [`looks_like_test`].
pub(super) fn looks_like_push(command: &str) -> bool {
    command.split(['\n', ';', '|', '&']).map(str::trim).any(|seg| {
        let words: Vec<&str> = seg.split_whitespace().skip_while(|w| w.contains('=') && !w.starts_with('-')).collect();
        // `git -C <dir> push` names the directory before the subcommand.
        let sub = match words.as_slice() {
            ["git", "-C", _, sub, ..] | ["git", sub, ..] => *sub,
            _ => return false,
        };
        sub == "push" && !words.iter().any(|w| *w == "--dry-run" || *w == "-n")
    })
}

/// One pass over a transcript: where the last edit sits, every test-looking
/// shell call with its outcome, and every tool result by id.
pub(super) struct Scan {
    last_edit: Option<usize>,
    /// Every edit that landed, in transcript order: the input of the "is this
    /// edit worth a new review" rule ([`Scan::material_edit_since`]).
    landed: Vec<LandedEdit>,
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
    pub(super) shell_used: bool,
    /// tool_use ids of shell calls that run `git push`; whether one succeeded is
    /// read from `results`.
    pushes: Vec<String>,
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

pub(super) fn scan_transcript(path: &Path) -> Option<Scan> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut scan = Scan {
        last_edit: None,
        landed: Vec::new(),
        tests: Vec::new(),
        results: std::collections::HashMap::new(),
        uses: std::collections::HashMap::new(),
        use_names: std::collections::HashMap::new(),
        shell_used: false,
        pushes: Vec::new(),
        agent_uses: Vec::new(),
        handbacks: std::collections::HashMap::new(),
    };
    // (line index, tool_use id) of every edit call. Whether it counts depends on
    // its result, which comes later, so the last real edit is settled after the pass.
    let mut edits: Vec<(usize, Option<String>, LandedEdit)> = Vec::new();
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
                        edits.push((idx, b["id"].as_str().map(str::to_string), LandedEdit::of(idx, name, &b["input"])));
                    }
                    if matches!(name, "Bash" | "PowerShell") {
                        scan.shell_used = true;
                        if let (Some(cmd), Some(id)) = (b["input"]["command"].as_str(), b["id"].as_str()) {
                            if looks_like_test(cmd) {
                                scan.tests.push((idx, cmd.to_string(), id.to_string()));
                            }
                            if looks_like_push(cmd) {
                                scan.pushes.push(id.to_string());
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
    let landed: Vec<LandedEdit> = edits
        .into_iter()
        .filter(|(_, id, _)| !id.as_deref().and_then(|id| scan.results.get(id)).is_some_and(|(_, failed, _)| *failed))
        .map(|(_, _, e)| e)
        .collect();
    scan.last_edit = landed.iter().map(|e| e.at).max();
    scan.landed = landed;
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
        .map(|l| flat_clip(l, MAX_SUMMARY))
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
    /// A `git push` call that came back without an error.
    pub(super) fn ran_push(&self) -> bool {
        self.pushes.iter().any(|id| self.results.get(id).is_some_and(|(_, failed, _)| !*failed))
    }

    pub(super) fn test_fact(&self) -> TestFact {
        // The last test-looking call that actually returned: one still running
        // when the transcript was read has no result and proves nothing.
        let Some((idx, cmd, id)) = self.tests.iter().rev().find(|(_, _, id)| self.results.contains_key(id)) else {
            return TestFact::unknown();
        };
        let (_, is_error, output) = &self.results[id];
        TestFact {
            state: judge_test(cmd, *is_error, output).into(),
            command: Some(flat_clip(cmd, 80)),
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
    /// whose review still holds (no material edit began at or after it, see
    /// [`Scan::material_edit_since`]), preferring one that returned (a later call
    /// that a dispatch hook refused is not a review and must not hide an earlier
    /// good one).
    fn find_reviewer(&self) -> Result<String, ReviewGap> {
        if self.last_edit.is_none() {
            return Err(ReviewGap::NotNamed);
        }
        let standing: Vec<&(usize, String)> =
            self.agent_uses.iter().filter(|(at, _)| !self.material_edit_since(*at)).collect();
        let returned = standing
            .iter()
            .rev()
            .find(|(at, id)| matches!(self.agent_outcome(id, *at), AgentOutcome::Returned(_)));
        if let Some((_, id)) = returned.or(standing.last()) {
            return Ok(id.clone());
        }
        // Subagents ran, but each is followed by an edit worth a new review.
        Err(if self.agent_uses.is_empty() { ReviewGap::NotNamed } else { ReviewGap::BeforeLastEdit })
    }

    /// Whether an edit that landed at or after transcript line `at` is worth a
    /// new review of the code a reviewer started there. Each edit that is not
    /// documentation counts toward a total of [`TRIVIAL_EDIT_LINES`] changed
    /// lines, and each must name a file the sub had already edited before `at`
    /// (so a reviewer saw it). Material, hence a new review: a new file, a
    /// notebook, a Write, an Edit with `replace_all`, an edit whose size the
    /// transcript does not show, an edit in the reviewer's own assistant message
    /// (the two cannot have seen each other), or edits past the total. A
    /// documentation file (`.md`, `.mdx`, `.rst`) is never material, whatever its
    /// size; a code file under a `docs/` folder is code.
    fn material_edit_since(&self, at: usize) -> bool {
        let mut lines = 0usize;
        for e in self.landed.iter().filter(|e| e.at >= at) {
            if e.is_doc() {
                continue;
            }
            // Level with the reviewer: the two cannot have seen each other.
            if e.at == at {
                return true;
            }
            let reviewed = self.landed.iter().any(|b| b.at < at && b.path == e.path);
            match e.lines {
                Some(n) if reviewed => lines += n,
                _ => return true,
            }
            if lines > TRIVIAL_EDIT_LINES {
                return true;
            }
        }
        false
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
        // A reviewer that read the code before a material edit says nothing about
        // the code that shipped; a small edit after it leaves its review standing.
        if self.material_edit_since(used_at) {
            return Err(ReviewGap::BeforeLastEdit);
        }
        match self.agent_outcome(&id, used_at) {
            AgentOutcome::Returned(text) => Ok(text),
            AgentOutcome::Pending | AgentOutcome::Failed => Err(ReviewGap::NoResult),
        }
    }

    pub(super) fn reviewer_fact(&self, explicit: Option<&str>) -> ReviewerFact {
        match self.check_reviewer(explicit) {
            Ok(text) => ReviewerFact { state: "ran".into(), text: text.map(|t| flat_clip(&t, MAX_REVIEW_TEXT)), note: None },
            Err(gap) => ReviewerFact::none(gap.chip_note()),
        }
    }
}

/// How many changed lines (old plus new text of each edit) after a review still
/// leave it standing, so a one-line fix or a renamed identifier does not buy a
/// second full review. Measured on 108 sub transcripts that ran a reviewer
/// (docs/architecture/subchats.md, "Usage levers"): 24 is about twelve modified lines.
pub const TRIVIAL_EDIT_LINES: usize = 24;

/// One edit that landed: where it sits, which file it names and how many lines
/// its text changes (`None` when the input does not show it).
struct LandedEdit {
    at: usize,
    path: String,
    lines: Option<usize>,
}

impl LandedEdit {
    fn of(at: usize, tool: &str, input: &Value) -> Self {
        let count = |v: &Value| v.as_str().map_or(0, |s| s.lines().count());
        let path = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str()).unwrap_or("");
        let lines = match tool {
            // `replace_all` rewrites an unbounded number of sites, and a Write replaces a
            // file whose old size the transcript does not show, so neither is sized.
            "Edit" if input["old_string"].is_string() && input["new_string"].is_string() && input["replace_all"].as_bool() != Some(true) => {
                Some(count(&input["old_string"]) + count(&input["new_string"]))
            }
            // Every part must show both texts and none may be `replace_all`, or the
            // whole call is unsized.
            "MultiEdit" => input["edits"]
                .as_array()
                .filter(|a| {
                    !a.is_empty()
                        && a.iter().all(|e| {
                            e["old_string"].is_string() && e["new_string"].is_string() && e["replace_all"].as_bool() != Some(true)
                        })
                })
                .map(|a| a.iter().map(|e| count(&e["old_string"]) + count(&e["new_string"])).sum()),
            _ => None,
        };
        LandedEdit { at, path: git::path_key(path), lines }
    }

    fn is_doc(&self) -> bool {
        let path = self.path.to_ascii_lowercase();
        [".md", ".mdx", ".rst"].iter().any(|ext| path.ends_with(ext))
    }
}

/// Tool names under which the CLI runs a subagent (`Task` is the older name).
const SUBAGENT_TOOLS: [&str; 2] = ["Agent", "Task"];

/// Why a sub that changed files has not shown a review of its own diff. Each
/// variant maps to a refusal that names its fix (`finish::request_finish`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewGap {
    /// No subagent ran whose review still stands (and none was named).
    NotNamed,
    /// The id matches no tool call in the transcript.
    NotInTranscript,
    /// The id names a call to this tool, which is not a subagent.
    NotASubagent(String),
    /// The subagent started at or before an edit that is worth a new review (see
    /// `Scan::material_edit_since`), so it read older code.
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
            ReviewGap::BeforeLastEdit => "the reviewer ran before a material edit",
            ReviewGap::NoResult => "the reviewer has not returned a result",
        }
    }
}

/// Whether the sub, which edited files, has a fresh subagent's result for its
/// own diff that still stands (no material edit since, `Scan::material_edit_since`). `None` is "nothing owed": the sub made no edit
/// or the review is in order. An unreadable transcript is also `None`, because a
/// finish that can never be accepted would trap the sub, and the chip says
/// "unknown" for it.
///
/// `reviewer_tool_use_id` is optional and normally absent: a model cannot see
/// its own tool_use ids, so the daemon takes the last `Agent`/`Task` call whose
/// review still stands. An id that is passed is still checked.
///
/// What this cannot see: whether the subagent really started with no shared
/// context (a subagent resumed from an earlier one, or told to approve, reads
/// the same), and edits made through Bash.
pub fn review_gap(transcript: &Path, reviewer_tool_use_id: Option<&str>) -> Option<ReviewGap> {
    let scan = scan_transcript(transcript)?;
    scan.last_edit?;
    scan.check_reviewer(reviewer_tool_use_id).err()
}
