//! Warns Joe before the PC runs out of RAM while the chat fleet builds. It only
//! warns: nothing is ever killed or throttled here.
//!
//! Every 30s the daemon samples system memory. Crossing 90% used fires one
//! `ram_warning` notification naming the chat whose process tree holds the most
//! working set; the guard re-arms once usage falls back under 85%, so a PC
//! hovering near the line warns once per crossing instead of every sample.

use crate::daemon::state::DaemonState;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
const WARN_ABOVE_PCT: f64 = 90.0;
const REARM_BELOW_PCT: f64 = 85.0;
pub const EVENT: &str = "ram_warning";

/// Hysteresis between the warn and re-arm lines.
#[derive(Debug)]
struct Guard {
    armed: bool,
}

impl Guard {
    fn new() -> Self {
        Self { armed: true }
    }

    /// True when this sample is a fresh crossing that should warn.
    fn observe(&mut self, used_pct: f64) -> bool {
        if self.armed && used_pct > WARN_ABOVE_PCT {
            self.armed = false;
            return true;
        }
        if !self.armed && used_pct < REARM_BELOW_PCT {
            self.armed = true;
        }
        false
    }
}

/// One live process: pid, parent pid, working set in bytes.
#[derive(Clone, Copy, Debug)]
struct Proc {
    pid: u32,
    parent: Option<u32>,
    working_set: u64,
}

/// The chat whose claude process plus all its descendants hold the most memory.
/// `roots` pairs each chat's session id with its claude pid.
fn heaviest_chat(roots: &[(String, u32)], procs: &[Proc]) -> Option<(String, u64)> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut ws: HashMap<u32, u64> = HashMap::new();
    for p in procs {
        ws.insert(p.pid, p.working_set);
        if let Some(parent) = p.parent {
            children.entry(parent).or_default().push(p.pid);
        }
    }
    roots
        .iter()
        .map(|(sid, root)| {
            let mut total = 0u64;
            let mut seen = std::collections::HashSet::new();
            let mut stack = vec![*root];
            while let Some(pid) = stack.pop() {
                // `seen` guards a pid reused as its own ancestor.
                if !seen.insert(pid) {
                    continue;
                }
                total += ws.get(&pid).copied().unwrap_or(0);
                if let Some(kids) = children.get(&pid) {
                    stack.extend(kids);
                }
            }
            (sid.clone(), total)
        })
        .filter(|(_, total)| *total > 0)
        .max_by_key(|(_, total)| *total)
}

fn warning_text(used_pct: f64, heaviest: Option<(&str, &str, u64)>) -> String {
    let head = format!("RAM is {:.0}% full.", used_pct);
    match heaviest {
        Some((project, chat, bytes)) => format!(
            "{head} Heaviest chat: {project} / {chat} ({:.1} GB).",
            bytes as f64 / (1024.0 * 1024.0 * 1024.0)
        ),
        None => head,
    }
}

pub fn spawn(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        let mut guard = Guard::new();
        loop {
            ticker.tick().await;
            let roots: Vec<(String, u32)> = state
                .registry
                .list()
                .into_iter()
                .filter(|i| i.ended_at.is_none() && i.pid != 0)
                .map(|i| (i.session_id, i.pid))
                .collect();
            // The process-table walk is blocking work, so it stays off the runtime.
            let sample = tokio::task::spawn_blocking(move || sample_system(&roots)).await;
            let Ok((used_pct, heavy)) = sample else { continue };
            if !guard.observe(used_pct) {
                continue;
            }
            let heavy = heavy.and_then(|(sid, bytes)| {
                let inst = state.registry.get(&sid)?;
                let settings = state.settings.snapshot();
                let project = settings
                    .projects
                    .iter()
                    .find(|p| p.id == inst.project_id)
                    .map(|p| p.name.clone())
                    .or_else(|| inst.cwd.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| "Unknown project".to_string());
                let chat = inst.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| "Untitled chat".to_string());
                Some((project, chat, bytes))
            });
            let message = warning_text(used_pct, heavy.as_ref().map(|(p, c, b)| (p.as_str(), c.as_str(), *b)));
            log::warn!("ram_guard: {message}");
            state.notifier.publish(EVENT, serde_json::json!({ "used_pct": used_pct, "message": message }));
        }
    });
}

fn sample_system(roots: &[(String, u32)]) -> (f64, Option<(String, u64)>) {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    let used_pct = if total == 0 { 0.0 } else { sys.used_memory() as f64 * 100.0 / total as f64 };
    // Only a crossing needs the per-chat breakdown, but the walk is cheap next to
    // a 30s period and a separate "is it over" pass would race the sample.
    if used_pct <= WARN_ABOVE_PCT {
        return (used_pct, None);
    }
    sys.refresh_processes(ProcessesToUpdate::All);
    let procs: Vec<Proc> = sys
        .processes()
        .values()
        .map(|p| Proc { pid: p.pid().as_u32(), parent: p.parent().map(|x| x.as_u32()), working_set: p.memory() })
        .collect();
    (used_pct, heaviest_chat(roots, &procs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_once_per_crossing_and_rearms_below_85() {
        let mut g = Guard::new();
        assert!(!g.observe(89.0));
        assert!(g.observe(91.0));
        assert!(!g.observe(95.0), "still over: no second warning");
        assert!(!g.observe(87.0), "between the lines stays disarmed");
        assert!(!g.observe(91.0), "not re-armed yet");
        assert!(!g.observe(84.0));
        assert!(g.observe(92.0), "re-armed after dropping under 85");
    }

    #[test]
    fn exactly_90_does_not_warn() {
        assert!(!Guard::new().observe(90.0));
    }

    #[test]
    fn heaviest_chat_sums_the_whole_process_tree() {
        let p = |pid, parent, mb: u64| Proc { pid, parent, working_set: mb << 20 };
        let procs = [
            p(1, None, 100),
            p(2, Some(1), 50),
            p(3, Some(2), 3000), // rustc under chat A's cargo
            p(10, None, 1500),   // chat B alone is bigger than A's claude
            p(99, None, 9000),   // unrelated app, never counted
        ];
        let roots = vec![("a".to_string(), 1), ("b".to_string(), 10)];
        let (sid, bytes) = heaviest_chat(&roots, &procs).unwrap();
        assert_eq!(sid, "a");
        assert_eq!(bytes, 3150 << 20);
    }

    #[test]
    fn heaviest_chat_is_none_without_live_chats() {
        assert!(heaviest_chat(&[("a".into(), 5)], &[]).is_none());
        assert!(heaviest_chat(&[], &[Proc { pid: 1, parent: None, working_set: 1 }]).is_none());
    }

    #[test]
    fn warning_names_project_and_chat() {
        let t = warning_text(93.4, Some(("Conductor", "Fix lag", 3 << 30)));
        assert_eq!(t, "RAM is 93% full. Heaviest chat: Conductor / Fix lag (3.0 GB).");
        assert_eq!(warning_text(93.4, None), "RAM is 93% full.");
    }
}
