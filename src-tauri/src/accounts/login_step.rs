//! Interactive `/login` step. There is no headless login (locked decision,
//! 00-overview.md): the wizard spawns a VISIBLE terminal with
//! `CLAUDE_CONFIG_DIR` set to the profile dir, the user runs `/login` and
//! picks the right account by hand, and the wizard polls the profile dir for
//! a complete login (`oauthAccount` + parseable `.credentials.json`).
//! `claude setup-token` is never used here.
//!
//! When the profile dir ALREADY holds a complete login, the wizard skips this
//! step entirely (`ipc::accounts::add_account_create` never spawns the
//! terminal) - an expired access token is still "complete" because the CLI
//! self-refreshes via the refresh token.

use super::identity::{self, OauthAccountInfo};
use std::path::{Path, PathBuf};

/// Result of checking whether the profile dir holds a complete login.
#[derive(Debug, Clone, PartialEq)]
pub enum LoginPollResult {
    /// No complete login in the dir yet (missing/parseless `.claude.json`
    /// `oauthAccount`, or missing/parseless `.credentials.json`).
    Pending,
    /// `.credentials.json` holds a valid (parseable, unexpired-or-refreshable)
    /// token, but `.claude.json` has no `oauthAccount` block. The CLI only
    /// writes `oauthAccount` during the live `/login` handshake itself -
    /// ordinary startups against already-valid credentials never backfill it
    /// (confirmed on a real profile with 19 sessions and still no block,
    /// ai_todo 167), so waiting or "running a command" does NOT resolve this
    /// state. Distinct from `Pending` so the wizard can offer the
    /// browser-cookie identity fallback (`add_account_capture_cookie`)
    /// instead of polling forever.
    CredentialsNoProfile,
    /// The dir holds an identity AND credentials - login is complete.
    Ready(OauthAccountInfo),
}

/// A login is complete once BOTH artifacts exist in the profile dir: the
/// `oauthAccount` identity block in `.claude.json` and a parseable
/// `.credentials.json`. No timestamp freshness check: current Claude Code
/// builds no longer write `profileFetchedAt`, so "did the files appear"
/// is the only reliable signal. Whether the identity is the RIGHT one
/// (adoption mismatch, duplicates) is the caller's job
/// (`ipc::accounts::add_account_check_login`).
pub fn poll_login(config_dir: &Path) -> LoginPollResult {
    let identity = identity::read_oauth_account(config_dir);
    let has_valid_credentials = identity::read_token_expiry(config_dir).is_some();
    match identity {
        Some(identity) if has_valid_credentials => LoginPollResult::Ready(identity),
        None if has_valid_credentials => LoginPollResult::CredentialsNoProfile,
        _ => LoginPollResult::Pending,
    }
}

/// True when the profile dir already holds a complete login and the wizard
/// can skip spawning the `/login` terminal altogether (adoption fast-path).
pub fn has_complete_login(config_dir: &Path) -> bool {
    matches!(poll_login(config_dir), LoginPollResult::Ready(_))
}

// ── Misdirected-login detection ─────────────────────────────────────────────
// The wizard's terminal is easy to lose among other terminals/tabs (past
// incident: /login typed into a stale terminal from a cancelled wizard run -
// the credentials landed in a different profile dir and the wizard waited
// forever). While the login step is Pending, we watch every OTHER known
// Claude profile (`~/.claude` plus each `~/.claude-*` sibling) for a stored
// OAuth record that appeared or changed after the step started, and surface
// "your login went to X" instead of spinning silently.

#[derive(Debug, Clone, Default)]
pub struct LoginWatch {
    entries: Vec<WatchEntry>,
}

#[derive(Debug, Clone)]
struct WatchEntry {
    /// Human description used in the misdirected-login message.
    desc: String,
    config_dir: PathBuf,
    baseline: Option<String>,
}

