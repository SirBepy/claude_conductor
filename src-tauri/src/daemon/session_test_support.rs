//! Shared test-only fixture for daemon unit tests that need a live `Session`
//! backed by a real `ChildStdin` - there is no cross-platform stand-in, so
//! this is Windows-only, same as its callers (`hooks_server::nudge`'s
//! `injects_and_broadcasts_a_live_user_message_on_the_chat_stream` and
//! `methods::lifecycle::attach`'s `relay_tests`).

#[cfg(windows)]
use crate::daemon::session::{Session, SessionMap};

#[cfg(windows)]
pub(crate) async fn spawn_fake_session(map: &SessionMap, session_id: &str) -> tokio::process::Child {
    let mut child = tokio::process::Command::new("cmd")
        .args(["/C", "ping", "-n", "30", "127.0.0.1"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn probe child");
    let stdin = child.stdin.take().expect("piped stdin");
    let pid = child.id().expect("pid");
    let session = Session::new(
        session_id.to_string(),
        std::env::temp_dir(),
        "m".into(),
        "high".into(),
        pid,
        stdin,
        None,
        None,
        "acct".into(),
    );
    map.insert(session_id.to_string(), session);
    child
}
