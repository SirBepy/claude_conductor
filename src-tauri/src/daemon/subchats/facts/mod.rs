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
//! `Task` tool_use (`SUBAGENT_TOOLS` in `scan`), read by [`reviewer_fact_from_transcript`] for
//! the chip and by [`review_gap`] for the finish check.
//!
//! A continued sub's second finish counts SINCE ITS PREVIOUS REPORT, not since
//! spawn: Joe is reading the new card for what changed this round, and the
//! earlier card already stated the earlier work. The chip words say "since its
//! last report" so the two are never mistaken for each other.

use super::git;
use serde::{Deserialize, Serialize};
use std::path::Path;

mod scan;
mod sum;
#[cfg(test)]
mod tests;

pub use scan::{looks_like_test, review_gap, reviewer_fact_from_transcript, ReviewGap};
pub use sum::{sum, SumFacts};
use scan::{scan_transcript, Scan};

/// What a count is measured from, in the chip's own words.
pub const SINCE_SPAWN: &str = "spawn";
pub const SINCE_LAST_REPORT: &str = "last report";

const MAX_FILES_NAMED: usize = 6;

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
/// `head`. With no upstream tracking ref at either end (a branch pushed without
/// `-u`), the remote is asked for its copy of the branch instead, and a tip that
/// is `head` says pushed only when the gate also ran a `git push` that succeeded
/// (`ran_push`): the remote could have held `head` before the gate started, and
/// then "pushed" would credit the gate with work somebody else did. `None` when
/// that cannot say either (no remote, branch not on it, remote unreachable, a tip
/// that is `head` with no push of the gate's own to explain it), because "not
/// pushed" would then be a guess.
fn gate_pushed(cwd: &Path, base: &GateBase, head: &str, ran_push: bool) -> Option<bool> {
    let (Some(before), Some(now)) = (base.upstream_before, git::upstream(cwd)) else {
        return (ran_push && git::remote_branch_tip(cwd)? == head).then_some(true);
    };
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
        let ran_push = scan.as_ref().is_some_and(Scan::ran_push);
        facts.pushed = gate_pushed(i.cwd, gate, head, ran_push);
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