/// Non-secret stand-in for a profile's stored OAuth record. Reads through
/// `identity::read_oauth_record`, so it sees the macOS Keychain too.
fn record_fingerprint(config_dir: &Path) -> Option<String> {
    let record = identity::read_oauth_record(config_dir)?;
    let digest = crate::util::sha256_hex(&record.access_token);
    Some(format!("{}:{}", &digest[..16], record.expires_at.unwrap_or_default()))
}

/// Captures the watch baseline: `<home>/.claude` (the terminal's default
/// profile) plus every `<home>/.claude-*` sibling dir, excluding
/// `target_config_dir` itself.
pub fn capture_login_watch(home_dir: &Path, target_config_dir: &Path) -> LoginWatch {
    let mut entries = Vec::new();
    let mut push = |dir: PathBuf, desc: String| {
        if dir == target_config_dir {
            return;
        }
        let baseline = record_fingerprint(&dir);
        entries.push(WatchEntry { desc, config_dir: dir, baseline });
    };

    push(home_dir.join(".claude"), "your terminal's default profile (~/.claude)".to_string());
    if let Ok(read) = std::fs::read_dir(home_dir) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".claude-") && entry.path().is_dir() {
                push(entry.path(), format!("the \"{}\" profile folder", name));
            }
        }
    }
    LoginWatch { entries }
}

/// The first watched profile whose stored record appeared or changed since
/// the baseline. Auto-refresh also rewrites it, so this is a hint, not proof.
pub fn detect_misdirected_login(watch: &LoginWatch) -> Option<String> {
    for entry in &watch.entries {
        let Some(now) = record_fingerprint(&entry.config_dir) else { continue };
        if entry.baseline.as_deref() != Some(now.as_str()) {
            return Some(entry.desc.clone());
        }
    }
    None
}

/// Spawns a visible terminal running `claude` with `CLAUDE_CONFIG_DIR` set to
/// `config_dir`, so the user can run `/login` inside that isolated profile.
/// The env var is baked into the shell command string (not set via
/// `Command::env`) because several of these terminal launchers (Windows
/// Terminal, gnome-terminal) hand the command off to an already-running
/// server process rather than inheriting our env directly.
///
/// `display_name` (the account slug/label) goes into the window title +
/// banner so the window is distinguishable from the user's other terminals -
/// past incident: /login typed into the wrong, identical-looking window.
pub fn spawn_login_terminal(config_dir: &Path, display_name: &str) -> std::io::Result<()> {
    imp::spawn(config_dir, &sanitize_display_name(display_name))
}

/// Title/banner text is interpolated into a shell command string; keep only
/// characters that are inert in cmd.exe, AppleScript, and bash. Slugs are
/// already this tame - this guards the `reauth_account` path where the
/// account LABEL (free text) is passed.
fn sanitize_display_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { "account".to_string() } else { trimmed.to_string() }
}

/// The window title the login terminal is given, shared so UI copy can tell
/// the user which window to type into.
pub fn login_terminal_title(display_name: &str) -> String {
    format!("Claude login - {}", sanitize_display_name(display_name))
}

