//! Locating the `claude` CLI.
//!
//! A GUI-launched app does not inherit the user's shell PATH. On macOS a
//! Finder/Dock launch gets launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, so a
//! `claude` under `~/.local/bin`, Homebrew, or a node version manager is
//! invisible and every spawn dies with a bare ENOENT that surfaces as
//! `io: No such file or directory (os error 2)`.
//! `docs/superpowers/specs/2026-04-24-macos-support-design.md:79` flagged this
//! and deliberately left it on the raw io path; this module is that fix.
//!
//! Resolution order, cheapest first:
//! 1. `CC_CLAUDE_BIN` - explicit override, wins over everything.
//! 2. `which::which("claude")` - PATH lookup. On success the BARE NAME is
//!    returned, not the resolved path, so a platform where PATH already works
//!    (Windows, or a terminal-launched app) keeps its exact current spawn
//!    behavior including std's `.cmd` handling.
//! 3. Fixed install locations (`fixed_candidates`).
//! 4. Unix only: `$SHELL -lic 'command -v claude'`, which reads the user's own
//!    rc files. This is the only step that finds a version-manager install
//!    (nvm/fnm/asdf/mise), whose binary lives under a version directory that
//!    exists only in shell config. Runs at most once per process.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Escape hatch: full path to the CLI, honored ahead of every other lookup.
pub const BIN_ENV: &str = "CC_CLAUDE_BIN";

/// The `claude` CLI could not be located. Carries what was searched so the
/// message can be actionable instead of `os error 2`.
#[derive(Debug, Clone)]
pub struct NotFound {
    searched: Vec<PathBuf>,
    shell_probed: bool,
}

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "claude CLI not found. Searched PATH")?;
        if self.shell_probed {
            write!(f, ", your login shell")?;
        }
        for p in &self.searched {
            write!(f, ", {}", p.display())?;
        }
        write!(
            f,
            ". Install it (https://claude.com/claude-code), or set {BIN_ENV} to its full path, \
             then restart Claude Conductor."
        )
    }
}

impl std::error::Error for NotFound {}

/// Fixed install locations checked when PATH lookup fails. Version-manager
/// installs are NOT listed: their binary sits under a version directory only a
/// shell rc knows about, which `login_shell_probe` covers instead.
fn fixed_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(not(windows))]
    {
        if let Some(h) = home {
            // Native installer first, then the legacy local install, then the
            // per-user npm prefixes.
            v.push(h.join(".local/bin/claude"));
            v.push(h.join(".claude/local/claude"));
            v.push(h.join(".bun/bin/claude"));
            v.push(h.join(".volta/bin/claude"));
            v.push(h.join(".npm-global/bin/claude"));
            v.push(h.join(".yarn/bin/claude"));
        }
        v.push(PathBuf::from("/opt/homebrew/bin/claude"));
        v.push(PathBuf::from("/usr/local/bin/claude"));
        v.push(PathBuf::from("/usr/bin/claude"));
    }
    #[cfg(windows)]
    {
        if let Some(h) = home {
            v.push(h.join(".local/bin/claude.exe"));
            v.push(h.join(".local/bin/claude.cmd"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            v.push(PathBuf::from(appdata).join("npm/claude.cmd"));
        }
    }
    v
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// Ask the user's login shell where `claude` is. `-i` is load-bearing: nvm and
/// friends are commonly initialized from `.zshrc`/`.bashrc`, which a
/// non-interactive shell never reads. Falls back through progressively weaker
/// flag sets because not every `$SHELL` accepts `-l`/`-i`.
///
/// Compiled on every platform (rather than `cfg`-gated to unix) so the parsing
/// and timeout logic is exercised by the test suite on a Windows dev box too;
/// the Windows early-return below is what keeps it from ever running there.
fn login_shell_probe() -> Option<PathBuf> {
    static PROBE: OnceLock<Option<PathBuf>> = OnceLock::new();
    PROBE
        .get_or_init(|| {
            if cfg!(windows) {
                return None;
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            for flags in ["-lic", "-lc", "-ic", "-c"] {
                if let Some(p) = run_shell(&shell, flags) {
                    log::info!("claude_bin: {shell} {flags} resolved claude at {}", p.display());
                    return Some(p);
                }
            }
            None
        })
        .clone()
}

/// One `$SHELL <flags> 'command -v claude'` attempt, bounded so a slow or
/// blocking rc file cannot hang the daemon forever. Returns the last stdout
/// line that names an existing file: an interactive rc is free to print its
/// own banner before our output.
fn run_shell(shell: &str, flags: &str) -> Option<PathBuf> {
    run_shell_command(shell, &[flags, "command -v claude"])
}

/// Core spawn/wait/read logic, parameterized on the full arg list so a test
/// can drive it with a synthetic command instead of a real login shell.
fn run_shell_command(shell: &str, args: &[&str]) -> Option<PathBuf> {
    use std::fs::OpenOptions;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    // A pipe has a finite OS buffer (typically 64KB); nothing reads it until
    // this loop's try_wait already sees the child as exited, so an rc that
    // prints more than that before returning would block the child on
    // write() forever (the same hazard daemon/lifecycle/spawn.rs's
    // drain_stderr comment describes). Redirect to a file instead: a file
    // has no such ceiling, so the deadlock is gone by construction.
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let out_path = std::env::temp_dir()
        .join(format!("cc-claude-bin-probe-{}-{unique}.out", std::process::id()));
    let out_file =
        OpenOptions::new().create(true).truncate(true).write(true).open(&out_path).ok()?;

    let mut child = Command::new(shell)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    log::warn!("claude_bin: `{shell} {}` timed out, killing it", args.join(" "));
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&out_path);
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => {
                let _ = std::fs::remove_file(&out_path);
                return None;
            }
        }
    }

    let stdout = std::fs::read_to_string(&out_path).unwrap_or_default();
    let _ = std::fs::remove_file(&out_path);
    parse_shell_output(&stdout)
}

