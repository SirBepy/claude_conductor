use super::Facts;
use serde::{Deserialize, Serialize};

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
    /// Worktree subs whose commits did not land in the target branch. Their
    /// commits and files are left out of the totals above, since the totals say
    /// what is in the branch.
    #[serde(default)]
    pub not_merged: u32,
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
        if f.merged == Some(false) {
            s.not_merged += 1;
        } else {
            match (f.commits, f.files_changed) {
                (Some(c), Some(n)) => {
                    s.commits += c;
                    s.files_changed += n;
                }
                _ => s.unknown_subs += 1,
            }
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
