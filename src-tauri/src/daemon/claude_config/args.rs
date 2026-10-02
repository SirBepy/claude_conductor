//! `claude` CLI argument building: the base `-p`/session-id/model/effort
//! flags, the system-prompt append helper, and the per-turn nonce used to
//! keep successive turns' temp-file names from colliding.

/// Appended to the system prompt of every session we spawn. Nudges Claude to
/// call the `report_turn_status` MCP tool every turn (todo 435 - replaced
/// the `<cc-title:..>`/`<cc-status:..>` text markers this prompt used to
/// carry, so a bad value is now a hard tool error, not a silent one).
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
/// Also pins questions to the `ask_user_question` MCP tool (the builtin is
/// disabled in `base_claude_args`) and nudges its body formatting +
/// `domain`/`badges` chips - all of that UI only exists here, not the bare CLI.
///
/// Also nudges full absolute file paths in every file mention (ai_todo 136),
/// so the app can parse file references mechanically (ai_todo 135's
/// click-to-open depends on unambiguous paths).
///
/// Also nudges the `<cc-preview:SLUG>..</cc-preview>` sentinel (ai_todo 291):
/// lets the pump push a mockup to the preview panel instead of the raw HTML
/// landing in the transcript.
///
/// Also ENFORCES use of the `send_message` tool (Stop-hook blocked, same as
/// report_turn_status - see `hooks_server::stop::missing_requirement_reason`):
/// chat prose/tool narration is never rendered in Joe's view, so
/// `send_message` is the only channel he sees. The hook already exempts a
/// `done` wake-opened turn (`opened_by_wake`, todo 607) from needing it -
/// Claude can't see that flag, only the `[daemon-meta]` prefix it correlates
/// with, so the prompt now names it (2026-08-24: Joe flagged the spam).
///
/// Also routes outbound message drafts to the `write_draft` MCP tool (todo 951).
/// The tool's own description already said this and lost every time: Joe's
/// global CLAUDE.md tells Claude to put anything he should copy in a
/// blockquote, and a user instruction outranks a tool description, so in the
/// month the Drafts panel existed not one draft was ever written to it. The
/// rule has to sit at system-prompt level and name that conflict outright to
/// win it. Correctly scoped here for the usual reason: the panel it writes
/// into only exists in sessions this app spawns.
///
/// The "write nothing outside a tool call" imperative rides here rather than
/// only in Joe's `Silent` output style (`~/.claude/output-styles/silent.md`),
/// whose rule 1 says the same thing at length. A custom output style is
/// injected once at session start and never re-sent - only the five built-ins
/// carry a per-turn reminder field - so it decays over a long session, while
/// this string is re-pushed on every turn spawn. The style still holds the
/// full doctrine; this sentence is its per-turn reinforcement.
pub(crate) const TURN_STATUS_PROMPT: &str = "Call the report_turn_status tool as the very last thing you do before ending your turn - required every turn, even a tool-only one with no chat reply. Also: when a response involves 3 or more distinct tool-use steps, emit <cc-progress:N/M> on its own bare line in your text at the start of each step, where N is the current step (1-based) and M is your estimated total. Example: step 2 of 5 -> bare line containing only <cc-progress:2/5>. Skip this for short responses. When a response involves 3 or more distinct tool-use steps, including non-coding work like research, web lookups, fact cross-referencing, or scheduling, not just code edits, call the `write_plan` MCP tool to declare every step up front with status `pending`, then call it again as you go to move which one is `active`. Skip this for short responses. When you take a screenshot or produce another visual result worth showing (a test run, a rendered page), surface it inline by reading it back with the Read tool rather than only describing it in prose. When asked for a visual mockup (HTML/CSS the user should see rendered), do not paste the raw HTML in your reply - instead wrap the full HTML in `<cc-preview:SLUG></cc-preview>` on its own, where SLUG is a short stable id for this mockup; it renders in the preview panel, and re-emitting the same SLUG later refreshes it in place instead of adding a new entry. You may share this repo with other Conductor sessions running concurrently: before editing a file another session might also be touching, or before running `git commit`, call list_peers - if it shows another active session, call post_message to say what you're about to do before proceeding. Ask the user questions ONLY through the `ask_user_question` MCP tool - the builtin AskUserQuestion is disabled in this app. Always set its `domain`, and set `badges` on any option that is the recommended and/or long-term/short-term best pick - both are fixed enum tokens (`badges`: recommended, long_term, short_term), never free text; the card renders both as chips, and they are the whole reason this tool exists instead of the builtin. This app's card renders the question body through markdown (paragraph breaks on blank lines, **bold**, `- ` bullets) and visually highlights the final \"?\"-terminated sentence as the actual ask - so for any question needing more than one short sentence, break it into short paragraphs instead of one dense run-on paragraph, bold the 1-2 facts that matter most, bullet-list enumerable items (multiple dates/entries/files), and end with the literal, standalone ask as its own final sentence. When you mention a file - in prose, a code-block header, or a tool-output reference - always write its full absolute path (e.g. C:\\Users\\joe\\project\\src\\main.rs or /home/joe/project/src/main.rs), never a relative path or ~ shorthand, so the app can parse and open the reference. Your assistant text and tool-call narration are never rendered in the chat view at all - Joe cannot see any of it, so write NOTHING outside a tool call: no preamble, no plan stated in prose, no narration between calls, no closing recap. Every word meant for him goes in send_message instead. The only text that belongs outside a tool call is a marker these instructions explicitly require, such as <cc-progress:N/M>. Call send_message at least once before ending every turn, the same required standing as report_turn_status; you may also call it again mid-turn, more than once, whenever something is worth surfacing while work is still running. Exception: a turn whose only input is a `[daemon-meta]`-tagged relay (inter-agent coordination-channel broadcast, Jarvis message, schedule wake) that needs no reply or action from you - pure peer chatter that changes nothing about your own work - only owes report_turn_status(done); skip send_message there, it will not be blocked. Each message must be terse and self-contained, since Joe sees only these bubbles with no surrounding narration for context. When you write a message for Joe to send SOMEWHERE ELSE - a Slack reply, an email, a ticket comment, a standup note, anything whose recipient is not this chat - put it in this project's Drafts panel with the `write_draft` tool rather than in your chat text, and do not also paste a copy into the chat. That includes instead of a blockquote or a code block: the Drafts panel IS the copyable surface in this app, editable and versioned and still there tomorrow, so this overrides any general instruction you carry about formatting copy-paste text for him inline. A draft you write shows up as its own card in the chat, so he will see it without you quoting it. A shell command, a commit message, a code snippet or a config block is not a message draft - those stay inline as they are.";