#[cfg(target_os = "windows")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub fn spawn(config_dir: &Path, display_name: &str) -> std::io::Result<()> {
        let dir_str = config_dir.to_string_lossy().to_string();
        let title = super::login_terminal_title(display_name);
        // No double quotes anywhere in this string: Rust's arg quoting would
        // backslash-escape them, and cmd.exe does not understand \" (it also
        // changes cmd's outer-quote-stripping behavior for the /K payload).
        let inner = format!(
            "title {title}&&set CLAUDE_CONFIG_DIR={dir_str}&&echo(&&echo   Log in for the {display_name} account HERE (run /login).&&echo(&&claude"
        );
        // Prefer Windows Terminal. `-w new` forces a NEW window: a tab
        // appended to an existing window is exactly how the user ends up
        // typing /login into the wrong tab.
        let mut wt = Command::new("wt.exe");
        wt.args(["-w", "new", "-d", &dir_str, "cmd.exe", "/K", &inner]);
        if wt.spawn().is_ok() {
            return Ok(());
        }
        // Fall back to a bare cmd.exe console window.
        let mut fallback = Command::new("cmd.exe");
        fallback.arg("/C").arg("start").arg("").arg("cmd.exe").arg("/K").arg(&inner);
        fallback.current_dir(config_dir);
        fallback.spawn()?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub fn spawn(config_dir: &Path, display_name: &str) -> std::io::Result<()> {
        let dir_esc = config_dir.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        let banner = format!("Log in for the {display_name} account HERE (run /login).");
        let script = format!(
            "tell application \"Terminal\" to do script \"cd \\\"{dir_esc}\\\" && export CLAUDE_CONFIG_DIR=\\\"{dir_esc}\\\" && echo && echo '  {banner}' && echo && claude\""
        );
        Command::new("osascript").arg("-e").arg(&script).spawn()?;
        let _ = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"Terminal\" to activate")
            .spawn();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub fn spawn(config_dir: &Path, display_name: &str) -> std::io::Result<()> {
        let dir_str = config_dir.to_string_lossy().to_string();
        let banner = format!("Log in for the {display_name} account HERE (run /login).");
        let run = format!(
            "export CLAUDE_CONFIG_DIR=\"{dir_str}\"; echo; echo \"  {banner}\"; echo; claude; exec bash"
        );
        let candidates = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
        for bin in candidates {
            let mut cmd = Command::new(bin);
            match bin {
                "gnome-terminal" => {
                    cmd.arg(format!("--working-directory={dir_str}"));
                    cmd.arg("--").arg("bash").arg("-c").arg(&run);
                }
                "konsole" => {
                    cmd.arg("--workdir").arg(&dir_str);
                    cmd.arg("-e").arg("bash").arg("-c").arg(&run);
                }
                "xfce4-terminal" => {
                    cmd.arg(format!("--working-directory={dir_str}"));
                    cmd.arg("-e").arg(format!("bash -c '{run}'"));
                }
                _ => {
                    cmd.current_dir(config_dir);
                    cmd.arg("-e").arg("bash").arg("-c").arg(&run);
                }
            }
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, xterm)",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_identity(dir: &Path) {
        let raw = r#"{"oauthAccount": {"emailAddress": "a@x.com", "organizationUuid": "org-1"}}"#;
        std::fs::write(dir.join(".claude.json"), raw).unwrap();
    }

    fn write_credentials(dir: &Path) {
        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-x","expiresAt":1783437706982,"scopes":[]}}"#,
        )
        .unwrap();
    }

    #[test]
    fn poll_pending_when_dir_empty() {
        let dir = tempdir().unwrap();
        assert_eq!(poll_login(dir.path()), LoginPollResult::Pending);
    }

    #[test]
    fn poll_pending_when_identity_but_no_credentials() {
        let dir = tempdir().unwrap();
        write_identity(dir.path());
        assert_eq!(poll_login(dir.path()), LoginPollResult::Pending);
    }

    #[test]
    fn poll_credentials_no_profile_when_credentials_but_no_identity() {
        let dir = tempdir().unwrap();
        write_credentials(dir.path());
        assert_eq!(poll_login(dir.path()), LoginPollResult::CredentialsNoProfile);
    }

    #[test]
    fn poll_ready_when_identity_and_credentials_present() {
        let dir = tempdir().unwrap();
        write_identity(dir.path());
        write_credentials(dir.path());
        match poll_login(dir.path()) {
            LoginPollResult::Ready(identity) => assert_eq!(identity.email_address, "a@x.com"),
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn poll_ready_without_profile_freshness_timestamp() {
        // Current Claude Code builds don't write profileFetchedAt at all -
        // completion must not depend on it (past incident: adopted dirs).
        let dir = tempdir().unwrap();
        write_identity(dir.path());
        write_credentials(dir.path());
        assert!(matches!(poll_login(dir.path()), LoginPollResult::Ready(_)));
    }

    #[test]
    fn has_complete_login_matches_poll() {
        let dir = tempdir().unwrap();
        assert!(!has_complete_login(dir.path()));
        write_identity(dir.path());
        write_credentials(dir.path());
        assert!(has_complete_login(dir.path()));
    }

    // ── misdirected-login watch ─────────────────────────────────────────────

    /// A real record, not `{}`: the watch fingerprints the stored blob.
    fn write_creds_token(dir: &Path, token: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(".credentials.json"),
            format!(r#"{{"claudeAiOauth":{{"accessToken":"{token}","expiresAt":1783437706982}}}}"#),
        )
        .unwrap();
    }

    fn touch_creds(dir: &Path) {
        write_creds_token(dir, "sk-ant-oat01-watch");
    }

    #[test]
    fn watch_ignores_target_dir_and_preexisting_credentials() {
        let home = tempdir().unwrap();
        let target = home.path().join(".claude-personal");
        std::fs::create_dir_all(&target).unwrap();
        touch_creds(&home.path().join(".claude"));

        let watch = capture_login_watch(home.path(), &target);
        // Nothing changed since baseline -> no hint.
        assert_eq!(detect_misdirected_login(&watch), None);

        // A login INTO THE TARGET must never trigger the hint.
        touch_creds(&target);
        assert_eq!(detect_misdirected_login(&watch), None);
    }

    #[test]
    fn watch_flags_new_credentials_in_home_profile() {
        let home = tempdir().unwrap();
        let target = home.path().join(".claude-personal");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();

        let watch = capture_login_watch(home.path(), &target);
        touch_creds(&home.path().join(".claude"));

        let hint = detect_misdirected_login(&watch).expect("expected a hint");
        assert!(hint.contains("~/.claude"), "hint should name the profile: {hint}");
    }

    #[test]
    fn watch_flags_new_credentials_in_sibling_profile_dir() {
        let home = tempdir().unwrap();
        let target = home.path().join(".claude-personal");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(home.path().join(".claude-work")).unwrap();

        let watch = capture_login_watch(home.path(), &target);
        touch_creds(&home.path().join(".claude-work"));

        let hint = detect_misdirected_login(&watch).expect("expected a hint");
        assert!(hint.contains(".claude-work"), "hint should name the dir: {hint}");
    }

    #[test]
    fn watch_flags_rewritten_credentials_as_fresh() {
        let home = tempdir().unwrap();
        let target = home.path().join(".claude-personal");
        std::fs::create_dir_all(&target).unwrap();
        let work = home.path().join(".claude-work");
        touch_creds(&work);

        let watch = capture_login_watch(home.path(), &target);
        write_creds_token(&work, "sk-ant-oat01-relogin");

        assert!(detect_misdirected_login(&watch).is_some());
    }

    #[test]
    fn misdirected_then_correct_login_replays_the_wrong_terminal_incident() {
        // Regression for the 2026-07-08 incident: /login typed into a stale
        // terminal landed in ~/.claude while the wizard polled the fresh
        // ~/.claude-personal forever. The watch must flag the sideways login,
        // and a subsequent correct login must still complete the step.
        let home = tempdir().unwrap();
        let target = home.path().join(".claude-personal");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();

        let watch = capture_login_watch(home.path(), &target);
        assert_eq!(poll_login(&target), LoginPollResult::Pending);
        assert_eq!(detect_misdirected_login(&watch), None);

        // Login lands in the WRONG profile: still pending, but now flagged.
        touch_creds(&home.path().join(".claude"));
        assert_eq!(poll_login(&target), LoginPollResult::Pending);
        assert!(detect_misdirected_login(&watch).is_some());

        // User retries in the right terminal: step completes.
        write_identity(&target);
        write_credentials(&target);
        assert!(matches!(poll_login(&target), LoginPollResult::Ready(_)));
    }

    #[test]
    fn sanitize_display_name_strips_shell_metacharacters() {
        assert_eq!(sanitize_display_name("per&&sonal\"|;`$"), "personal");
        assert_eq!(sanitize_display_name("Fibo Studio"), "Fibo Studio");
        assert_eq!(sanitize_display_name("&&\"`"), "account");
    }

    #[test]
    fn login_terminal_title_is_stable_copy() {
        assert_eq!(login_terminal_title("personal"), "Claude login - personal");
    }
}
