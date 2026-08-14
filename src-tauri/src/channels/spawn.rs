use std::path::PathBuf;

#[derive(Debug)]
pub enum SpawnError {
    Io(std::io::Error),
    NonWindows,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::Io(e) => write!(f, "io: {e}"),
            SpawnError::NonWindows => write!(f, "channel spawning is Windows-only"),
        }
    }
}

impl std::error::Error for SpawnError {}

pub struct SpawnInput {
    pub project_id: String,
    pub cwd: PathBuf,
    pub session_name_prefix: String,
    pub continue_flag: bool,
    /// Per-account env mutation applied to the spawned child
    /// (`CLAUDE_CONFIG_DIR` override + credential-var scrub). Channels use
    /// the default account for now - see
    /// `docs/multi-account/02-chat-routing.md`.
    pub spawn_env: crate::accounts::env::SpawnEnv,
}

pub struct SpawnOutput {
    pub pid: u32,
    /// Raw Windows process HANDLE (as isize). Zero on non-windows stubs.
    /// Ownership: caller must CloseHandle once after WaitForSingleObject.
    pub process_handle: isize,
}

fn build_cmdline(input: &SpawnInput) -> String {
    fn quote(arg: &str) -> String {
        if !arg.is_empty()
            && !arg.contains(|c: char| c.is_whitespace() || c == '"')
        {
            return arg.to_string();
        }
        let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    }
    let mut parts: Vec<String> = vec![
        "cmd.exe".into(),
        "/C".into(),
        "claude".into(),
        "--remote-control".into(),
        "--remote-control-session-name-prefix".into(),
        quote(&input.session_name_prefix),
        // No --mcp-config/--settings here: both need a turn id known before
        // spawn, but a channel's real session id is only resolved after the fact.
        "--disallowedTools".into(),
        "AskUserQuestion".into(),
    ];
    if input.continue_flag {
        parts.push("--continue".into());
    }
    parts.join(" ")
}

#[cfg(windows)]
pub fn spawn_child(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
        STARTUPINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    // Required whenever `lpEnvironment` points at a UTF-16 block (ours does,
    // via `accounts::env::windows_env_block`) - without it Windows reads the
    // block as ANSI and mangles it.
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x00000400;

    let cmdline = build_cmdline(&input);
    let mut cmdline_w = crate::util::process::to_wide(&cmdline);
    let cwd_w: Vec<u16> = input
        .cwd
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE.0 as u16;
    let mut pi = PROCESS_INFORMATION::default();

    let flags = PROCESS_CREATION_FLAGS(
        CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
    );

    let effective_env = input.spawn_env.effective_env(std::env::vars());
    let env_block = crate::accounts::env::windows_env_block(&effective_env);

    let result = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline_w.as_mut_ptr()),
            None,
            None,
            false,
            flags,
            Some(env_block.as_ptr() as *const std::ffi::c_void),
            PCWSTR(cwd_w.as_ptr()),
            &si,
            &mut pi,
        )
    };
    if let Err(e) = result {
        return Err(SpawnError::Io(std::io::Error::from_raw_os_error(
            e.code().0,
        )));
    }

    unsafe {
        let _ = CloseHandle(pi.hThread);
    }

    Ok(SpawnOutput {
        pid: pi.dwProcessId,
        process_handle: pi.hProcess.0 as isize,
    })
}

#[cfg(target_os = "macos")]
pub fn spawn_child(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    let mut cmd = Command::new("claude");
    cmd.arg("--remote-control")
        .arg("--remote-control-session-name-prefix")
        .arg(&input.session_name_prefix)
        .arg("--disallowedTools")
        .arg("AskUserQuestion");
    if input.continue_flag {
        cmd.arg("--continue");
    }
    cmd.current_dir(&input.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    input.spawn_env.apply_std(&mut cmd);

    // Put the child in a new session + process group so killpg() can
    // tree-kill it plus every node subprocess it spawns.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(SpawnError::Io)?;
    let pid = child.id();
    // Drop `child`: `Child::drop` on Unix does not kill or reap; it only
    // closes stdio FDs (null stdio => nothing to close). The exit-watcher
    // reaps via `waitpid` exactly once (see wait_for_child_exit).
    drop(child);

    Ok(SpawnOutput {
        pid,
        process_handle: 0,
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn spawn_child(_input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    Err(SpawnError::NonWindows)
}

pub async fn spawn(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    spawn_child(input)
}

/// Block until the child exits. On Windows, waits on the HANDLE and closes
/// it. On macOS, reaps via waitpid. Returns instantly on other unix.
#[cfg(windows)]
pub(crate) async fn wait_for_child_exit(process_handle: isize, _pid: u32) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    let _ = tokio::task::spawn_blocking(move || unsafe {
        let h = HANDLE(process_handle as *mut std::ffi::c_void);
        let _ = WaitForSingleObject(h, INFINITE);
        let _ = CloseHandle(h);
    })
    .await;
}

#[cfg(target_os = "macos")]
pub(crate) async fn wait_for_child_exit(_process_handle: isize, pid: u32) {
    let _ = tokio::task::spawn_blocking(move || unsafe {
        let mut status: libc::c_int = 0;
        libc::waitpid(pid as libc::pid_t, &mut status, 0);
    })
    .await;
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) async fn wait_for_child_exit(_process_handle: isize, _pid: u32) {}

/// Resolve the actual `claude` pid for a spawned channel.
///
/// On Windows the channel is launched as `cmd.exe /C claude ...`, so the
/// spawned pid is the `cmd.exe` wrapper and the real `claude` runs as its
/// child. The SessionStart hook reports claude's pid, so the daemon must
/// resolve the child to correlate the channel (else it stays tagged External).
/// On macOS the channel is `claude` directly, so the spawned pid IS claude's.
#[cfg(windows)]
pub fn resolve_claude_pid(spawned_pid: u32) -> Option<u32> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All);
    sys.processes().iter().find_map(|(pid, proc_)| {
        let is_child = proc_.parent() == Some(Pid::from_u32(spawned_pid));
        let is_claude = proc_
            .name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("claude");
        (is_child && is_claude).then_some(pid.as_u32())
    })
}

#[cfg(target_os = "macos")]
pub fn resolve_claude_pid(spawned_pid: u32) -> Option<u32> {
    Some(spawned_pid)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn resolve_claude_pid(_spawned_pid: u32) -> Option<u32> {
    None
}
