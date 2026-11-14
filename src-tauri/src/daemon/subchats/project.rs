//! A sub's project settings: how its work is checked. Read from the settings
//! snapshot at the moment of use, so a change Joe makes in the project's
//! settings applies to the next finish without a restart.

use crate::daemon::state::DaemonState;
use crate::settings::identity::project_key;
use crate::types::{ProjectConfig, SubchatCheck};
use std::path::Path;

/// The configured project that `cwd` belongs to, rolled up through `project_key`
/// so a worktree or subfolder of a registered project still finds it.
pub fn config_for(state: &DaemonState, cwd: &Path) -> Option<ProjectConfig> {
    let key = project_key(cwd);
    state.settings.snapshot().projects.into_iter().find(|p| project_key(&p.path) == key)
}

/// "Check a sub's work" for the project `cwd` is in. A project with no config
/// row uses the default, which is the stricter one.
pub fn check_mode(state: &DaemonState, cwd: &Path) -> SubchatCheck {
    config_for(state, cwd).map(|p| p.subchat_check).unwrap_or_default()
}

/// Whether a sub that changed files owes a fresh-reviewer run before it can
/// finish: the project asks for one and the brief did not opt out (`review:
/// false` is for a purely visual job, where Joe's stamp is the check).
///
/// A gate sub is exempt too: it runs a push, edits nothing of its own and has no
/// diff to review.
pub fn review_required(check: SubchatCheck, brief: Option<&super::SubchatBrief>) -> bool {
    check == SubchatCheck::FactsAndReviewer && brief.map_or(true, |b| b.review && !b.gate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn brief(review: bool) -> super::super::SubchatBrief {
        serde_json::from_str(&format!(r#"{{"parent":"m","review":{review}}}"#)).unwrap()
    }

    #[test]
    fn a_reviewer_is_owed_only_when_the_project_and_the_brief_both_ask_for_one() {
        assert!(review_required(SubchatCheck::FactsAndReviewer, Some(&brief(true))));
        assert!(review_required(SubchatCheck::FactsAndReviewer, None), "a missing brief is the strict default");
        assert!(!review_required(SubchatCheck::FactsOnly, Some(&brief(true))), "facts only turns it off");
        assert!(!review_required(SubchatCheck::FactsAndReviewer, Some(&brief(false))), "review: false turns it off");
        let mut gate = brief(true);
        gate.gate = true;
        assert!(!review_required(SubchatCheck::FactsAndReviewer, Some(&gate)), "a gate sub has no diff of its own to review");
    }

    #[test]
    fn a_project_without_a_config_row_gets_the_defaults() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert_eq!(check_mode(&st, Path::new("C:/nowhere-at-all")), SubchatCheck::FactsAndReviewer);
    }

    /// A stored `check_mode` is read back for a path inside the project. The row
    /// also carries the retired `subchat_writers` value, which must still parse.
    #[test]
    fn a_stored_choice_is_read_back_for_a_path_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        let raw = serde_json::json!({
            "id": "p1", "path": dir.path(), "name": "p", "created_at": "2026-11-05T00:00:00Z",
            "subchat_check": "facts_only", "subchat_writers": "worktree_each",
        });
        settings.projects.push(serde_json::from_value::<ProjectConfig>(raw).unwrap());
        let st = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        assert_eq!(check_mode(&st, dir.path()), SubchatCheck::FactsOnly);
    }
}
