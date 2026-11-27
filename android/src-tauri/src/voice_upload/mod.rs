//! Background upload of voice recordings from the phone to the PC (todo pc-1852,
//! round R4). A native task in this crate, not page fetches: it runs while the
//! WebView is on a voice screen, in the background or never loaded the PC's page,
//! and its calls never touch the page's "Waiting for your PC" strip.
//!
//! - `engine`: what to send and where to resume (tested with a fake index and PC).
//! - `tunnel_rpc`: one `POST /api/rpc` per call over a stream of the shared iroh
//!   tunnel (`http` does the HTTP).
//! - `wire`: the JSON traded with `VoiceUploadPlugin.kt`, which owns the index
//!   (`RecordingStore`) and the captured login.
//! - `kotlin` (Android only) and this file: the plugin handle and the loop.

mod engine;
mod http;
#[cfg(target_os = "android")]
mod kotlin;
mod tunnel_rpc;
mod wire;

use std::time::Duration;

use engine::PassEnd;

/// Wait between looks at an index with nothing to send. The index lives in
/// Kotlin, so a new recording is noticed by this poll; 20 s is a cheap read.
const IDLE_POLL: Duration = Duration::from_secs(20);
const BACKOFF_START: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(120);
/// Pause after a pass that did work, so a row the index keeps handing back
/// cannot turn the loop into a busy one.
const WORKED_PAUSE: Duration = Duration::from_secs(1);

/// Doubling wait while the PC is unreachable; a pass that reaches it resets it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Backoff(Duration);

impl Default for Backoff {
    fn default() -> Self {
        Backoff(BACKOFF_START)
    }
}

impl Backoff {
    /// The wait after `end`, and the backoff to carry on with.
    pub(crate) fn after(self, end: PassEnd) -> (Duration, Backoff) {
        match end {
            PassEnd::Idle => (IDLE_POLL, Backoff::default()),
            PassEnd::Worked => (WORKED_PAUSE, Backoff::default()),
            PassEnd::Offline | PassEnd::Unauthorized => (self.0, Backoff((self.0 * 2).min(BACKOFF_MAX))),
        }
    }
}

/// Runs passes for the life of the process.
pub(crate) async fn run_forever<S, R>(uploader: engine::Uploader<S, R>)
where
    S: engine::Source + ?Sized,
    R: engine::Rpc + ?Sized,
{
    let mut backoff = Backoff::default();
    loop {
        let end = uploader.run_pass().await;
        if end != PassEnd::Idle {
            crate::journal::global().record(crate::iroh_tunnel::ms_of(std::time::SystemTime::now()), "voice_upload", &format!("pass {end:?}"));
        }
        let (wait, next) = backoff.after(end);
        backoff = next;
        tokio::time::sleep(wait).await;
    }
}

/// The plugin that links this crate to `VoiceUploadPlugin.kt` and starts the loop.
#[cfg(target_os = "android")]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    kotlin::plugin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreachable_pc_backs_off_to_the_cap_and_a_reachable_one_resets_it() {
        let mut b = Backoff::default();
        let mut waits = Vec::new();
        for _ in 0..6 {
            let (w, next) = b.after(PassEnd::Offline);
            waits.push(w.as_secs());
            b = next;
        }
        assert_eq!(waits, vec![10, 20, 40, 80, 120, 120]);
        let (w, b) = b.after(PassEnd::Worked);
        assert_eq!(w, WORKED_PAUSE);
        assert_eq!(b, Backoff::default());
        assert_eq!(b.after(PassEnd::Idle).0, IDLE_POLL);
        assert_eq!(Backoff::default().after(PassEnd::Unauthorized).0, BACKOFF_START);
    }
}
