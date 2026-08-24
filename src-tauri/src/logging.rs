use crate::settings::paths;

/// Shared env_logger default filter for both the app binary's daemon mode
/// and the standalone `cc_conductor_daemon` bin, so the two never drift.
pub fn default_log_filter() -> &'static str {
    "info,iroh=warn,iroh_relay=warn,quinn=warn,netwatch=warn,portmapper=warn"
}

/// Initialize logging for the detached daemon process. The daemon is spawned
/// detached with no console, so without an explicit file target its log output
/// goes nowhere - which is why an unexpected daemon exit leaves no trail. Writes
/// to `<app-data>/daemon[-instance].log` (append). `RUST_LOG` overrides the default `info`
/// level. Best-effort: falls back to stderr if the file can't be opened, never
/// panics. Safe to call once at daemon startup.
/// Write every panic to `<app-data>/<file_name>` before the process dies.
/// Bypasses the `log` facade: a panic inside the logger would deadlock on it.
pub(crate) fn install_panic_hook(file_name: &str, tag: &'static str) {
    let Ok(path) = paths::data_dir().map(|dir| dir.join(file_name)) else { return };
    let orig = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        if let Ok(mut f) = open_append(&path) {
            let ts = chrono::Utc::now().to_rfc3339();
            let thread = std::thread::current();
            let who = thread.name().unwrap_or("<unnamed>");
            let _ = writeln!(f, "[{ts} ERROR claude_conductor_lib] {tag} PANIC on thread '{who}': {info}");
            let _ = f.flush();
        }
        orig(info);
    }));
}

fn open_append(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().create(true).append(true).open(path)
}

/// Reopens `daemon.log` by path when a write fails, so a stale, deleted, or
/// externally rotated handle recovers instead of dropping every line for the
/// rest of the process's life (todo 665). If recovery fails for any reason,
/// prints to stderr once so the outage is visible rather than silent.
struct ReopeningFileWriter {
    path: std::path::PathBuf,
    file: std::fs::File,
    warned: bool,
}

impl std::io::Write for ReopeningFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(n) = self.file.write(buf) {
            self.warned = false;
            return Ok(n);
        }
        // A reopen that succeeds but whose retry write still fails must warn too,
        // otherwise a full disk resumes the exact silent-dark mode todo 665 closed.
        let retried = open_append(&self.path).and_then(|reopened| {
            self.file = reopened;
            self.file.write(buf)
        });
        match retried {
            Ok(n) => {
                self.warned = false;
                Ok(n)
            }
            Err(e) => {
                if !self.warned {
                    eprintln!("daemon.log: write failed and recovery failed, logging is silent: {e}");
                    self.warned = true;
                }
                Err(e)
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

pub fn init_daemon_file_logger() {
    let log_name = paths::daemon_log_name();
    let log_path = paths::data_dir().ok().map(|dir| dir.join(&log_name));
    install_panic_hook(&log_name, "daemon");

    let file = log_path.and_then(|path| match open_append(&path) {
        Ok(file) => Some(ReopeningFileWriter { path, file, warned: false }),
        Err(e) => {
            eprintln!("daemon.log: could not open, logging to stderr only: {e}");
            None
        }
    });
    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default()
            .default_filter_or(default_log_filter()),
    );
    if let Some(file) = file {
        builder.target(env_logger::Target::Pipe(Box::new(file)));
    }
    if builder.try_init().is_err() {
        eprintln!("daemon.log: env_logger try_init failed, daemon logging is not active");
    }
}

#[cfg(test)]
mod daemon_file_logger_tests {
    use super::*;

    /// Swap in a read-only handle to simulate an invalidated write handle,
    /// then confirm the next write reopens by path and both lines land.
    #[test]
    fn reopen_recovers_after_stale_handle() {
        let dir = std::env::temp_dir().join(format!("cc-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        let file = open_append(&path).unwrap();
        let mut w = ReopeningFileWriter { path: path.clone(), file, warned: false };
        std::io::Write::write_all(&mut w, b"line1\n").unwrap();

        w.file = std::fs::OpenOptions::new().read(true).open(&path).unwrap();
        std::io::Write::write_all(&mut w, b"line2\n").unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("line1"));
        assert!(contents.contains("line2"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_append_fails_on_directory_path() {
        let dir = std::env::temp_dir().join(format!("cc-log-test-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(open_append(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
