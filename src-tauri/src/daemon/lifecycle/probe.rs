//! Throwaway live `Session` for lifecycle tests (Windows-only: it spawns `cmd`).

use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Registers `session_id` as an Interactive row in `cwd` (a folder that does
/// not exist, so a respawn fails at the cwd check instead of starting
/// `claude`) with the registry's pick set to `registry_pair`, and inserts a
/// live session launched with `live_pair`. Keep the returned child alive for
/// the test; it is killed on drop. A respawn attempt shows as
/// `expected_exit`, which `kill_and_wait_for_teardown` sets before it kills.
pub(crate) fn live_session(
    state: &DaemonState,
    session_id: &str,
    live_pair: (&str, &str),
    registry_pair: (&str, &str),
) -> (tokio::process::Child, Arc<Session>) {
    let cwd = std::path::Path::new("Z:\\does\\not\\exist");
    state.registry.upsert_interactive(session_id, cwd, "proj", "2026-11-07T00:00:00Z");
    state.registry.set_model_effort(session_id, registry_pair.0, registry_pair.1);
    let mut child = tokio::process::Command::new("cmd")
        .args(["/C", "ping", "-n", "60", "127.0.0.1"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn probe child");
    let stdin = child.stdin.take().expect("piped stdin");
    let pid = child.id().expect("pid");
    let session = Session::new(
        session_id.to_string(), cwd.to_path_buf(), live_pair.0.into(), live_pair.1.into(),
        pid, stdin, None, None, "acct".into(),
    );
    state.sessions.insert(session_id.to_string(), session.clone());
    (child, session)
}
