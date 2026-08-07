#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Convert a UTF-8 string to a null-terminated UTF-16 buffer for Windows APIs.
#[cfg(windows)]
pub(crate) fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Apply Windows-only console-suppression flag so spawning a console-subsystem
/// binary (claude.exe, git.exe, ...) from a GUI Tauri app doesn't flash a black
/// console window. No-op on non-Windows platforms.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Same as `hide_console` but for `tokio::process::Command`. Tokio's Command
/// re-exports the Windows-only `creation_flags` extension.
pub fn hide_console_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Strip the inherit flag from a bound TCP listener's socket so it does NOT
/// leak into daemon-spawned children. The daemon spawns children with piped
/// stdio, which on Windows forces `bInheritHandles=TRUE`: every inheritable
/// handle in this process is copied into every child (chat `claude -p`
/// processes, pty channels, and their MCP grandchildren). If a listen socket
/// leaks, killing the daemon leaves the port bound by its surviving children
/// and no new daemon can ever rebind it (the 2026-06-12 port-hostage incident).
/// Call this right after binding, before any child is spawned. No-op off Windows.
pub fn mark_listener_non_inheritable(listener: &tokio::net::TcpListener) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows::Win32::Foundation::{
            SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
        };
        // SAFETY: the raw socket is owned by `listener`, which outlives the call.
        let _ = unsafe {
            SetHandleInformation(
                HANDLE(listener.as_raw_socket() as _),
                HANDLE_FLAG_INHERIT.0,
                HANDLE_FLAGS(0),
            )
        };
    }
    #[cfg(not(windows))]
    {
        let _ = listener;
    }
}

/// Lazily-built process-wide job object, stored as a raw handle value because
/// `HANDLE` is neither Send nor Sync. Deliberately never closed: the daemon
/// exiting is what closes it, and that close is the reap trigger. `None` means
/// creation failed, in which case callers silently skip the guard.
#[cfg(windows)]
fn orphan_guard_job() -> Option<usize> {
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: std::sync::OnceLock<Option<usize>> = std::sync::OnceLock::new();
    *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        Some(job.0 as usize)
    })
}

/// Bind a just-spawned child and every process it goes on to spawn to the
/// daemon's job object, so the OS reaps the whole tree the moment the daemon
/// dies - including a hard kill that never reaches `kill_tree`, whose snapshot
/// BFS also misses grandchildren spawned after the snapshot. Best-effort.
pub fn guard_orphan_tree(child: &tokio::process::Child) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        let (Some(job), Some(handle)) = (orphan_guard_job(), child.raw_handle()) else {
            return;
        };
        // SAFETY: `handle` is owned by `child`, which outlives this call.
        if let Err(e) = unsafe { AssignProcessToJobObject(HANDLE(job as _), HANDLE(handle as _)) } {
            log::warn!("orphan guard: AssignProcessToJobObject failed: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

#[cfg(all(test, windows))]
mod orphan_guard_tests {
    #[tokio::test]
    async fn guard_orphan_tree_assigns_child_to_the_job() {
        use windows::Win32::Foundation::{BOOL, HANDLE};
        use windows::Win32::System::JobObjects::IsProcessInJob;

        let mut child = tokio::process::Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn probe child");
        super::guard_orphan_tree(&child);

        let job = HANDLE(super::orphan_guard_job().expect("job created") as _);
        let proc = HANDLE(child.raw_handle().expect("child handle") as _);
        let mut in_job = BOOL(0);
        let probe = unsafe { IsProcessInJob(proc, job, &mut in_job) };
        let _ = child.kill().await;

        probe.expect("IsProcessInJob");
        assert!(in_job.as_bool(), "child never landed in the orphan-guard job");
    }
}

/// Process-wide shared `System`, so repeated live-pid checks (lockfile
/// startup, the detector's 5s tick, the channel-adopt exit watcher's 5s poll)
/// refresh the same process table in place instead of each allocating and
/// tearing down a fresh one. Lazily built on first use.
fn shared_system() -> &'static std::sync::Mutex<sysinfo::System> {
    static SYSTEM: std::sync::OnceLock<std::sync::Mutex<sysinfo::System>> = std::sync::OnceLock::new();
    SYSTEM.get_or_init(|| std::sync::Mutex::new(sysinfo::System::new()))
}

/// Whether a process with `pid` is currently alive. Centralizes the sysinfo
/// dance so the `refresh_processes` / `Pid::from_u32` contract lives in one
/// place. Used by the daemon lockfile's stale-vs-live reclaim.
pub fn pid_is_live(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate};
    let mut s = shared_system().lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All);
    s.process(Pid::from_u32(pid)).is_some()
}

/// Snapshot of every currently-live pid. Used by the detector's reconcile loop
/// to mark instances whose process has gone away.
pub fn live_pids() -> Vec<u32> {
    use sysinfo::ProcessesToUpdate;
    let mut s = shared_system().lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All);
    s.processes().keys().map(|p| p.as_u32()).collect()
}
