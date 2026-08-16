//! cc-conductor-daemon: standalone daemon entrypoint. Production launches the
//! daemon via the app binary's `--daemon` mode (see `lib::run`); this bin
//! remains for the daemon e2e tests, which spawn `cc-conductor-daemon.exe`
//! directly. Both share `daemon::run_daemon_main`.

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    env_logger::Builder::from_env(
        env_logger::Env::default()
            .default_filter_or("info,iroh=warn,iroh_relay=warn,quinn=warn,netwatch=warn,portmapper=warn"),
    )
    .init();
    claude_conductor_lib::daemon::run_daemon_main().await
}
