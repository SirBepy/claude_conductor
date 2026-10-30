//! Boot-time adoption of already-running plain `claude` processes as External
//! registry entries, so a daemon restart doesn't drop them from the sidebar.

use std::sync::Arc;

use crate::daemon::state::DaemonState;

/// Re-track already-running external `claude` sessions into the registry on
/// daemon (re)start. Without this, a daemon restart boots with an empty
/// registry and external terminal sessions don't reappear in the sidebar until
/// each one fires a fresh SessionStart hook (which they never do for sessions
/// that were already running before the daemon restarted).
///
/// `--remote-control` bridge processes are skipped.
///
/// Both data sources this scan reads are machine-wide, not scoped to this
/// daemon: `sessions_dir()` is the single shared `~/.claude/sessions` (see
/// its own multi-account-audit comment), and `sys.refresh_processes_specifics`
/// enumerates every process on the box. A non-default instance (a test/phone
/// daemon spun up with `CC_DAEMON_INSTANCE` + a scratch `CC_DATA_DIR`) has no
/// way to tell "my session" apart from a real terminal session belonging to
/// the production daemon or another tool, so it must not run this scan at
/// all - see `should_adopt_external`.
pub fn adopt_external_sessions(state: Arc<DaemonState>) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    if !should_adopt_external(&crate::daemon::instance::instance_suffix()) {
        log::debug!(
            "adopt_external_sessions: skipped for non-default instance (would scan machine-wide processes/sessions)"
        );
        return;
    }

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );

    // Build live_processes map (pid -> process start time in unix-epoch seconds)
    // for scan_live_sessions's pid-reuse defense.
    let live_processes: std::collections::HashMap<u32, u64> = sys
        .processes()
        .values()
        .map(|p| (p.pid().as_u32(), p.start_time()))
        .collect();

    // Pids of `--remote-control` bridges and the daemon itself - skip them.
    let skip_pids: std::collections::HashSet<u32> = sys
        .processes()
        .values()
        .filter(|p| {
            let args: Vec<String> =
                p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            args.iter().any(|a| a == "--remote-control")
                || args.iter().any(|a| a == "--daemon")
        })
        .map(|p| p.pid().as_u32())
        .collect();

    let known_ids: std::collections::HashSet<String> =
        state.registry.known_session_ids().into_iter().collect();

    let live_sessions = crate::hooks::session_files::scan_live_sessions(&live_processes);

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let mut adopted_count = 0usize;
    for sess in live_sessions {
        if skip_pids.contains(&sess.pid) {
            continue;
        }
        if known_ids.contains(&sess.session_id) {
            continue;
        }

        let (_, _) = state.settings.upsert_project_for_cwd(&sess.cwd, &now);
        let snapshot = state.settings.snapshot();
        let shim = std::sync::Mutex::new(snapshot);

        let started_at = chrono::DateTime::from_timestamp_millis(sess.started_at_ms)
            .map(|dt: chrono::DateTime<chrono::Utc>| {
                dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            })
            .unwrap_or_else(|| now.clone());

        let input = crate::sessions::registry::RegisterInput {
            session_id: sess.session_id.clone(),
            cwd: sess.cwd.clone(),
            pid: sess.pid,
            kind: crate::sessions::kinds::InstanceKind::External,
            is_remote: false,
            transcript_path: None,
            started_at,
        };

        let (_, created) = state.registry.register(input, &shim, &now);
        if created {
            adopted_count += 1;
            // Derive the sidebar title from the transcript's first user prompt,
            // same as the restore + hook-enrichment paths. Without this an
            // adopted session shows as "New chat" forever (it never goes through
            // the session-start hook that would otherwise name it).
            if let Some(name) = crate::tokens::transcript_for_session(&sess.cwd, &sess.session_id)
                .as_deref()
                .and_then(|p| crate::tokens::session_title(p, 60))
            {
                state.registry.set_name(&sess.session_id, name);
            }
            log::info!(
                "adopt_external_sessions: adopted session {} pid={} cwd={:?}",
                sess.session_id, sess.pid, sess.cwd
            );
        }
    }

    if adopted_count > 0 {
        crate::daemon::machines::publish_instances_changed(&state);
        log::info!("adopt_external_sessions: adopted {} session(s)", adopted_count);
    } else {
        log::debug!("adopt_external_sessions: no new external sessions found");
    }
}

/// Gate for `adopt_external_sessions`. Pure over the instance suffix (not
/// `std::env` directly) so it's testable without touching process env - see
/// `crate::daemon::instance::instance_suffix()` for what produces the value.
///
/// Only the default (production) instance may run the machine-wide scan.
/// A non-default instance (any non-empty suffix: `-dev`, `-test`, a
/// `CC_DAEMON_INSTANCE` label) shares no reliable marker with its own
/// processes - the session files it would scan carry no instance tag, so
/// there is no cheap correct way to filter candidates down to "mine" short
/// of skipping the scan outright.
pub fn should_adopt_external(instance_suffix: &str) -> bool {
    instance_suffix.is_empty()
}

#[cfg(test)]
mod gate_tests {
    use super::should_adopt_external;

    #[test]
    fn default_instance_adopts() {
        assert!(should_adopt_external(""));
    }

    #[test]
    fn suffixed_instance_does_not_adopt() {
        assert!(!should_adopt_external("-dev"));
        assert!(!should_adopt_external("-test"));
        assert!(!should_adopt_external("-phone1028"));
    }
}
