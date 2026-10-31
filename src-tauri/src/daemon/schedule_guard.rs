//! Pre-fire guard for scheduled items (`ScheduledItem::guard`): a shell command
//! `daemon::schedule` runs just before a firing would create its chat.
//!
//! Contract: exit 0 skips the firing, and the first non-empty stdout line is
//! the reason the panel shows. Everything else fires normally - a non-zero
//! exit, a timeout, a command that cannot start, an unreadable cwd. It fails
//! open because a wrong run costs one chat, while a wrong skip silently loses
//! the work the schedule exists to do.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// A guard is a quick check, not work. Past this the shell is killed and the
/// firing goes ahead.
const GUARD_TIMEOUT: Duration = Duration::from_secs(30);
/// Only the first line is ever used (and cut to `MAX_REASON_CHARS`), so a
/// runaway guard must not be able to grow the daemon's memory for 30 s.
const MAX_STDOUT_BYTES: u64 = 64 * 1024;
const MAX_REASON_CHARS: usize = 200;
const FALLBACK_REASON: &str = "guard said skip";

#[derive(Debug, PartialEq)]
pub(crate) enum GuardVerdict {
    Skip(String),
    Fire,
}

/// `item_id` and `fire_date` (the occurrence's local `YYYY-MM-DD`) reach the
/// command as `CC_SCHEDULE_ID` / `CC_SCHEDULE_DATE`, so a date-keyed marker
/// check needs no clock logic of its own.
pub(crate) async fn run(command: &str, cwd: &Path, item_id: &str, fire_date: &str) -> GuardVerdict {
    run_with_timeout(command, cwd, item_id, fire_date, GUARD_TIMEOUT).await
}

async fn run_with_timeout(
    command: &str,
    cwd: &Path,
    item_id: &str,
    fire_date: &str,
    timeout: Duration,
) -> GuardVerdict {
    let mut cmd = shell_command(command);
    cmd.current_dir(cwd)
        .env("CC_SCHEDULE_ID", item_id)
        .env("CC_SCHEDULE_DATE", fire_date)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Dropping the wait future on timeout is what kills the shell.
        .kill_on_drop(true);
    crate::util::process::hide_console_tokio(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("schedule guard for {item_id}: cannot start ({e}); firing normally");
            return GuardVerdict::Fire;
        }
    };
    let Some(stdout) = child.stdout.take() else {
        log::warn!("schedule guard for {item_id}: no stdout pipe; firing normally");
        return GuardVerdict::Fire;
    };
    // The child moves into this future, so the timeout dropping it is what
    // kills the shell.
    let run = async move {
        let head = read_head_and_drain(stdout, MAX_STDOUT_BYTES).await?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, head))
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(Ok((status, head))) if status.success() => {
            GuardVerdict::Skip(reason_from(&String::from_utf8_lossy(&head)))
        }
        Ok(Ok(_)) => GuardVerdict::Fire,
        Ok(Err(e)) => {
            log::warn!("schedule guard for {item_id}: wait failed ({e}); firing normally");
            GuardVerdict::Fire
        }
        Err(_) => {
            log::warn!("schedule guard for {item_id}: no answer in {timeout:?}; firing normally");
            GuardVerdict::Fire
        }
    }
}

/// Keeps the first `cap` bytes and discards the rest. The remainder is still
/// read to EOF because a child blocked on a full pipe would never exit, and
/// the exit code is the verdict.
async fn read_head_and_drain<R>(mut reader: R, cap: u64) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut head = Vec::new();
    (&mut reader).take(cap).read_to_end(&mut head).await?;
    tokio::io::copy(&mut reader, &mut tokio::io::sink()).await?;
    Ok(head)
}

/// Windows Powershell 5.1 on purpose: PowerShell 7 is not guaranteed to be
/// installed, and 5.1 ships with the OS.
fn shell_command(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    }
}

