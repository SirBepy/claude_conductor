//! Windows implementation of SignalSource.
//! - camera/mic: read the CapabilityAccessManager ConsentStore in HKCU. Any app
//!   subkey whose `LastUsedTimeStop` == 0 means the device is in use right now.
//!   This is the same data behind the tray privacy icon, so it covers browser calls.
//! - audio: enumerate active audio render sessions, map each PID to a process name,
//!   and match against the meeting-app allow list.
//!
//! Ported verbatim from tauri_kit_meeting.

#![cfg(windows)]

use super::signal::{process_name_matches, SignalSource};
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a `pid -> process name` snapshot stays valid before
/// `meeting_app_audio_active` forces a rebuild via `pid_name_map()` (a full
/// `CreateToolhelp32Snapshot` process-table walk), even if the active-audio
/// PID set hasn't changed. ~3 poll ticks at the mod-level 3s `POLL_INTERVAL`.
const PID_NAME_CACHE_TTL: Duration = Duration::from_secs(9);

#[derive(Default)]
struct AudioCache {
    names: HashMap<u32, String>,
    built_at: Option<Instant>,
    /// Sorted, so equality doesn't depend on WASAPI's session-enumeration order.
    last_pids: Vec<u32>,
}

#[derive(Default)]
pub struct WindowsSignalSource {
    audio_cache: RefCell<AudioCache>,
}

impl SignalSource for WindowsSignalSource {
    fn camera_in_use(&self) -> bool {
        consent_store_in_use("webcam")
    }
    fn mic_in_use(&self) -> bool {
        consent_store_in_use("microphone")
            || match active_capture_pids() {
                Ok(pids) => !pids.is_empty(),
                Err(e) => {
                    log::warn!("meeting: capture session scan failed: {e}");
                    false
                }
            }
    }
    fn meeting_app_audio_active(&self, allow: &[String]) -> bool {
        if allow.is_empty() {
            return false;
        }
        match active_audio_pids() {
            Ok(pids) if !pids.is_empty() => self.pids_match_allowlist(&pids, allow),
            Ok(_) => false,
            Err(e) => {
                log::warn!("meeting: audio session scan failed: {e}");
                false
            }
        }
    }
}

impl WindowsSignalSource {
    /// Matches `pids` (the current active-audio-session PIDs, already known
    /// non-empty) against `allow`, rebuilding the cached name map only when
    /// the PID set has changed since the last poll or the cache has aged past
    /// `PID_NAME_CACHE_TTL` - whichever comes first. A stale cache is safe: a
    /// PID unknown to it just fails the match for one extra poll tick, and
    /// Windows doesn't reuse a PID within a single 3s tick.
    fn pids_match_allowlist(&self, pids: &[u32], allow: &[String]) -> bool {
        let mut sorted = pids.to_vec();
        sorted.sort_unstable();

        let mut cache = self.audio_cache.borrow_mut();
        let stale = cache.built_at.map_or(true, |t| t.elapsed() >= PID_NAME_CACHE_TTL);
        let changed = sorted != cache.last_pids;
        if stale || changed {
            cache.names = pid_name_map();
            cache.built_at = Some(Instant::now());
            cache.last_pids = sorted;
        }

        pids.iter().any(|pid| {
            cache.names.get(pid).map(|n| process_name_matches(n, allow)).unwrap_or(false)
        })
    }
}

// ---- registry (camera / mic) ----

use crate::util::process::to_wide;

/// Returns true if any app under
/// `...\CapabilityAccessManager\ConsentStore\<device>` (or its `NonPackaged`
/// subtree) currently holds the device (LastUsedTimeStop == 0).
fn consent_store_in_use(device: &str) -> bool {
    let base = format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{device}"
    );
    if any_child_active(&base) {
        return true;
    }
    any_child_active(&format!("{base}\\NonPackaged"))
}

