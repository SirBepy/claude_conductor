use std::path::PathBuf;
use std::fs;
use std::io::Write;

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("daemon already running (pid {0})")]
    AlreadyHeld(u32),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
pub struct LockGuard {
    path: PathBuf,
}

impl LockGuard {
    pub fn acquire(path: PathBuf) -> Result<Self, LockError> {
        // Existing lockfile: live PID blocks; dead PID or malformed contents
        // (partial write from a crash, garbage) is treated as stale and
        // reclaimed. Single-instance daemon = no concurrent acquires expected,
        // so the TOCTOU window between this check and the create below is OK.
        if let Ok(contents) = fs::read_to_string(&path) {
            // A live pid alone is not proof: a daemon that died without
            // dropping the guard leaves its pid behind, and Windows recycles
            // pids fast (2026-11-28: the lock named pid 23220, by then a
            // pwsh.exe, and every daemon start refused for hours).
            if let Ok(existing_pid) = contents.trim().parse::<u32>() {
                if pid_process_name(existing_pid).is_some_and(|n| is_conductor_process(&n)) {
                    return Err(LockError::AlreadyHeld(existing_pid));
                }
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = fs::File::create(&path)?;
        writeln!(f, "{}", std::process::id())?;
        Ok(LockGuard { path })
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

use crate::util::process::pid_process_name;

/// Every binary that can hold this lock carries "conductor" in its name:
/// `claude-conductor.exe --daemon`, `cc_conductor_daemon`, and the test
/// harness `claude_conductor_lib-<hash>`.
fn is_conductor_process(name: &str) -> bool {
    name.to_ascii_lowercase().contains("conductor")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmpfile(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("cc-conductor-daemon-test-{}-{}.lock", name, std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn acquire_creates_lockfile_with_current_pid() {
        let p = tmpfile("acquire");
        let _g = LockGuard::acquire(p.clone()).expect("acquire");
        let contents = fs::read_to_string(&p).expect("read");
        let pid: u32 = contents.trim().parse().expect("pid");
        assert_eq!(pid, std::process::id());
    }

    #[test]
    fn drop_removes_lockfile() {
        let p = tmpfile("drop");
        {
            let _g = LockGuard::acquire(p.clone()).expect("acquire");
            assert!(p.exists());
        }
        assert!(!p.exists());
    }

    #[test]
    fn stale_pid_is_reclaimed() {
        let p = tmpfile("stale");
        // Write a definitely-dead PID (max u32 - unlikely to ever be a real PID).
        let mut f = fs::File::create(&p).expect("create");
        writeln!(f, "{}", u32::MAX).expect("write");
        drop(f);
        let _g = LockGuard::acquire(p.clone()).expect("reclaim stale");
        let contents = fs::read_to_string(&p).expect("read");
        assert_eq!(contents.trim().parse::<u32>().unwrap(), std::process::id());
    }

    #[test]
    fn live_pid_of_an_unrelated_process_is_reclaimed() {
        let p = tmpfile("recycled");
        let mut child = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
            .args(if cfg!(windows) { &["-n", "30", "127.0.0.1"][..] } else { &["30"][..] })
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn unrelated process");
        let mut f = fs::File::create(&p).expect("create");
        writeln!(f, "{}", child.id()).expect("write");
        drop(f);
        let got = LockGuard::acquire(p.clone());
        let _ = child.kill();
        let _ = child.wait();
        let _g = got.expect("a recycled pid must not block the lock");
        assert_eq!(fs::read_to_string(&p).unwrap().trim().parse::<u32>().unwrap(), std::process::id());
    }

    #[test]
    fn conductor_names_match_and_others_do_not() {
        assert!(is_conductor_process("claude-conductor.exe"));
        assert!(is_conductor_process("cc_conductor_daemon"));
        assert!(!is_conductor_process("pwsh.exe"));
    }

    #[test]
    fn live_pid_blocks_acquire() {
        let p = tmpfile("live");
        // Use our own PID (definitely alive).
        let mut f = fs::File::create(&p).expect("create");
        writeln!(f, "{}", std::process::id()).expect("write");
        drop(f);
        match LockGuard::acquire(p.clone()) {
            Err(LockError::AlreadyHeld(pid)) => assert_eq!(pid, std::process::id()),
            other => panic!("expected AlreadyHeld, got {other:?}"),
        }
        // Cleanup
        let _ = fs::remove_file(&p);
    }
}
