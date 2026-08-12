//! Tailscale CLI process wrapper: no Tauri or `AppState` coupling, just
//! shelling out to `tailscale` and parsing its output.

use std::path::PathBuf;
use std::process::Command;

/// Resolve the tailscale executable: prefer PATH, fall back to the default
/// Windows install location.
fn tailscale_exe() -> PathBuf {
    if let Ok(p) = which::which("tailscale") {
        return p;
    }
    PathBuf::from("C:\\Program Files\\Tailscale\\tailscale.exe")
}

/// Run a tailscale subcommand with output captured, console window suppressed.
/// Returns (stdout, stderr, success).
fn run_tailscale(args: &[&str]) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new(tailscale_exe());
    cmd.args(args);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not run tailscale (is it installed?): {e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.success(),
    ))
}

/// The tailscale-serve enable command. Reverse-proxies the daemon's local
/// remote-access port over the tailnet with Tailscale-managed HTTPS.
const SERVE_TARGET: &str = "http://127.0.0.1:27183";

pub(super) fn serve_enable() -> Result<(), String> {
    let (_out, err, ok) = run_tailscale(&["serve", "--bg", "--https=443", SERVE_TARGET])?;
    if ok {
        Ok(())
    } else {
        Err(if err.trim().is_empty() {
            "tailscale serve failed (is tailscale connected? try `tailscale up`)".into()
        } else {
            err.trim().to_string()
        })
    }
}

pub(super) fn serve_disable() -> Result<(), String> {
    // `tailscale serve --https=443 off` removes the 443 proxy. Best-effort: a
    // non-zero exit (e.g. nothing was being served) is not fatal for "turn off".
    let _ = run_tailscale(&["serve", "--https=443", "off"]);
    Ok(())
}

/// The tailnet DNS name for this machine, trailing dot stripped, or None if
/// tailscale is not up / not logged in.
pub(super) fn tailscale_dnsname() -> Option<String> {
    let (out, _err, ok) = run_tailscale(&["status", "--json"]).ok()?;
    if !ok {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&out).ok()?;
    let name = v.get("Self")?.get("DNSName")?.as_str()?;
    let trimmed = name.trim_end_matches('.');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Best-effort: whether `tailscale serve status` mentions our local target.
pub(super) fn serve_running() -> bool {
    match run_tailscale(&["serve", "status"]) {
        Ok((out, _err, _ok)) => out.contains(SERVE_TARGET),
        Err(_) => false,
    }
}
