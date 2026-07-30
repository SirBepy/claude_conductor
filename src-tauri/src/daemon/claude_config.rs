//! Claude invocation config builders: MCP config, hook settings, and base CLI
//! args. These are independent of session process lifecycle and consumed by
//! `spawn_session` in `lifecycle.rs`.

use std::path::PathBuf;

/// Appended to the system prompt of every session we spawn so Claude
/// self-reports, at the end of each turn: (1) a short conversation title and
/// (2) whether it is done, waiting on the user, or parked on an external
/// process. The frontend strips both markers before display (see
/// `chat-transforms.ts`). The status marker drives the sidebar state icon
/// (done = calm check, question = amber flag, waiting = indigo hourglass). The title
/// marker is read off the transcript by `tokens::title::ai_milestone_title`,
/// which only honors the title from the response to user-turn 1, 5, or 15 - so
/// the title refines as the chat grows without churning every turn. The marker
/// rides every response (cheap); the read side gates which ones count.
///
/// Also nudges Claude to `Read` back its own screenshots/visual results so
/// they render inline (see `chat::parser::tool_result_output`) instead of
/// only being described in prose - ai_todo 139's "habit" scope.
///
/// Also nudges use of the inter-agent coordination channel (`list_peers`/
/// `post_message`/`read_messages` MCP tools, `daemon::methods::channel`):
/// this is the correctly-scoped place for that nudge, not Joe's personal
/// global CLAUDE.md - it fires ONLY in sessions this app actually spawns
/// (where those tools are actually present in the tool list), instead of
/// asking every unrelated future Claude Code session, in every project, to
/// hold a rule for tools it will never see.
///
/// Also nudges AskUserQuestion body formatting, for the same reason: the
/// question card (`permission-modal/question-ui.ts`) renders the body through
/// markdown and highlights the final "?"-sentence as the ask (`splitAsk()`)
/// - a formatting affordance that only exists in THIS app's card, not the
/// bare CLI's own AskUserQuestion UI. Belongs here, not the global CLAUDE.md,
/// for the same reason as the coordination-channel nudge above.
pub(crate) const TURN_STATUS_PROMPT: &str = "End EVERY response with exactly two bare lines - no surrounding text or markdown: <cc-title:3-6 word topic summary> then <cc-status:done|question|waiting|working>. done=fully finished: nothing still running anywhere (no subagents, no background tasks) and not blocked on anything; question=awaiting the user's input or decision; working=you dispatched background subagents or background tasks in THIS session that are still running and will re-invoke you when they finish (a review fan-out, a background build you'll be notified about) - from the user's perspective work is still happening; waiting=parked on an EXTERNAL process outside this session (CI/pipeline, a deploy, a scheduled wake-up) that will resume you later. Never use done or waiting while your own subagents/background tasks are still running - that is working. Also: when a response involves 3 or more distinct tool-use steps, emit <cc-progress:N/M> on its own bare line in your text at the start of each step, where N is the current step (1-based) and M is your estimated total. Example: step 2 of 5 -> bare line containing only <cc-progress:2/5>. Skip this for short responses. When a response involves 3 or more distinct tool-use steps, including non-coding work like research, web lookups, fact cross-referencing, or scheduling, not just code edits, call the TodoWrite tool to track your steps, updating status to in_progress/completed as you move through them. Skip this for short responses. Use exactly one style per marker and close it correctly: colon form closes with '>' like <cc-status:done>, XML form is <cc-status>done</cc-status>; never mix the two. When you take a screenshot or produce another visual result worth showing (a test run, a rendered page), surface it inline by reading it back with the Read tool rather than only describing it in prose. You may share this repo with other Conductor sessions running concurrently: before editing a file another session might also be touching, or before running `git commit`, call list_peers - if it shows another active session, call post_message to say what you're about to do before proceeding. When calling AskUserQuestion, this app's card renders the question body through markdown (paragraph breaks on blank lines, **bold**, `- ` bullets) and visually highlights the final \"?\"-terminated sentence as the actual ask - so for any question needing more than one short sentence, break it into short paragraphs instead of one dense run-on paragraph, bold the 1-2 facts that matter most, bullet-list enumerable items (multiple dates/entries/files), and end with the literal, standalone ask as its own final sentence.";

