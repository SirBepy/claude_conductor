//! End-to-end coverage for per-account chat spawn env (milestone 08, item 3b
//! of `docs/multi-account/08-notifications-polish.md`): proves the REAL
//! daemon spawn path (`daemon::lifecycle::spawn_session` ->
//! `accounts::env::SpawnEnv`) sets `CLAUDE_CONFIG_DIR` on the spawned child
//! and scrubs the forbidden auth env vars, using a fake `claude.cmd` stub on
//! `PATH` instead of the real CLI - no billing, no real credentials needed.
//!
//! Manual run only (mirrors `daemon_chat_e2e.rs`):
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_multi_account_spawn_env_e2e -- --ignored --nocapture
//!
//! **WRITTEN, NOT RUN in this session** - review before the first real run:
//! - `accounts.json` is NOT instance-scoped (unlike the pipe/lockfile/hook
//!   port every other e2e test here uses) - it lives at the same
//!   `%APPDATA%\claude-conductor\accounts.json` path a real install uses.
//!   This test backs the real file up and restores it via `AccountsFileGuard`
//!   (runs even on panic), but a hard kill of the test process between backup
//!   and restore would leave the fixture account in place - inspect
//!   `accounts.json` after any run that didn't finish cleanly.
//! - Relies on Rust's Windows `Command`/`CreateProcess` machinery resolving
//!   `claude` to our `claude.cmd` stub via a poisoned `PATH` and actually
//!   running it as a batch script - unverified against the exact toolchain
//!   this repo builds with.
//! - Needs `cc-conductor-daemon.exe` built first (the test builds it itself
//!   via `cargo build --bin cc-conductor-daemon`, same as `daemon_chat_e2e.rs`).

#![cfg(windows)]

use claude_conductor_lib::accounts::model::Account;
use claude_conductor_lib::daemon_client::PersistentClient;
use claude_conductor_lib::settings::paths;
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;

const INSTANCE: &str = "test-account-env";

/// Restores the real `accounts.json` (or removes the fixture file if there
/// was none) when dropped - runs even if the test panics partway through, so
/// a failing assertion never leaves the fixture account in the real registry.
struct AccountsFileGuard {
    path: std::path::PathBuf,
    original: Option<Vec<u8>>,
}

impl AccountsFileGuard {
    fn capture(path: std::path::PathBuf) -> Self {
        let original = std::fs::read(&path).ok();
        Self { path, original }
    }
}

impl Drop for AccountsFileGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(bytes) => { let _ = std::fs::write(&self.path, bytes); }
            None => { let _ = std::fs::remove_file(&self.path); }
        }
    }
}

/// Writes a `claude.cmd` stub that dumps its full environment (`set`) to
/// `%CC_TEST_ENV_DUMP%` and exits immediately - stands in for the real
/// `claude` CLI so the spawn env can be inspected without billing anything.
/// Ignores every argument the daemon passes it (`base_claude_args` etc).
fn write_fake_claude_stub(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("claude.cmd"), "@echo off\r\nset > \"%CC_TEST_ENV_DUMP%\"\r\n").unwrap();
}

