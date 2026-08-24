//! cc-conductor-daemon: standalone daemon entrypoint. Production launches the
//! daemon via the app binary's `--daemon` mode (see `lib::run`); this bin
//! remains for the daemon e2e tests, which spawn `cc-conductor-daemon.exe`
//! directly. Both share `daemon::run_daemon_main`.

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Same file logger as the app binary's `--daemon` branch (lib.rs), so a
    // wdio-spawned daemon leaves a trail instead of the stdio: "ignore" harness
    // silently discarding stderr-only output.
    claude_conductor_lib::logging::init_daemon_file_logger();
    claude_conductor_lib::daemon::run_daemon_main().await
}
