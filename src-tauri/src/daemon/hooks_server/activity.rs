//! What the session is still doing at turn end, so a `done` report from a chat
//! parked on CI can be corrected. Payload shape, captured live 2026-08-18:
//! `background_tasks: [{id, type, status, description, command}]` plus a
//! `session_crons` array; the daemon used to keep only `.len()`.

use crate::sessions::registry_turn::TurnActivity;
use serde_json::Value;

/// Poll-shaped commands: the compute is on someone else's machine, so the
/// session is parked, not working (Joe's ruling, 2026-08-06). Deliberately
/// short - a false "waiting" is quieter than a list nobody can reason about.
const POLL_SHAPES: [&str; 4] = ["gh run watch", "gh pr checks", "gh run view", "gh workflow view"];

/// A `wait` subcommand, covering `kubectl wait`, `docker wait`, `aws ... wait`,
/// `az ... wait`, `gcloud ... wait` without naming each vendor.
fn is_wait_subcommand(segment: &str) -> bool {
    segment.split_whitespace().skip(1).any(|w| w == "wait")
}

fn segment_is_poll(segment: &str) -> bool {
    let s = segment.trim();
    if s.is_empty() {
        return false;
    }
    if s.split_whitespace().next() == Some("sleep") {
        return true;
    }
    POLL_SHAPES.iter().any(|p| s.contains(p)) || is_wait_subcommand(s)
}

/// EVERY chained segment must be poll-shaped. `sleep 5 && cargo build` is a
/// build with a delay in front of it, not a wait.
fn command_is_poll(command: &str) -> bool {
    let mut segments = command
        .split(|c| c == ';' || c == '&' || c == '|')
        .filter(|s| !s.trim().is_empty())
        .peekable();
    segments.peek().is_some() && segments.all(segment_is_poll)
}

/// Absent `status` counts as running: an older CLI that omits the field must
/// not silently read as "nothing left to do".
fn is_running(task: &Value) -> bool {
    match task.get("status").and_then(Value::as_str) {
        Some(s) => s == "running",
        None => true,
    }
}

/// `Working` wins over `Waiting`: a local build running alongside a CI poll is
/// still work. A non-`shell` task is a subagent, which is always local work.
pub(crate) fn classify(background_tasks: &[Value], session_crons: &[Value]) -> TurnActivity {
    let running: Vec<&Value> = background_tasks.iter().filter(|t| is_running(t)).collect();
    for task in &running {
        let is_shell = task.get("type").and_then(Value::as_str) == Some("shell");
        let command = task.get("command").and_then(Value::as_str).unwrap_or("");
        if !is_shell || !command_is_poll(command) {
            return TurnActivity::Working;
        }
    }
    if !running.is_empty() || !session_crons.is_empty() {
        return TurnActivity::Waiting;
    }
    TurnActivity::Idle
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shell(command: &str) -> Value {
        json!({"id": "t1", "type": "shell", "status": "running", "command": command})
    }

    #[test]
    fn no_tasks_and_no_crons_is_idle() {
        assert_eq!(classify(&[], &[]), TurnActivity::Idle);
    }

    #[test]
    fn a_build_is_working() {
        assert_eq!(classify(&[shell("cargo build --release")], &[]), TurnActivity::Working);
        assert_eq!(classify(&[shell("pnpm vitest run")], &[]), TurnActivity::Working);
    }

    #[test]
    fn a_ci_poll_is_waiting() {
        assert_eq!(classify(&[shell("gh run watch 123 --exit-status")], &[]), TurnActivity::Waiting);
        assert_eq!(classify(&[shell("gh pr checks 45 --watch")], &[]), TurnActivity::Waiting);
    }

    #[test]
    fn a_bare_sleep_loop_is_waiting() {
        assert_eq!(classify(&[shell("sleep 40")], &[]), TurnActivity::Waiting);
    }

    #[test]
    fn wait_subcommands_are_waiting_without_naming_each_vendor() {
        for cmd in ["kubectl wait --for=condition=ready pod/x", "docker wait c1", "aws cloudformation wait stack-create-complete"] {
            assert_eq!(classify(&[shell(cmd)], &[]), TurnActivity::Waiting, "{cmd}");
        }
    }

    /// The misfire I'd otherwise have shipped: a delay in front of real work.
    #[test]
    fn a_sleep_chained_into_a_build_is_working() {
        assert_eq!(classify(&[shell("sleep 5 && cargo build")], &[]), TurnActivity::Working);
        assert_eq!(classify(&[shell("gh run watch; npm test")], &[]), TurnActivity::Working);
    }

    #[test]
    fn a_subagent_task_is_always_working() {
        let task = json!({"id": "t1", "type": "task", "status": "running", "description": "review"});
        assert_eq!(classify(&[task], &[]), TurnActivity::Working);
    }

    #[test]
    fn working_beats_waiting_when_both_are_live() {
        assert_eq!(classify(&[shell("gh run watch"), shell("cargo build")], &[]), TurnActivity::Working);
    }

    #[test]
    fn finished_tasks_do_not_count() {
        let done = json!({"id": "t1", "type": "shell", "status": "completed", "command": "cargo build"});
        assert_eq!(classify(&[done], &[]), TurnActivity::Idle);
    }

    #[test]
    fn a_task_with_no_status_field_still_counts_as_running() {
        let legacy = json!({"id": "t1", "type": "shell", "command": "cargo build"});
        assert_eq!(classify(&[legacy], &[]), TurnActivity::Working);
    }

    /// A scheduled wake is the certain half of this: no command matching, the
    /// session is parked by construction.
    #[test]
    fn a_pending_cron_alone_is_waiting() {
        assert_eq!(classify(&[], &[json!({"id": "c1"})]), TurnActivity::Waiting);
    }

    #[test]
    fn local_work_outranks_a_pending_cron() {
        assert_eq!(classify(&[shell("cargo build")], &[json!({"id": "c1"})]), TurnActivity::Working);
    }

    #[test]
    fn a_shell_with_no_command_field_reads_as_work() {
        let odd = json!({"id": "t1", "type": "shell", "status": "running"});
        assert_eq!(classify(&[odd], &[]), TurnActivity::Working);
    }
}