/// Writes the `.claude.json` -> `oauthAccount` fixture `accounts::drift::check`
/// needs to pass for this fake account (see `accounts::identity`'s fixture
/// shape and `accounts::drift`'s `check_reads_from_config_dir_on_disk` test).
fn write_fake_account_identity(config_dir: &std::path::Path, email: &str, org_uuid: &str) {
    std::fs::create_dir_all(config_dir).unwrap();
    let fixture = format!(
        r#"{{"oauthAccount": {{"emailAddress": "{email}", "organizationUuid": "{org_uuid}"}}}}"#,
    );
    std::fs::write(config_dir.join(".claude.json"), fixture).unwrap();
}

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn per_account_spawn_sets_config_dir_and_scrubs_auth_env() {
    let tmp = tempfile::tempdir().unwrap();

    let fake_claude_dir = tmp.path().join("fake-bin");
    write_fake_claude_stub(&fake_claude_dir);

    let account_config_dir = tmp.path().join("fake-account-config");
    write_fake_account_identity(&account_config_dir, "e2e-test@example.com", "org-e2e-test");

    let cwd = tmp.path().join("fake-project");
    std::fs::create_dir_all(&cwd).unwrap();

    let account = Account {
        id: "e2e-test-account".into(),
        label: "E2E Test".into(),
        colour: "#123456".into(),
        icon: "user".into(),
        config_dir: account_config_dir.clone(),
        chrome_profile_dir: tmp.path().join("fake-chrome-profile"),
        email: "e2e-test@example.com".into(),
        org_uuid: "org-e2e-test".into(),
        subscription_tier: "claude_max".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    // `accounts.json` is shared, real, unsandboxed state - see the file-level
    // warning above. Back it up before writing our single-account fixture.
    let accounts_path = paths::accounts_file().unwrap();
    let _guard = AccountsFileGuard::capture(accounts_path.clone());
    claude_conductor_lib::accounts::store::save(&accounts_path, &[account.clone()]).unwrap();

    let env_dump_path = tmp.path().join("env-dump.txt");

    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let pipe_name = format!(r"\\.\pipe\cc-conductor-daemon-{user}-{INSTANCE}");
    let app_data = dirs::data_dir().unwrap().join("claude-conductor");
    let _ = std::fs::remove_file(app_data.join(format!("daemon-{INSTANCE}.lock")));
    let port_file = app_data.join(format!("hooks_port-{INSTANCE}.txt"));
    let _ = std::fs::remove_file(&port_file);

    // Derive from this test binary rather than assuming ./target: .cargo/config.toml
    // redirects target-dir off the repo.
    let mut daemon_exe = std::env::current_exe().unwrap();
    daemon_exe.pop();
    daemon_exe.pop();
    daemon_exe.push("cc-conductor-daemon.exe");

    let build = Command::new("cargo")
        .args(["build", "--bin", "cc-conductor-daemon"])
        .status()
        .expect("cargo build");
    assert!(build.success());

    // Poison PATH (fake claude resolves first) and the daemon's OWN ambient
    // env with the exact vars `accounts::env::SCRUBBED_ENV_VARS` must remove
    // before the spawned child sees them.
    let poisoned_path = format!(
        "{};{}",
        fake_claude_dir.display(),
        std::env::var("PATH").unwrap_or_default(),
    );

    let mut child = Command::new(&daemon_exe)
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .env("PATH", poisoned_path)
        .env("CC_TEST_ENV_DUMP", &env_dump_path)
        .env("ANTHROPIC_API_KEY", "sk-stray-test-should-be-scrubbed")
        .env("CLAUDE_CODE_OAUTH_TOKEN", "stray-oauth-token-should-be-scrubbed")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn daemon");

    tokio::time::sleep(Duration::from_millis(800)).await;
    let mut hook_port = String::new();
    for _ in 0..30 {
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if !p.trim().is_empty() { hook_port = p.trim().to_string(); break; }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!hook_port.is_empty(), "daemon did not write its hook port file");

    let client = PersistentClient::connect(&pipe_name).await.expect("connect");

    let resp = client
        .call(
            "start_session",
            json!({
                "cwd": cwd.to_string_lossy(),
                "model": "sonnet",
                "effort": "medium",
                "account_id": account.id,
            }),
        )
        .await
        .expect("start_session");
    let session_id = resp.get("session_id").and_then(|v| v.as_str()).unwrap().to_string();

    // Give the fake claude.cmd a moment to run and dump its env.
    let mut dumped = String::new();
    for _ in 0..30 {
        if let Ok(s) = std::fs::read_to_string(&env_dump_path) {
            if !s.trim().is_empty() { dumped = s; break; }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(!dumped.is_empty(), "fake claude.cmd never ran / never wrote its env dump");

    assert!(
        dumped.contains(&format!("CLAUDE_CONFIG_DIR={}", account_config_dir.display())),
        "child env missing CLAUDE_CONFIG_DIR pointed at the account's profile dir:\n{dumped}"
    );
    assert!(
        !dumped.to_uppercase().contains("ANTHROPIC_API_KEY="),
        "ANTHROPIC_API_KEY leaked into the child env despite SCRUBBED_ENV_VARS:\n{dumped}"
    );
    assert!(
        !dumped.contains("CLAUDE_CODE_OAUTH_TOKEN="),
        "CLAUDE_CODE_OAUTH_TOKEN leaked into the child env despite SCRUBBED_ENV_VARS:\n{dumped}"
    );

    let _ = client.call("end_session", json!({"session_id": session_id})).await;
    let _ = child.kill();
}