/// Open `parent`, enumerate its immediate subkeys, and return true if any subkey
/// has a `LastUsedTimeStop` value equal to 0.
fn any_child_active(parent: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let wparent = to_wide(parent);
    let mut hkey = HKEY::default();
    let opened = unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(wparent.as_ptr()), 0, KEY_READ, &mut hkey)
    };
    if opened != ERROR_SUCCESS {
        return false;
    }

    let mut found = false;
    let mut index = 0u32;
    loop {
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(
                hkey,
                index,
                windows::core::PWSTR(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                windows::core::PWSTR::null(),
                None,
                None,
            )
        };
        if rc != ERROR_SUCCESS {
            break;
        }
        let child = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let full = format!("{parent}\\{child}");
        if last_used_stop_is_zero(&full) {
            found = true;
            break;
        }
        index += 1;
    }
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    found
}

/// Read REG_QWORD `LastUsedTimeStop` under `key_path`; return true iff it equals 0.
fn last_used_stop_is_zero(key_path: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let wkey = to_wide(key_path);
    let wname = to_wide("LastUsedTimeStop");
    let mut hkey = HKEY::default();
    let opened = unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(wkey.as_ptr()), 0, KEY_READ, &mut hkey)
    };
    if opened != ERROR_SUCCESS {
        return false;
    }

    let mut data = [0u8; 8];
    let mut size = data.len() as u32;
    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(wname.as_ptr()),
            None,
            None,
            Some(data.as_mut_ptr()),
            Some(&mut size),
        )
    };
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    if rc != ERROR_SUCCESS {
        return false;
    }
    u64::from_le_bytes(data) == 0
}

// ---- WASAPI (audio render sessions) ----

/// PIDs that currently have an ACTIVE audio render session on the default endpoint.
fn active_audio_pids() -> Result<Vec<u32>, String> {
    active_session_pids(false)
}

/// PIDs that currently have an ACTIVE audio capture session on the default
/// microphone. Needed because the ConsentStore registry keys stopped updating
/// after the Oct 2026 Windows updates (a Google Meet call in Brave left no
/// trace there, verified 2026-11-03), so the registry alone misses browser calls.
fn active_capture_pids() -> Result<Vec<u32>, String> {
    active_session_pids(true)
}

fn active_session_pids(capture: bool) -> Result<Vec<u32>, String> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2,
        IAudioSessionEnumerator, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    let mut pids = Vec::new();
    unsafe {
        // Ignore RPC_E_CHANGED_MODE — COM may already be initialized on this thread.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(if capture { eCapture } else { eRender }, eConsole)
            .map_err(|e| e.to_string())?;
        let mgr: IAudioSessionManager2 =
            device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
        let sessions: IAudioSessionEnumerator =
            mgr.GetSessionEnumerator().map_err(|e| e.to_string())?;
        let count = sessions.GetCount().map_err(|e| e.to_string())?;

        for i in 0..count {
            let ctrl = match sessions.GetSession(i) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if ctrl.GetState().map_err(|e| e.to_string())? != AudioSessionStateActive {
                continue;
            }
            let ctrl2: IAudioSessionControl2 = match ctrl.cast() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if let Ok(pid) = ctrl2.GetProcessId() {
                if pid != 0 {
                    pids.push(pid);
                }
            }
        }
    }
    Ok(pids)
}

/// Map every running PID to its process image name (e.g. "Teams.exe").
fn pid_name_map() -> HashMap<u32, String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut map = HashMap::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(s) => s,
            Err(_) => return map,
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                map.insert(entry.th32ProcessID, name);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check against the real default mic: `cargo test --lib -- --ignored
    /// live_capture_sessions --nocapture` while a Meet call is up must list the
    /// browser's pid. Ignored because the result depends on the machine's state.
    #[test]
    #[ignore]
    fn live_capture_sessions() {
        let pids = active_capture_pids().expect("capture scan");
        let names = pid_name_map();
        let shown: Vec<_> = pids.iter().map(|p| (p, names.get(p).cloned())).collect();
        println!("active capture sessions: {shown:?}");
    }
}