/// Split out from `run_shell` so the banner-noise handling is testable without
/// spawning a shell.
fn parse_shell_output(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .rev()
        .map(|l| PathBuf::from(l.trim()))
        .find(|p| p.is_absolute() && p.is_file())
}

/// The program to hand `Command::new`, or a `NotFound` naming what was tried.
///
/// A successful resolution is cached for the life of the process; a failed one
/// is not, so installing the CLI and reopening a chat works without a restart
/// (the login-shell probe still runs only once either way, since it is the
/// expensive step).
pub fn resolve() -> Result<OsString, NotFound> {
    static FOUND: OnceLock<OsString> = OnceLock::new();
    if let Some(hit) = FOUND.get() {
        return Ok(hit.clone());
    }

    if let Some(over) = std::env::var_os(BIN_ENV) {
        let p = PathBuf::from(&over);
        if p.is_file() {
            let _ = FOUND.set(over.clone());
            return Ok(over);
        }
        log::warn!("claude_bin: {BIN_ENV} is set to {} but that is not a file", p.display());
    }

    // PATH already works: keep the bare name so nothing about the current
    // spawn behavior changes on platforms that were never broken.
    if which::which("claude").is_ok() {
        let bare = OsString::from("claude");
        let _ = FOUND.set(bare.clone());
        return Ok(bare);
    }

    let home = dirs::home_dir();
    let candidates = fixed_candidates(home.as_deref());
    if let Some(p) = first_existing(&candidates) {
        log::info!("claude_bin: PATH lookup failed, using {}", p.display());
        let found: OsString = p.into_os_string();
        let _ = FOUND.set(found.clone());
        return Ok(found);
    }

    if let Some(p) = login_shell_probe() {
        let found: OsString = p.into_os_string();
        let _ = FOUND.set(found.clone());
        return Ok(found);
    }

    Err(NotFound { searched: candidates, shell_probed: cfg!(not(windows)) })
}

