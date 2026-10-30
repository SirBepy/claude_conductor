#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        // Snapshot all processes, then BFS from `pid` to collect descendants.
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => {
                // No snapshot - best-effort direct kill of the root pid.
                if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(h, 1);
                    let _ = CloseHandle(h);
                }
                return;
            }
        };

        let mut entries: Vec<(u32, u32)> = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                entries.push((entry.th32ParentProcessID, entry.th32ProcessID));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);

        // BFS to find root + all descendants.
        let mut to_kill: Vec<u32> = Vec::new();
        let mut queue: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
        queue.push_back(pid);
        while let Some(parent) = queue.pop_front() {
            to_kill.push(parent);
            for &(ppid, cpid) in &entries {
                if ppid == parent && !to_kill.contains(&cpid) {
                    queue.push_back(cpid);
                }
            }
        }

        for kill_pid in to_kill {
            if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, kill_pid) {
                let _ = TerminateProcess(h, 1);
                let _ = CloseHandle(h);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn kill_tree(pid: u32) {
    // The spawned claude was setsid'd, so its PGID equals its PID.
    // killpg reaps every descendant (node subprocesses etc.) in one call.
    unsafe {
        if libc::killpg(pid as libc::pid_t, libc::SIGKILL) != 0 {
            // ESRCH (group already gone): try a direct kill as a last resort.
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn kill_tree(_pid: u32) {}

