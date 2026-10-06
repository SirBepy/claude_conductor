//! Daemon-side modules. The binary at `src/bin/cc_conductor_daemon.rs`
//! consumes these via the `claude_conductor_lib` library crate.

mod boot;
pub mod broadcast;
pub mod busy_watchdog;
pub mod channel_adopt;
pub mod claude_ai_connectors;
pub mod claude_config;
pub mod channels;
pub mod detector_task;
pub mod device_registry;
pub mod draft_store;
pub mod frame;
pub mod handshake;
pub mod health;
pub mod hooks_server;
pub mod idle;
pub mod instance;
pub mod iroh_tunnel;
pub mod jarvis_wake;
pub mod jsonl_tail;
pub mod lifecycle;
pub mod lockfile;
pub mod machines;
pub mod methods;
pub mod notifier;
pub mod preview;
pub mod pump;
pub mod push;
pub mod rate_limit;
mod remote_handlers;
mod remote_pairing;
mod remote_preview_render;
mod remote_push;
pub mod remote_server;
mod remote_static;
mod remote_transport_table;
mod remote_voice;
mod remote_ws_pump;
pub(crate) mod render_cache;
pub mod repo_channel_wake;
mod resume_interrupted;
pub mod rpc;
pub mod schedule;
mod schedule_fire;
pub mod session;
pub(crate) mod session_registration;
#[cfg(test)]
pub(crate) mod session_test_support;
pub mod settings_cache;
pub mod spawn_self;
pub mod start_tokens;
pub mod state;
pub mod stt;
pub mod transport_common;

#[cfg(windows)]
pub mod transport_windows;
#[cfg(unix)]
pub mod transport_unix;

use std::path::PathBuf;

// `kill_all_sessions` is also called from `daemon/methods/lifecycle/shutdown.rs`.
pub use boot::{kill_all_sessions, run_daemon_main};

/// Pure over the `CC_DATA_DIR` value so tests never mutate process env that
/// parallel `--lib` tests read. The unset case stays on `dirs::data_dir()`
/// rather than `settings::paths::data_dir()`'s `dirs::config_dir()`: same
/// path on Windows, different on Linux/macOS, where sharing it would move
/// the daemon's existing on-disk root.
fn resolve_app_data_dir(override_: Option<&str>) -> PathBuf {
    if let Some(v) = override_ {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    let mut p = dirs::data_dir().expect("data_dir");
    p.push("claude-conductor");
    p
}

/// Roots the lockfile, push keys, iroh key and the remote-access device
/// registry / token / pairing files, so an isolated `CC_DATA_DIR` daemon
/// must never fall through to the real user's copies of those.
///
/// `pub(crate)`: also the single source for the Unix socket path
/// (`transport_unix.rs`) and a client-side test lockfile path
/// (`daemon_client/methods/misc.rs`) that must resolve identically to this,
/// or a `CC_DATA_DIR`-scoped daemon binds a path its own client can't attach
/// to.
pub(crate) fn app_data_dir() -> PathBuf {
    resolve_app_data_dir(std::env::var("CC_DATA_DIR").ok().as_deref())
}

#[cfg(test)]
mod app_data_dir_tests {
    use super::resolve_app_data_dir;
    use std::path::PathBuf;

    #[test]
    fn override_set_wins() {
        let d = resolve_app_data_dir(Some("C:/tmp/cc-test-app-data"));
        assert_eq!(d, PathBuf::from("C:/tmp/cc-test-app-data"));
    }

    #[test]
    fn override_unset_falls_back_to_default() {
        let d = resolve_app_data_dir(None);
        assert!(d.ends_with("claude-conductor"));
    }

    #[test]
    fn override_empty_falls_back_to_default() {
        let d = resolve_app_data_dir(Some(""));
        assert!(d.ends_with("claude-conductor"));
    }
}
