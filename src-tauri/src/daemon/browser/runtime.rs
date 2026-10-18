//! Installs the pinned `@playwright/mcp` into app data on first use. The
//! installed app ships no `node_modules`, so this is the only way the package
//! reaches a machine. `npm ci` against the embedded lockfile means the exact
//! tree that passed the package safety check (three packages, integrity
//! hashes pinned) is what gets installed, never a fresh resolution.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

pub const PINNED_VERSION: &str = "0.0.83";
const PACKAGE_JSON: &str = include_str!("runtime/package.json");
// Not named package-lock.json in the repo: .gitignore drops every npm
// lockfile, and losing this one would break the build. Written back under its
// real name at install time.
const PACKAGE_LOCK: &str = include_str!("runtime/npm-lockfile.json");

/// `node_modules/@playwright/mcp/cli.js` under `dir`, once installed.
pub fn cli_path(dir: &Path) -> PathBuf {
    dir.join("node_modules").join("@playwright").join("mcp").join("cli.js")
}

pub fn node_bin() -> Result<PathBuf, String> {
    which::which("node").map_err(|_| "Node.js 20 or newer must be installed and on PATH for Claude's browser".to_string())
}

fn installed_version(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("node_modules/@playwright/mcp/package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v["version"].as_str().map(str::to_string)
}

/// Installs into `dir` unless the pinned version is already there.
pub async fn ensure_installed(dir: &Path) -> Result<(), String> {
    if installed_version(dir).as_deref() == Some(PINNED_VERSION) && cli_path(dir).is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::write(dir.join("package.json"), PACKAGE_JSON).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("package-lock.json"), PACKAGE_LOCK).map_err(|e| e.to_string())?;

    let node = node_bin()?;
    // npm's own entry script beside node.exe, so no `.cmd` shim is involved;
    // falls back to whatever `npm` PATH resolves.
    let npm_cli = node.parent().map(|d| d.join("node_modules/npm/bin/npm-cli.js")).filter(|p| p.is_file());
    let mut cmd = match &npm_cli {
        Some(cli) => {
            let mut c = Command::new(&node);
            c.arg(cli);
            c
        }
        None => Command::new(which::which("npm").map_err(|_| "npm not found on PATH".to_string())?),
    };
    cmd.args(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::util::process::hide_console_tokio(&mut cmd);
    log::info!("claude-browser: installing @playwright/mcp@{PINNED_VERSION} into {}", dir.display());
    let out = cmd.output().await.map_err(|e| format!("run npm ci: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("npm ci failed ({}): {tail}", out.status));
    }
    match installed_version(dir) {
        Some(v) if v == PINNED_VERSION => Ok(()),
        other => Err(format!("npm ci finished but installed version is {other:?}, expected {PINNED_VERSION}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lockfile is what `npm ci` installs, so it must pin the same
    /// version this module checks for, or every call reinstalls.
    #[test]
    fn embedded_lockfile_pins_the_checked_version() {
        let lock: serde_json::Value = serde_json::from_str(PACKAGE_LOCK).unwrap();
        assert_eq!(lock["packages"]["node_modules/@playwright/mcp"]["version"], PINNED_VERSION);
        let pkg: serde_json::Value = serde_json::from_str(PACKAGE_JSON).unwrap();
        assert_eq!(pkg["dependencies"]["@playwright/mcp"], PINNED_VERSION, "exact pin, no range");
    }

    /// Every package in the tree carries an integrity hash, so `npm ci`
    /// refuses a tampered tarball.
    #[test]
    fn every_locked_package_has_an_integrity_hash() {
        let lock: serde_json::Value = serde_json::from_str(PACKAGE_LOCK).unwrap();
        for (path, entry) in lock["packages"].as_object().unwrap() {
            if path.is_empty() {
                continue;
            }
            assert!(entry["integrity"].as_str().is_some_and(|s| s.starts_with("sha512-")), "{path} has no sha512 integrity");
        }
    }

    #[test]
    fn a_missing_install_reports_no_version() {
        assert_eq!(installed_version(tempfile::tempdir().unwrap().path()), None);
    }
}
