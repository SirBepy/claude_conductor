//! One-time login flow: spawn Chrome, wait for user to log in, extract
//! sessionKey via CDP, kill Chrome.

use super::cdp;
use super::session;
use crate::settings::paths;
use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

const CDP_PORT: u16 = 9242; // avoid clashes with 9222
const LOGIN_TIMEOUT_SECS: u64 = 10 * 60;

/// Which site the browser opens and whose `sessionKey` cookie it waits for.
/// claude.ai and the Console (platform.claude.com) are separate logins with
/// separate cookies; the Console org rejects the claude.ai one with 403.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoginTarget {
    pub login_url: &'static str,
    /// Matched as a suffix of the cookie's domain, which Chrome reports with a
    /// leading dot for host-wide cookies (`.claude.ai`).
    pub cookie_domain: &'static str,
}

impl LoginTarget {
    pub const CLAUDE_AI: LoginTarget = LoginTarget {
        login_url: "https://claude.ai/login",
        cookie_domain: "claude.ai",
    };
    pub const CONSOLE: LoginTarget = LoginTarget {
        login_url: "https://platform.claude.com/login",
        cookie_domain: "platform.claude.com",
    };
}

/// The `sessionKey` value among CDP `Storage.getCookies` results whose domain
/// ends with `cookie_domain`.
fn session_key_for(cookies: &[serde_json::Value], cookie_domain: &str) -> Option<String> {
    cookies.iter().find_map(|c| {
        let name = c.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let domain = c.get("domain").and_then(|x| x.as_str()).unwrap_or("");
        if name == "sessionKey" && domain.ends_with(cookie_domain) {
            c.get("value").and_then(|x| x.as_str()).map(str::to_string)
        } else {
            None
        }
    })
}

pub(crate) fn find_browser() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            std::env::var("ProgramFiles").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("LOCALAPPDATA").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|p| format!("{p}/Microsoft/Edge/Application/msedge.exe")),
            std::env::var("ProgramFiles").ok().map(|p| format!("{p}/Microsoft/Edge/Application/msedge.exe")),
        ];
        for c in candidates.into_iter().flatten() {
            let p = Path::new(&c);
            if p.exists() { return Some(p.to_path_buf()); }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut roots: Vec<PathBuf> = vec![PathBuf::from("/Applications")];
        if let Some(h) = dirs::home_dir() {
            roots.push(h.join("Applications"));
        }
        let apps: &[(&str, &str)] = &[
            ("Google Chrome.app", "Google Chrome"),
            ("Microsoft Edge.app", "Microsoft Edge"),
            ("Brave Browser.app", "Brave Browser"),
            ("Chromium.app", "Chromium"),
        ];
        for root in &roots {
            for (bundle, bin) in apps {
                let p = root.join(bundle).join("Contents/MacOS").join(bin);
                if p.exists() { return Some(p); }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // PATH lookup first - covers snap/flatpak/nix shims that wrap the real binary.
        let path_candidates = [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "brave-browser",
            "microsoft-edge",
        ];
        for name in path_candidates {
            if let Ok(out) = Command::new("which").arg(name).output() {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        let p = PathBuf::from(trimmed);
                        if p.exists() { return Some(p); }
                    }
                }
            }
        }
        let absolute_candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/brave-browser",
            "/usr/bin/microsoft-edge",
        ];
        for c in absolute_candidates {
            let p = Path::new(c);
            if p.exists() { return Some(p.to_path_buf()); }
        }
    }
    None
}

fn spawn_browser(bin: &Path, profile: &Path, port: u16, login_url: &str) -> std::io::Result<Child> {
    Command::new(bin)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("--disable-component-update")
        .arg("--disable-features=Translate,InterestFeedContentSuggestions,PrivacySandboxSettings4,OptimizationHints,ChromeWhatsNewUI")
        .arg("--disable-sync")
        .arg("--disable-default-apps")
        .arg("--disable-extensions")
        .arg("--metrics-recording-only")
        .arg("--no-pings")
        .arg("--password-store=basic")
        .arg("--use-mock-keychain")
        .arg(login_url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn kill_browser(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null());
        crate::util::process::hide_console(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(target_os = "macos")]
    {
        // Send real SIGTERM (std::process::Child::kill is SIGKILL on Unix,
        // which leaves the chrome-login-profile dirty -> next launch repeats
        // the slow first-run bootstrap). Give Chrome up to 3s to flush, then
        // SIGKILL as a fallback.
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM); }
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                _ => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = child.kill(); }
}

/// Legacy single-account login: uses the shared `chrome-login-profile` dir
/// and saves to the single `session.txt` (`paths::session_file`). Kept
/// working as-is until the multi-account migration (milestone 08).
pub async fn run(app: AppHandle) -> Result<()> {
    let profile = crate::settings::paths::data_dir()
        .context("data dir")?
        .join("chrome-login-profile");
    let session_key = run_with_profile(&app, &profile, LoginTarget::CLAUDE_AI).await?;
    let session_path = paths::session_file()?;
    session::save(&session_path, &session_key)?;
    Ok(())
}