/// Lenient variant for spawn sites that already treat a failure to launch as a
/// soft, logged error (auth probes, the news summarizer, the ask sidecar).
/// Falls back to the bare name so those paths keep their existing behavior and
/// their existing error text when the CLI genuinely is not installed.
pub fn program() -> OsString {
    resolve().unwrap_or_else(|e| {
        log::debug!("claude_bin: {e}");
        OsString::from("claude")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_candidates_prefer_the_home_install_over_system_paths() {
        let home = PathBuf::from("/home/j");
        let c = fixed_candidates(Some(&home));
        assert!(!c.is_empty(), "every platform must offer at least one candidate");
        #[cfg(not(windows))]
        {
            assert_eq!(c[0], home.join(".local/bin/claude"), "native installer wins");
            let sys = c.iter().position(|p| p == Path::new("/opt/homebrew/bin/claude")).unwrap();
            let legacy = c.iter().position(|p| p == &home.join(".claude/local/claude")).unwrap();
            assert!(legacy < sys, "a per-user install outranks a system one");
        }
    }

    #[test]
    fn fixed_candidates_without_a_home_dir_still_lists_system_paths() {
        let c = fixed_candidates(None);
        assert!(c.iter().all(|p| p.is_absolute()), "candidates must be absolute");
        #[cfg(not(windows))]
        assert!(c.contains(&PathBuf::from("/usr/local/bin/claude")));
    }

    #[test]
    fn first_existing_picks_the_earliest_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing/claude");
        let real = dir.path().join("claude");
        std::fs::write(&real, b"#!/bin/sh\n").unwrap();
        let also_real = dir.path().join("claude2");
        std::fs::write(&also_real, b"#!/bin/sh\n").unwrap();

        assert_eq!(
            first_existing(&[missing.clone(), real.clone(), also_real]),
            Some(real),
            "order decides, not existence alone"
        );
        assert_eq!(first_existing(&[missing]), None);
    }

    #[test]
    fn first_existing_rejects_a_directory_with_the_right_name() {
        let dir = tempfile::tempdir().unwrap();
        let as_dir = dir.path().join("claude");
        std::fs::create_dir(&as_dir).unwrap();
        assert_eq!(first_existing(&[as_dir]), None);
    }

    #[test]
    fn parse_shell_output_ignores_rc_banner_noise() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("claude");
        std::fs::write(&real, b"#!/bin/sh\n").unwrap();

        let stdout = format!("Welcome back!\nnvm: using node 22\n{}\n", real.display());
        assert_eq!(parse_shell_output(&stdout), Some(real));
        assert_eq!(parse_shell_output("claude not found\n"), None, "a relative word is not a path");
        assert_eq!(parse_shell_output(""), None);
    }

    /// A real POSIX shell on this machine, or `None` if none is reachable
    /// (this test is skipped rather than failed in that case, since some
    /// dev/CI boxes may lack one).
    fn locate_posix_shell_for_test() -> Option<&'static str> {
        #[cfg(not(windows))]
        {
            for candidate in ["/bin/sh", "/bin/bash"] {
                if Path::new(candidate).is_file() {
                    return Some(candidate);
                }
            }
        }
        #[cfg(windows)]
        {
            // Git for Windows ships a real POSIX sh/bash at this fixed path
            // on both dev boxes and GitHub's windows-latest runners.
            for candidate in [
                r"C:\Program Files\Git\bin\sh.exe",
                r"C:\Program Files\Git\bin\bash.exe",
            ] {
                if Path::new(candidate).is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    #[test]
    fn run_shell_command_survives_output_over_the_pipe_buffer_before_the_real_path() {
        let Some(shell) = locate_posix_shell_for_test() else {
            eprintln!("no posix shell found on this machine, skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("claude");
        std::fs::write(&real, b"#!/bin/sh\n").unwrap();

        // ~2000 lines of ~35 bytes each is well over the ~64KB default pipe
        // buffer, the way a chatty rc file (set -x tracing, a banner) would
        // print before the actual `command -v claude` output.
        let noisy = format!(
            "for i in $(seq 1 2000); do echo 'noise line filling the pipe buffer'; done; printf '%s\\n' '{}'",
            real.display()
        );
        let got = run_shell_command(shell, &["-c", &noisy]);
        assert_eq!(got, Some(real), "output past the OS pipe buffer must not deadlock the probe");
    }

    #[test]
    fn not_found_message_names_the_override_and_a_searched_path() {
        let e = NotFound {
            searched: vec![PathBuf::from("/opt/homebrew/bin/claude")],
            shell_probed: true,
        };
        let msg = e.to_string();
        assert!(msg.contains(BIN_ENV), "the escape hatch must be discoverable from the error");
        assert!(msg.contains("/opt/homebrew/bin/claude"));
        assert!(msg.contains("login shell"));
    }
}
