//! Hook settings writing: the per-session `.settings.json` handed to `claude`
//! via `--settings`, plus the hook server's own port lookup those hook
//! commands `curl` against.

use std::path::PathBuf;

/// Write a per-session settings.json that registers: a `UserPromptSubmit` hook
/// injecting this project's open "Your Todos" cards into every turn (todo 692,
/// `hooks_server::user_todos`), a `PreToolUse` hook for
/// the builtin `AskUserQuestion` tool, a `PreToolUse`/`PostToolUse` pair on
/// `Bash` enforcing the cross-session commit mutex (`hooks_server::commit_lock`
/// - two concurrent sessions in the same project must never `git commit` at
/// the same time), a `PostToolBatch` hook delivering held messages into a
/// still-running turn (`hooks_server::nudge`, the alternative to interrupting
/// the turn and killing its subagents), and a `SubagentStart`/`SubagentStop`
/// pair tracking in-flight `Agent` calls so an interrupt that does happen can
/// report what it killed (`hooks_server::subagents`). The hooks `curl` their
/// payload to the daemon. Returns None
/// if the app-data dir is unavailable (non-fatal; the affected hooks just
/// won't fire this session).
///
/// Why a hook and not the permission relay: current `claude` no longer routes
/// the builtin `AskUserQuestion` through `--permission-prompt-tool`, so the
/// approval-prompt relay never fires and the turn hangs. A `PreToolUse` hook
/// still fires for it; the daemon endpoint surfaces the question through the
/// existing question relay and returns the answer as a `deny` reason claude
/// reads as feedback. We use `curl` (not the app exe) because the GUI-subsystem
/// exe cannot reliably do short-lived hook stdin/stdout - this mirrors the
/// existing Stop hook. Scoped via `--settings` so it never touches the project's
/// own `.claude/settings.json`; `--permission-prompt-tool` stays for real
/// permission gates (Bash/Edit/etc.).
///
/// The commit-lock hooks use the `if` field (permission-rule syntax, e.g.
/// `"Bash(git *)"`) to filter on command content BEFORE Claude Code even runs
/// the hook command - `matcher` alone only keys on tool name, but `if` matches
/// tool name + arguments together. So a non-git Bash call (the overwhelming
/// majority: edits, npm/cargo, ls, etc.) never spawns curl or reaches the
/// daemon at all. Anything starting with `git` still does (status, add, the
/// project's own `git -C <path> commit` form, ...) - `commit_lock::is_git_commit`
/// is the precise "is this actually `commit`" check once inside the daemon,
/// since `if`'s prefix matching alone can't safely narrow past the `-C <path>`
/// form. The 2-minute poll budget only ever applies to an actual `git commit`.
pub(crate) fn write_hook_settings(turn_id: &str, tracking_id: &str) -> Option<PathBuf> {
    let dir = crate::settings::paths::mcp_temp_dir().ok()?;
    // Both --max-time AND the hook's `timeout` field MUST out-wait the daemon's
    // prompt window (hooks_server::permission::PROMPT_TIMEOUT = 3600s). The server
    // holds the AskUserQuestion prompt open for up to an hour so an AFK dev can
    // answer from their phone; curl aborting first (the old 320s = 5.3min) dropped
    // the answer with the turn left hanging. 3600 + 60s slack so the server's
    // response always lands first. The hook `timeout` is REQUIRED: without it
    // Claude Code caps a PreToolUse `command` hook at its 600s default and kills
    // curl at 10min regardless of --max-time, truncating the intended window.
    // --connect-timeout fails fast if the daemon isn't up.
    let ask_question_command = format!(
        "curl -s --connect-timeout 10 --max-time 3660 --retry 2 --retry-delay 1 -X POST -H \"Content-Type: application/json\" --data-binary @- http://127.0.0.1:{}/hooks/ask-question",
        daemon_hook_port()
    );
    // Same out-wait rule as above, sized to commit_lock::COMMIT_LOCK_POLL_BUDGET
    // (120s) instead of PROMPT_TIMEOUT: --max-time/timeout give it slack past
    // the server's own poll ceiling so the daemon's response always lands first.
    let commit_lock_request_command = format!(
        "curl -s --connect-timeout 10 --max-time 130 --retry 1 --retry-delay 1 -X POST -H \"Content-Type: application/json\" --data-binary @- http://127.0.0.1:{}/hooks/commit-lock-request",
        daemon_hook_port()
    );
    // Release is a fast fire-and-forget check-and-clear - no poll, small timeout.
    let commit_lock_release_command = format!(
        "curl -s --connect-timeout 10 --max-time 10 -X POST -H \"Content-Type: application/json\" --data-binary @- http://127.0.0.1:{}/hooks/commit-lock-release",
        daemon_hook_port()
    );
    // "Your Todos" per-turn injection (todo 692). `UserPromptSubmit` takes NO
    // `matcher`, so this element's shape differs from the PreToolUse ones. Small
    // timeouts: a local read that must never hold up a turn.
    let todos_inject_command = format!(
        "curl -s --connect-timeout 5 --max-time 15 -X POST -H \"Content-Type: application/json\" --data-binary @- \"http://127.0.0.1:{}/hooks/prompt-submit?session_id={}\"",
        daemon_hook_port(),
        tracking_id
    );
    // Mid-turn delivery of held messages (`hooks_server::nudge`). Fires once
    // per resolved tool batch, so the timeouts have to stay small: this is on
    // the hot path of every model round-trip, unlike the others here, which
    // are gated to one tool name or to turn boundaries.
    let tool_batch_command = format!(
        "curl -s --connect-timeout 3 --max-time 8 -X POST -H \"Content-Type: application/json\" --data-binary @- \"http://127.0.0.1:{}/hooks/tool-batch?session_id={}\"",
        daemon_hook_port(),
        tracking_id
    );
    // In-flight `Agent` tracking, so an interrupt can report what it killed
    // (`hooks_server::subagents`). Both are fire-and-forget bookkeeping writes:
    // nothing downstream waits on them, so they get the smallest budget here.
    let subagent_start_command = format!(
        "curl -s --connect-timeout 3 --max-time 5 -X POST -H \"Content-Type: application/json\" --data-binary @- \"http://127.0.0.1:{}/hooks/subagent-start?session_id={}\"",
        daemon_hook_port(),
        tracking_id
    );
    let subagent_stop_command = format!(
        "curl -s --connect-timeout 3 --max-time 5 -X POST -H \"Content-Type: application/json\" --data-binary @- \"http://127.0.0.1:{}/hooks/subagent-stop?session_id={}\"",
        daemon_hook_port(),
        tracking_id
    );
    let config = serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [
                {
                    "hooks": [ { "type": "command", "command": todos_inject_command, "timeout": 20 } ]
                }
            ],
            "PreToolUse": [
                {
                    "matcher": "AskUserQuestion",
                    "hooks": [ { "type": "command", "command": ask_question_command, "timeout": 3660 } ]
                },
                {
                    "matcher": "Bash",
                    "hooks": [ {
                        "type": "command",
                        "if": "Bash(git *)",
                        "command": commit_lock_request_command,
                        "timeout": 140
                    } ]
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [ {
                        "type": "command",
                        "if": "Bash(git *)",
                        "command": commit_lock_release_command,
                        "timeout": 15
                    } ]
                }
            ],
            "PostToolBatch": [
                {
                    "hooks": [ { "type": "command", "command": tool_batch_command, "timeout": 10 } ]
                }
            ],
            "SubagentStart": [
                {
                    "hooks": [ { "type": "command", "command": subagent_start_command, "timeout": 8 } ]
                }
            ],
            "SubagentStop": [
                {
                    "hooks": [ { "type": "command", "command": subagent_stop_command, "timeout": 8 } ]
                }
            ]
        }
    });
    let path = dir.join(format!("{turn_id}.settings.json"));
    let body = serde_json::to_string(&config).ok()?;
    // Same atomicity rationale as mcp_config.rs's write_mcp_config_inner: this
    // file is handed to `claude` via `--settings`.
    crate::util::write_json_atomic(&path, &body).ok()?;
    Some(path)
}

/// The hook server's actual bound port. The production daemon pins HOOK_PORT
/// (27182); a test instance (CC_DAEMON_INSTANCE set) binds an ephemeral port and
/// records it in a suffixed `hooks_port-<suffix>.txt`. Read that file so the
/// AskUserQuestion hook curls the RIGHT daemon under the e2e harness too. Falls
/// back to HOOK_PORT.
pub(crate) fn daemon_hook_port() -> u16 {
    let suffix = crate::daemon::instance::instance_suffix();
    crate::settings::paths::read_hook_port(&suffix)
        .unwrap_or(crate::daemon::hooks_server::HOOK_PORT)
}