fn reason_from(stdout: &str) -> String {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(FALLBACK_REASON);
    line.chars().take(MAX_REASON_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // `echo`, `exit` and `sleep` mean the same in PowerShell and sh, so one
    // command set covers both platforms' shell_command. Echoed text is quoted:
    // bare `echo a b` is two output lines in PowerShell, one in sh.
    async fn verdict(command: &str) -> GuardVerdict {
        run_with_timeout(command, Path::new("."), "item-1", "2026-10-30", Duration::from_secs(20)).await
    }

    #[tokio::test]
    async fn exit_zero_skips_with_the_first_stdout_line_as_reason() {
        assert_eq!(
            verdict("echo 'already ran for 2026-10-30'; echo 'second line'; exit 0").await,
            GuardVerdict::Skip("already ran for 2026-10-30".to_string())
        );
    }

    #[tokio::test]
    async fn exit_zero_with_no_output_skips_with_the_fallback_reason() {
        assert_eq!(verdict("exit 0").await, GuardVerdict::Skip(FALLBACK_REASON.to_string()));
    }

    #[tokio::test]
    async fn any_non_zero_exit_fires() {
        assert_eq!(verdict("echo nope; exit 3").await, GuardVerdict::Fire);
    }

    #[tokio::test]
    async fn a_missing_command_fires() {
        assert_eq!(verdict("definitely-not-a-command-cc-guard").await, GuardVerdict::Fire);
    }

    #[tokio::test]
    async fn a_missing_cwd_fires() {
        let v = run_with_timeout("exit 0", Path::new("Z:/does/not/exist"), "i", "d", Duration::from_secs(20)).await;
        assert_eq!(v, GuardVerdict::Fire);
    }

    #[tokio::test]
    async fn a_command_that_outlives_the_timeout_fires() {
        let started = std::time::Instant::now();
        let v = run_with_timeout("sleep 30; exit 0", Path::new("."), "i", "d", Duration::from_millis(500)).await;
        assert_eq!(v, GuardVerdict::Fire);
        assert!(started.elapsed() < Duration::from_secs(15), "the shell must be abandoned at the timeout");
    }

    #[tokio::test]
    async fn the_item_id_and_fire_date_reach_the_command() {
        #[cfg(windows)]
        let cmd = "echo \"$env:CC_SCHEDULE_ID $env:CC_SCHEDULE_DATE\"; exit 0";
        #[cfg(not(windows))]
        let cmd = "echo \"$CC_SCHEDULE_ID $CC_SCHEDULE_DATE\"; exit 0";
        assert_eq!(verdict(cmd).await, GuardVerdict::Skip("item-1 2026-10-30".to_string()));
    }

    #[tokio::test]
    async fn only_a_prefix_is_kept_and_the_rest_is_still_consumed() {
        let data = vec![b'x'; 1024 * 1024];
        let mut reader = &data[..];
        let head = read_head_and_drain(&mut reader, MAX_STDOUT_BYTES).await.unwrap();
        assert_eq!(head.len() as u64, MAX_STDOUT_BYTES);
        assert!(reader.is_empty(), "the tail must be drained so the child never blocks on a full pipe");
    }

    // ~4 MB of output, well past MAX_STDOUT_BYTES, with the reason on line one.
    #[cfg(windows)]
    const FLOOD: &str = "echo 'flood reason'; 1..40000 | ForEach-Object { 'y' * 100 }";
    #[cfg(not(windows))]
    const FLOOD: &str = "echo 'flood reason'; yes yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy | head -c 4000000";

    #[tokio::test]
    async fn a_flood_of_output_keeps_the_exit_verdict_and_first_line_reason() {
        assert_eq!(
            verdict(&format!("{FLOOD}; exit 0")).await,
            GuardVerdict::Skip("flood reason".to_string())
        );
        assert_eq!(verdict(&format!("{FLOOD}; exit 3")).await, GuardVerdict::Fire);
    }

    #[test]
    fn the_reason_is_trimmed_skips_blank_lines_and_is_capped() {
        assert_eq!(reason_from("\n  \n  hello  \nworld"), "hello");
        assert_eq!(reason_from(&"x".repeat(500)).chars().count(), MAX_REASON_CHARS);
    }
}
