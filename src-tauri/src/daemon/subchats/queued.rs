//! What Joe can do to a queued sub from its menu on the dashboard: start it now,
//! or drop it. "Queued" means the daemon holds the sub without a child (`held`):
//! it waits for the sub named in `after`, for the writer slot, or for its worktree.
//! A sub that already started is not queued, so both actions refuse it.

use super::{held, writers};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// The name Joe sees for `sub_id`, for the messages below.
fn name_of(state: &DaemonState, sub_id: &str) -> String {
    state.registry.get(sub_id).map(|i| super::tool::label(&i)).unwrap_or_else(|| sub_id.chars().take(8).collect())
}

/// Checks that `sub_id` is a live sub the daemon is holding without a child.
fn check_queued(state: &DaemonState, sub_id: &str) -> Result<(), String> {
    let inst = state.registry.get(sub_id).ok_or_else(|| format!("unknown session: {sub_id}"))?;
    if !super::is_sub(&inst) {
        return Err(format!("{} is not a sub.", name_of(state, sub_id)));
    }
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(format!("{} has already ended.", name_of(state, sub_id)));
    }
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    if !held::never_started(state, &inst, &has) {
        return Err(format!(
            "{} has started, so it is not queued: only a sub that never ran can be dropped or started now. Ask Joe to end it from its card or the chat menu.",
            name_of(state, sub_id)
        ));
    }
    Ok(())
}

/// Ends a sub that never started, for a job nobody wants any more. It ran nothing, so
/// nothing is lost, and it stops counting toward the cap. Returns its name. This is
/// `subchat drop`, shared with Joe's menu.
pub fn drop_now(state: &Arc<DaemonState>, sub_id: &str) -> Result<String, String> {
    check_queued(state, sub_id)?;
    let name = name_of(state, sub_id);
    held::drop_held(state, sub_id);
    Ok(name)
}

/// Starts a held sub's child at once, in its own worktree when it has one, without
/// waiting for the sub it was told to follow or for its turn in the writer queue.
/// A writer on the shared checkout that starts ahead of the slot is not unsafe: its
/// first edit is refused and queues it, as for any sub that lost the slot. A failed
/// start changes nothing (it stays held, in line and parked as it was) and says why.
pub async fn start_now(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), String> {
    check_queued(state, sub_id)?;
    held::launch_held(state, sub_id).await?;
    // Only once it runs: out of the line, or the queue would start it a second time
    // when its turn came. Doing this first would need a way back into the line on
    // failure, and putting it back re-queues every other parked sub with it.
    writers::skip_queue(state, sub_id);
    held::set_parked(sub_id, false);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::held::{Held, LaunchSpec};
    use crate::daemon::subchats::{store_sub_brief, TempDataDir};
    use crate::types::Settings;
    use std::path::Path;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A sub held behind `after`, registered and held the way `spawn_chat` leaves it.
    fn queued_sub(st: &DaemonState, tag: &str) -> String {
        let (main, id) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, Path::new("."), "proj", "2026-11-12T00:00:00Z");
        st.registry.upsert_interactive(&id, Path::new("."), "proj", "2026-11-12T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(main.clone()));
        st.registry.set_name(&id, tag.to_string());
        store_sub_brief(&id, &main);
        held::hold(
            st,
            Held {
                sub_id: id.clone(),
                reason: "waiting for header".into(),
                after: Some(format!("{tag}-target")),
                after_name: "header".into(),
                launch: LaunchSpec { cwd: Path::new(".").to_path_buf(), first_message: "go".into(), ..LaunchSpec::default() },
            },
        )
        .unwrap();
        id
    }

    #[tokio::test]
    async fn dropping_a_queued_sub_ends_it_without_running_it_and_refuses_one_that_ran() {
        let _data = TempDataDir::new();
        let st = state();
        let id = queued_sub(&st, "qd-drop");
        assert_eq!(drop_now(&st, &id).unwrap(), "qd-drop");
        assert!(st.registry.get(&id).unwrap().ended_at.is_some());
        assert!(!held::is_held(&id), "its recipe is forgotten, so it can never start later");
        assert!(drop_now(&st, &id).unwrap_err().contains("already ended"));

        let ran = format!("qd-drop-ran-sub");
        st.registry.upsert_interactive(&ran, Path::new("."), "proj", "2026-11-12T00:00:00Z");
        st.registry.set_subchat_of(&ran, Some("qd-drop-main".into()));
        st.registry.set_busy(&ran, true);
        assert!(drop_now(&st, &ran).unwrap_err().contains("has started"));
        assert!(st.registry.get(&ran).unwrap().ended_at.is_none());
    }

    #[tokio::test]
    async fn starting_a_queued_sub_refuses_one_that_is_not_held_or_not_a_sub_and_leaves_a_held_one_held_when_the_launch_fails() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("qd-plain", Path::new("."), "proj", "2026-11-12T00:00:00Z");
        assert!(start_now(&st, "qd-plain").await.unwrap_err().contains("not a sub"));
        assert!(start_now(&st, "qd-ghost").await.unwrap_err().contains("unknown session"));

        // The launch has no `claude` to run in a unit test, so it fails; the sub
        // must still be held (and parked is cleared) rather than lost.
        let id = queued_sub(&st, "qd-start");
        held::set_parked(&id, true);
        assert!(start_now(&st, &id).await.is_err());
        assert!(held::is_held(&id), "a failed start keeps the sub queued so Try again still works");
        assert!(st.registry.get(&id).unwrap().ended_at.is_none());
    }
}
