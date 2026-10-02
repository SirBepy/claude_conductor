//! cc-conductor-daemon: standalone daemon entrypoint. Production launches the
//! daemon via the app binary's `--daemon` mode (see `lib::run`); this bin
//! remains for the daemon e2e tests and the wdio harness, which spawn
//! `cc-conductor-daemon.exe` directly. Both share `daemon::run_daemon_main`.

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Mirrors main.rs's `--mcp-permission` branch: when this bin is the
    // daemon, `daemon/claude_config/` builds the per-turn MCP server command from
    // `current_exe()`, so it resolves here. Checked before the runtime below
    // exists, because `run_stdio()` builds its own and nested runtimes panic.
    if std::env::args().any(|a| a == "--mcp-permission") {
        claude_conductor_lib::mcp::server::run_stdio();
        return Ok(());
    }

    // Same file logger as the app binary's `--daemon` branch (lib.rs), so a
    // wdio-spawned daemon leaves a trail instead of the stdio: "ignore" harness
    // silently discarding stderr-only output.
    claude_conductor_lib::logging::init_daemon_file_logger();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()?;
    rt.block_on(claude_conductor_lib::daemon::run_daemon_main())
}