/// Per-account login: same CDP browser flow, but against `chrome_profile_dir`
/// (one per account, avoids cookie collisions - 01-account-identity.md step
/// 5). Returns the raw `sessionKey`; the caller decides where to persist it
/// (the add-account wizard keys it by account id via
/// `paths::account_session_file`, never the legacy single-session path).
pub async fn run_for_account(app: AppHandle, chrome_profile_dir: PathBuf) -> Result<String> {
    run_with_profile(&app, &chrome_profile_dir, LoginTarget::CLAUDE_AI).await
}

/// `run_for_account` against another site, for the Console login of an
/// API-credit account.
pub async fn run_for_account_at(
    app: AppHandle,
    chrome_profile_dir: PathBuf,
    target: LoginTarget,
) -> Result<String> {
    run_with_profile(&app, &chrome_profile_dir, target).await
}

/// Shared CDP browser flow: spawn Chrome/Edge against `profile_dir`, wait for
/// the user to log into `target`, extract its `sessionKey` cookie, kill the
/// browser. Emits the same `auth-progress` events either caller relies on.
async fn run_with_profile(app: &AppHandle, profile_dir: &Path, target: LoginTarget) -> Result<String> {
    let _ = app.emit("auth-progress", json!({"stage": "waiting-for-browser"}));

    let bin = find_browser()
        .ok_or_else(|| anyhow!(
            "No Chromium-based browser found. Install Google Chrome from https://www.google.com/chrome/"
        ))?;
    log::info!("launching browser: {}", bin.display());

    std::fs::create_dir_all(profile_dir).context("create profile dir")?;

    let mut child = spawn_browser(&bin, profile_dir, CDP_PORT, target.login_url)
        .context("spawn browser")?;

    let result = run_inner(app, &mut child, target.cookie_domain).await;
    kill_browser(&mut child);
    // NOTE: do NOT delete the profile dir, we want Google/SSO cookies to persist
    // across re-logins so the user only types their password once.

    match result {
        Ok(session_key) => {
            let _ = app.emit("auth-progress", json!({"stage": "done"}));
            Ok(session_key)
        }
        Err(e) => {
            let _ = app.emit(
                "auth-progress",
                json!({"stage": "error", "message": e.to_string()}),
            );
            Err(e)
        }
    }
}

async fn run_inner(app: &AppHandle, _child: &mut Child, cookie_domain: &str) -> Result<String> {
    // Wait for CDP HTTP to come up
    let http = format!("http://127.0.0.1:{CDP_PORT}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("Chrome debugger never came up"));
        }
        if reqwest::get(format!("{http}/json/version")).await.is_ok() {
            break;
        }
        sleep(Duration::from_millis(400)).await;
    }

    let _ = app.emit("auth-progress", json!({"stage": "waiting-for-user"}));

    // Poll every ~1.5s for a claude.ai session until timeout
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(LOGIN_TIMEOUT_SECS);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("login timed out after 5 minutes"));
        }
        let ws_url = cdp::browser_ws_url(&http).await?;
        let cookies_result = cdp::call(
            &ws_url,
            "Storage.getCookies",
            json!({}),
            Duration::from_secs(5),
        ).await;
        if let Ok(result) = cookies_result {
            if let Some(cookies) = result.get("cookies").and_then(|x| x.as_array()) {
                if let Some(v) = session_key_for(cookies, cookie_domain) {
                    let _ = app.emit("auth-progress", json!({"stage": "extracting"}));
                    return Ok(v);
                }
            }
        }
        sleep(Duration::from_millis(1500)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_targets_open_their_own_login_page_and_cookie_domain() {
        assert_eq!(LoginTarget::CLAUDE_AI.login_url, "https://claude.ai/login");
        assert_eq!(LoginTarget::CLAUDE_AI.cookie_domain, "claude.ai");
        assert_eq!(LoginTarget::CONSOLE.login_url, "https://platform.claude.com/login");
        assert_eq!(LoginTarget::CONSOLE.cookie_domain, "platform.claude.com");
    }

    #[test]
    fn the_cookie_is_picked_by_domain_so_one_site_never_yields_the_others_login() {
        let cookies = vec![
            json!({"name": "sessionKey", "domain": ".claude.ai", "value": "web-cookie"}),
            json!({"name": "other", "domain": ".platform.claude.com", "value": "nope"}),
            json!({"name": "sessionKey", "domain": ".platform.claude.com", "value": "console-cookie"}),
        ];
        assert_eq!(session_key_for(&cookies, LoginTarget::CLAUDE_AI.cookie_domain).as_deref(), Some("web-cookie"));
        assert_eq!(session_key_for(&cookies, LoginTarget::CONSOLE.cookie_domain).as_deref(), Some("console-cookie"));
        assert_eq!(session_key_for(&cookies[..1], LoginTarget::CONSOLE.cookie_domain), None);
    }
}
