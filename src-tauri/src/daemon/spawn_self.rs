//! Spawn the daemon as a detached child of the app: `<current_exe> --daemon`.
//! Detached so closing the app does NOT take the daemon down. The daemon's
//! lockfile guards against a duplicate spawn if two app instances race here.

#[derive(Debug)]
pub enum SpawnSelfError {
    Io(std::io::Error),
    NoExe(std::io::Error),
}

impl std::fmt::Display for SpawnSelfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnSelfError::Io(e) => write!(f, "spawn daemon: {e}"),
            SpawnSelfError::NoExe(e) => write!(f, "resolve current exe: {e}"),
        }
    }
}
impl std::error::Error for SpawnSelfError {}

/// Spawn `<current_exe> --daemon` fully detached. Returns the new pid.
///
/// Prefers `CREATE_BREAKAWAY_FROM_JOB` so the daemon survives the app's job
/// object (the whole point: it must outlive the app). Some launch contexts run
/// the app inside a job that forbids breakaway, where `CreateProcessW` fails
/// with `ERROR_ACCESS_DENIED`; in that case we retry without breakaway so the
/// daemon at least starts (it then shares the parent job's lifetime rather than
/// failing to spawn at all).
#[cfg(windows)]
pub fn spawn_detached_daemon() -> Result<u32, SpawnSelfError> {
    let exe = std::env::current_exe().map_err(SpawnSelfError::NoExe)?;
    spawn_detached(&exe, &["--daemon".to_string()]).map_err(SpawnSelfError::Io)
}

/// Starts `exe` so it outlives this process and its job object. Also used
/// for Joe's own browser, which must never close because the daemon did.
#[cfg(windows)]
pub fn spawn_detached(exe: &std::path::Path, args: &[String]) -> Result<u32, std::io::Error> {
    // DETACHED_PROCESS: no console. NEW_PROCESS_GROUP + BREAKAWAY_FROM_JOB:
    // not reaped when the app (or its job object) exits.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    // HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED) as returned by the windows crate.
    const E_ACCESSDENIED: i32 = -2147024891; // 0x80070005

    let quote = |a: &str| if a.contains(' ') { format!("\"{a}\"") } else { a.to_string() };
    let mut cmdline = format!("\"{}\"", exe.to_string_lossy());
    for a in args {
        cmdline.push(' ');
        cmdline.push_str(&quote(a));
    }
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

    match create_process(&cmdline, base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(pid) => Ok(pid),
        Err(e) if e.raw_os_error() == Some(E_ACCESSDENIED) => {
            log::warn!(
                "detached spawn of {}: CREATE_BREAKAWAY_FROM_JOB denied; retrying without breakaway \
                 (it will share the parent job's lifetime)",
                exe.display()
            );
            create_process(&cmdline, base)
        }
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn create_process(cmdline: &str, flags: u32) -> Result<u32, std::io::Error> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let mut cmdline_w = crate::util::process::to_wide(&cmdline);
    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi = PROCESS_INFORMATION::default();

    let result = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline_w.as_mut_ptr()),
            None,
            None,
            false,
            PROCESS_CREATION_FLAGS(flags),
            None,
            PCWSTR::null(),
            &si,
            &mut pi,
        )
    };
    if let Err(e) = result {
        return Err(std::io::Error::from_raw_os_error(e.code().0));
    }
    unsafe {
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
    }
    Ok(pi.dwProcessId)
}

/// Spawn `<current_exe> --daemon` detached on Unix (macOS + Linux).
///
/// `setsid()` in `pre_exec` puts the daemon in its own session so it outlives
/// the app's session/controlling terminal (mirrors the macOS channel spawn).
/// stdio is redirected to /dev/null so it holds no app file handles.
#[cfg(unix)]
pub fn spawn_detached_daemon() -> Result<u32, SpawnSelfError> {
    let exe = std::env::current_exe().map_err(SpawnSelfError::NoExe)?;
    spawn_detached(&exe, &["--daemon".to_string()]).map_err(SpawnSelfError::Io)
}

/// Starts `exe` in its own session so it outlives this process.
#[cfg(unix)]
pub fn spawn_detached(exe: &std::path::Path, args: &[String]) -> Result<u32, std::io::Error> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and the only call in pre_exec.
    unsafe {
        cmd.pre_exec(|| {
            // New session leader; detaches from the app's session. Failure here
            // (e.g. already a group leader) is non-fatal for our purposes.
            let _ = libc::setsid();
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    Ok(child.id())
}