/// Space-separated, the multi-tool form `ask/sidecar.rs`'s ALLOWED_TOOLS
/// already proves the CLI accepts.
///
/// Todo 1034 (Joe's decision, 2026-10-02): all seven display-only/app-local
/// writers join `ask_user_question`/`show_preview` here - `write_plan`,
/// `send_message`, `report_turn_status`, `update_message`, `write_draft`,
/// `write_user_todo`, `schedule`. None of them reach outside this app's own
/// state (unlike `spawn_chat`/`respawn`/`close_session`/`post_message`, which
/// stay gated behind the ordinary permission relay). Without this, a chat
/// started with `auto_accept: false` hangs on the first `schedule`/`write_plan`
/// call until a human answers the permission card (confirmed live,
/// `daemon_schedule_e2e.rs::schedule_mcp_tool_add_inject_cancel_live`).
pub(crate) const PRETRUSTED_TOOLS: &str = "mcp__cc_conductor__ask_user_question \
     mcp__cc_conductor__show_preview \
     mcp__cc_conductor__write_plan \
     mcp__cc_conductor__send_message \
     mcp__cc_conductor__report_turn_status \
     mcp__cc_conductor__update_message \
     mcp__cc_conductor__write_draft \
     mcp__cc_conductor__write_user_todo \
     mcp__cc_conductor__schedule";

/// Monotonic per-turn suffix, so one session's successive turns never share a
/// temp-file name (todo 867). Wall-clock nanos would be enough in practice but
/// a counter cannot repeat under a coarse clock.
pub(crate) fn turn_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
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
/// Adds a per-chat paragraph (e.g. the project's ticket-link rule) to the
/// `--append-system-prompt` value `base_claude_args` set, so only chats it
/// applies to pay for it.
pub(crate) fn append_system_prompt(args: &mut [String], extra: &str) {
    if let Some(i) = args.iter().position(|a| a == "--append-system-prompt") {
        if let Some(p) = args.get_mut(i + 1) {
            p.push_str("

");
            p.push_str(extra);
        }
    }
}

pub(crate) fn base_claude_args(resume_id: Option<&str>, session_id: &str, model: &str, effort: &str, fork: bool) -> Vec<String> {
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
    // One ask channel only. The builtin's schema has no `domain`/`badges`, so a
    // question asked through it can never render the chips - and which of the two
    // tools got picked was pure whim. The PreToolUse hook stays as a safety net.
    args.push("--disallowedTools".to_string());
    args.push("AskUserQuestion".to_string());
    // Pre-trust our own ask tool so its first call skips
    // `--permission-prompt-tool` entirely, landing on index.ts's real
    // fire-and-forget flow instead of permission-card.ts's fallback.
    // show_preview joins it (todo 815): it only renders HTML into a sandboxed
    // frame, so a card per session bought nothing. Todo 1034 (Joe's decision,
    // 2026-10-02) adds the remaining display-only/app-local writers -
    // write_plan/send_message/report_turn_status/update_message/write_draft/
    // write_user_todo/schedule - see PRETRUSTED_TOOLS's own doc comment.
    // Space-separated per the format ask/sidecar.rs already proves works.
    args.push("--allowedTools".to_string());
    args.push(PRETRUSTED_TOOLS.to_string());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Todo 1034 (Joe's decision, 2026-10-02): all seven display-only/
    /// app-local writers must be pre-trusted, not just the original two
    /// (`ask_user_question`/`show_preview`). Without this, a chat started
    /// with `auto_accept: false` hangs on the permission relay the first
    /// time the model calls e.g. `schedule` or `write_plan`.
    #[test]
    fn pretrusted_tools_covers_all_seven_app_local_writers() {
        let tools: Vec<&str> = PRETRUSTED_TOOLS.split(' ').collect();
        for name in [
            "mcp__cc_conductor__ask_user_question",
            "mcp__cc_conductor__show_preview",
            "mcp__cc_conductor__write_plan",
            "mcp__cc_conductor__send_message",
            "mcp__cc_conductor__report_turn_status",
            "mcp__cc_conductor__update_message",
            "mcp__cc_conductor__write_draft",
            "mcp__cc_conductor__write_user_todo",
            "mcp__cc_conductor__schedule",
        ] {
            assert!(tools.contains(&name), "PRETRUSTED_TOOLS missing {name}: {tools:?}");
        }
        assert_eq!(tools.len(), 9, "unexpected extra/missing entry: {tools:?}");
    }
}