/// Write a temporary .mcp.json file for the given turn and return its path.
/// Returns None if the app-data dir is unavailable (non-fatal; permission
/// relay simply won't be wired up for this turn).
///
/// `is_jarvis` adds `CC_JARVIS=1` to the spawned MCP child's env IFF this
/// turn belongs to the Jarvis singleton session (todo 272, chunk 2b) - that
/// var is what `mcp::server::run_stdio` reads to decide whether to advertise
/// the fleet-orchestration tools (`spawn_worker`/`send_to_session`/
/// `fleet_status`/`respond_worker_prompt`) in `tools/list`. A normal
/// session's config is byte-identical to before this var existed.
pub(crate) fn write_mcp_config(turn_id: &str, tracking_id: &str, is_jarvis: bool) -> Option<PathBuf> {
    let mcp_dir = crate::settings::paths::mcp_temp_dir().ok()?;
    let exe = std::env::current_exe().ok()?;
    let mut env = serde_json::json!({"CC_SESSION_ID": tracking_id});
    if is_jarvis {
        env["CC_JARVIS"] = serde_json::json!("1");
    }
    let config = serde_json::json!({
        "mcpServers": {
            "cc_conductor": {
                "command": exe.to_string_lossy(),
                "args": ["--mcp-permission"],
                "env": env
            }
        }
    });
    let path = mcp_dir.join(format!("{turn_id}.json"));
    std::fs::write(&path, serde_json::to_string(&config).ok()?).ok()?;
    Some(path)
}

/// Write a per-session settings.json that registers: a `PreToolUse` hook for
/// the builtin `AskUserQuestion` tool, and a `PreToolUse`/`PostToolUse` pair on
/// `Bash` enforcing the cross-session commit mutex (`hooks_server::commit_lock`
/// - two concurrent sessions in the same project must never `git commit` at
/// the same time). The hooks `curl` their payload to the daemon. Returns None
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
pub(crate) fn write_hook_settings(turn_id: &str) -> Option<PathBuf> {
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
    let config = serde_json::json!({
        "hooks": {
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
            ]
        }
    });
    let path = dir.join(format!("{turn_id}.settings.json"));
    std::fs::write(&path, serde_json::to_string(&config).ok()?).ok()?;
    Some(path)
}

/// Startup + periodic sweep of `mcp_temp_dir()`: removes any `.json` file
/// (covers both `<id>.json` mcp configs and `<id>.settings.json` hook
/// settings) whose mtime is older than 7 days. Normal operation deletes both
/// at pump-exit / `end_session`, keyed off `Session::mcp_config_path` /
/// `hook_settings_path`; this only catches leftovers from a daemon crash, a
/// hard kill, or a session spawned by a build that predates that cleanup.
/// Mirrors the chat-attachments sweep in `ipc::chat::lifecycle::gc_attachments`.
pub(crate) fn gc_temp_files() {
    let Ok(dir) = crate::settings::paths::mcp_temp_dir() else { return };
    crate::util::sweep_dir_older_than(
        &dir,
        std::time::Duration::from_secs(7 * 24 * 60 * 60),
        |path| path.extension().and_then(|e| e.to_str()) == Some("json"),
        false,
    );
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

/// Build the base `claude` argument list (everything except the MCP flags).
///
/// **Critical session-id handling:** `claude` rejects `--resume <id>` for an id
/// that has no existing conversation ("No conversation found with session ID")
/// and exits. So we must NOT `--resume` a freshly generated id. Instead:
/// - new session  -> `--session-id <our-uuid>` (claude creates a new
///   conversation using exactly that id; verified the id round-trips).
/// - resume        -> `--resume <existing-id>`.
/// - fork (resume  -> `--resume <old-id> --fork-session --session-id <new-uuid>`,
///   onto another     which replays the old transcript into a brand-new id.
///   account)         `--session-id` pins that id, so it is still known up
///                    front. Verified against the installed CLI.
/// Either way `session_id` is known up front, so the daemon never has to block
/// reading stdout to discover it (claude does not emit its `system`/init line
/// until it receives the first user message, which would otherwise deadlock).
///
/// `fork` is only meaningful with `resume_id`; it is ignored for a new session.
pub(crate) fn base_claude_args(resume_id: Option<&str>, session_id: &str, model: &str, effort: &str, remote: bool, fork: bool) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--input-format=stream-json".to_string(),
        "--output-format=stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    match resume_id {
        // Fork: the id we resume from and the id we land on are different.
        Some(old) if fork => {
            args.push("--resume".to_string());
            args.push(old.to_string());
            args.push("--fork-session".to_string());
            args.push("--session-id".to_string());
            args.push(session_id.to_string());
        }
        // Plain resume: `session_id` IS `resume_id`.
        Some(_) => {
            args.push("--resume".to_string());
            args.push(session_id.to_string());
        }
        None => {
            args.push("--session-id".to_string());
            args.push(session_id.to_string());
        }
    }
    args.push("--model".to_string());
    args.push(model.to_string());
    args.push("--effort".to_string());
    args.push(effort.to_string());
    args.push("--append-system-prompt".to_string());
    args.push(TURN_STATUS_PROMPT.to_string());
    if remote {
        // Spawn the chat under claude's remote-control bridge. NOTE: pairing
        // `--remote-control` with `--input-format=stream-json` is an untested
        // Phase-5b combination; behavior of the bridge under stdin-driven turns
        // has not been verified.
        args.push("--remote-control".to_string());
    }
    args
}
