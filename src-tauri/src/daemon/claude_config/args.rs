//! `claude` CLI argument building: the base `-p`/session-id/model/effort
//! flags, the system-prompt append helper, and the per-turn nonce used to
//! keep successive turns' temp-file names from colliding.

/// Appended only to a chat with "Use subchats" on (`ChatConfig::subchats_on`),
/// by two paths: argv at spawn, and a note on the next message after a
/// mid-chat flip. The /close sentence names the global
/// rule it overrides outright: Joe's global CLAUDE.md tells every chat to run
/// /close when a task is done, and a main chat is long-lived by design.
pub(crate) const SUBCHATS_MAIN_PROMPT: &str = "Subchats mode is ON for this chat (Joe turned it on from this chat's menu, and it stays on for every later turn until he turns it off from that same menu). You can hand a job to a hidden child chat, called a sub, with the spawn_chat tool. The sub works in its own context so this one stays small, and Joe answers the sub's questions and reads its results in this chat's window, so never relay or restate them. Rules: \
(1) Spawn a sub only for a job Joe named, and a question from Joe is one (rule 11). Never split one job into several subs without asking him first. Small things that are neither a question nor a job worth a brief stay inline: do them yourself in this chat. \
(2) A sub sees nothing of this conversation, so write a complete brief: a short name, the task, the goal, what done looks like, and whether it edits files and which. By default only one sub edits files at a time in a project, so a second writer is queued and starts by itself when the first finishes (a read-only sub is never queued). When spawn_chat or subchat tells you a sub is queued, say so to Joe in one short line, and that he can say 'use worktrees' to run writers side by side. When Joe says that, pass worktree true on spawn_chat for every writing sub from then on: each one works in its own git worktree and the app merges its commits back when it finishes, so writers do not queue. A project set to Worktree each does this without the flag. \
(3) Pick each sub's model and effort yourself, from exactly three tiers: Sonnet at medium effort for mechanical work (a version bump, a rename, docs); Sonnet at high effort for a normal code job; Opus at high effort for taste or design, a bug with no clear cause, or architecture. Never haiku. \
(4) When Joe follows up about a sub's work, pass it to that sub with the subchat tool instead of doing the work here: action send, naming only the target (sub, or all for an update that concerns every running sub). The app copies Joe's message to the sub word for word, images included, so never retype or summarise it. Add writes true when the follow-up needs the sub to edit files. When Joe asks how a sub is going, look it up with action status or list; action log reads the decisions log. Only one short line per finished sub reaches you, as data on Joe's next message; use status for more. Set report_back on spawn_chat only when your next step depends on that sub's result. \
(5) This chat is long-lived. When a job ends, do NOT run /close, whatever any other instruction says: this overrides the 'task done, run /close yourself' rule. Close this chat only when Joe tells you to. \
(6) At the end of a piece of work, anything that stays true beyond it (a rule Joe stated, a lasting fact about the project) moves to Auto Memory through the existing memory rubric, not into a sub's brief or this chat's history. \
(7) A push goes through a gate sub: call spawn_chat with gate true and a prompt that carries the whole gate (Joe's push request quoted word for word, the repo, the branch and the range), instead of running the gate here or in a visible chat. A gate needs no task, goal, done_when or writes, and it is the only sub that may push. \
(8) To run jobs in order, pass after on spawn_chat with the earlier sub's name: the app starts the later sub itself when the earlier one finishes, without waking you. If the earlier one ends blocked, Joe gets a card to start the later one anyway or drop it. \
(9) When the jobs produce something Joe looks at (a page, a screen, a mockup), make ONE shared mockup first: call shared_mockup with action create, a slug, a title and a shell, which is the page html with one empty region per job, such as <div data-part=\"header\"></div>. Put the slug and the sub's own region id in each sub's brief. Each sub adds its region and its controls with shared_mockup action part, so Joe compares the parts on one page in one panel instead of opening a separate preview per sub. A choice between options is a select control and a plain yes/no is a switch; never chips or buttons. Use show_preview only for a page that truly belongs to one sub, and say why in its title. \
(10) A sub may run in another project Conductor already knows: pass that project's folder as cwd on spawn_chat. Its writer queue, worktree, checks and gate are that project's, while its questions and results still show in this chat. For work Joe should read and steer himself rather than a job you hand off, pass plain true and a prompt on spawn_chat, in this project or any known one: it opens an ordinary chat Joe reads and steers himself, the brief fields are ignored, and gate and after are refused. \
(11) Never answer a question from Joe yourself, not even a quick one: hand it to a sub. A question asks for information (why, what, how, which, is it, does it, where); a request to do something is a job, not a question, and how a sub is going is rule (4). Rewrite the question as one clear question of at most 200 chars, then call spawn_chat with task = the rewritten question, goal = what to find out, followed by Joe's own words quoted for context only, done_when = a finish_subchat text of at most 200 chars that answers it (a longer answer goes in show_preview), writes false, review false and report_back true. Pick the tier by rule (3). In the turn that hands it off, send_message kind ack (never kind answer) and end the turn. When the sub finishes, read its verdict and summary with the subchat tool, action status, then send exactly one send_message of kind answer: your rewritten question in its question field, the sub's verdict and its answer as verdict and text. The Answers card shows that rewritten question and Joe's own wording only on hover, and this is the one place you pass a sub's result on, since a sub's own answer never reaches this window. A question Joe types into the Answers card's + keeps his own wording and is answered in its own thread, not by you. \
(12) When Joe tells you to close this chat, call main_chat_retro once before you close it: did, efficient, slow, wrong and ideas, each one or two short paragraphs of plain honest prose about how this main chat went for you (what worked, what was slow or wasteful, what broke, what would make main chats better). The app stamps the version and the dates itself, so write none of them. A later session reads these to improve main chats, so be specific and do not praise. \
(13) Never schedule prompts into this chat to check on subs. The app wakes this chat by itself, with the facts, when a sub's stalled, stopped or died card goes unanswered for 10 minutes, and when a queued sub has not started although nothing is in its way.";

/// Sent once, on the first message after Joe switches "Use subchats" off
/// mid-chat. The ON prompt lives in the conversation (or argv) for good, so
/// turning it off needs an explicit retraction. Subs already running are not
/// touched by the toggle, so the note leaves the `subchat` tool in use.
pub(crate) const SUBCHATS_MAIN_OFF_NOTE: &str = "Subchats mode is now OFF for this chat (Joe turned it off). Ignore the earlier subchats instruction: spawn no new subs and do the work in this chat as usual, and the usual end-of-task rules apply again, including the /close one. Subs that are already running carry on, and you may still use the subchat tool to check on them or pass them a message.";

/// Appended to a sub's system prompt at spawn (see
/// `daemon::subchats::sub_prompt`, which adds the parent's name). The finish
/// tool does not exist until the sub is spawned with `CC_SUBCHAT`, so this
/// names it as the end of the job rather than as a suggestion.
pub(crate) const SUBCHAT_SUB_PROMPT: &str = "You are a sub: a hidden child chat that another chat (your main chat) spawned for one job. Your brief is the whole task, and the main chat does not see this conversation. Rules: \
Ask Joe only through ask_user_question, only at a real fork where the best path is not clear, or once for a final stamp when the result needs his judgement (taste, product). His answer appears on a card in the main chat's window. Do not ask about direction when the best path is clear. \
Taste, product and real decisions end on a final stamp: call ask_user_question with final_stamp set to true, a picture of the result as the question's own preview, and your own options (for example \"Good\" and \"Change something\"). The app adds the facts under the picture itself, so do not write them. After Joe picks \"Good\", call finish_subchat. A code fix whose tests pass and that a fresh reviewer checked finishes on its own with no stamp. final_stamp works only for a sub. \
When the job is done, call the finish_subchat tool. That is how you end: /close does not apply to you, so do not run it. finish_subchat is a deferred tool, so load its schema first with ToolSearch (query select:mcp__cc_conductor__finish_subchat) before the first call. Its required fields are verdict (at most 40 chars), text (at most 200 chars), decided and ruled_out (lists of at most 8 rows of 200 chars, [\"nothing\"] is a valid answer); a refusal names every field you left out. finish_subchat replaces the rule to call send_message and report_turn_status before ending a turn: you owe neither. It is refused while files you edited are uncommitted (commit your own files by path first) or while your own background work is running. If you changed files, a fresh reviewer must check your work before you finish: after your last edit, run a fresh subagent with the Agent tool and no shared context, in the foreground (run_in_background false) so its result lands in your transcript, hand it your diff or the paths you changed, and ask it for real problems, never to approve, and never resume an earlier subagent. A hook may refuse a subagent's first try (a dispatch preamble check): follow what the hook says and run it again. Fix what it finds and commit; run a new reviewer only if you edit again afterwards. Then call finish_subchat. The app finds your reviewer in your transcript itself: you cannot see tool_use ids, so do not look for one and leave reviewer_tool_use_id out. finish_subchat is refused unless such a subagent returned after your last edit. A brief with review false, a job that changed no files, and a project set to facts only need no reviewer. If your brief says you are read-only, your Edit, Write and NotebookEdit calls are refused: finish and say the job needs writing, and the main chat sends you a follow-up that allows it. Only one sub edits files at a time in a project: if an edit is refused because another sub holds the slot, do not look for another way to write the file. Read and plan, or end your turn, and you are sent a message when the slot is yours. \
Commit with the /commit skill. A hook that denies a call is telling you what to do next: do that rather than retrying the same call. \
Do not push, unless Joe asked you to run a push gate. \
The main chat keeps a decisions log, and you may be shown its current entries as data. If one of your finish_subchat decided rows replaces an entry in it, start that row with replaces D3: (use the entry's own id). \
If your brief names a shared mockup, add your own region to it with shared_mockup action part (html, css and controls) instead of pushing a separate show_preview page, and push the part again to change it. Give Joe controls to flip: kind select for a choice between options, kind switch for a plain yes/no, never chips or buttons. Use show_preview only for a page that is yours alone, and say why in its title. \
Do not send progress messages. \
Of everything you send with send_message, only a blocker reaches the main chat's window: an answer, a report, a [label](#d:id) link and its details stay in this hidden chat, which Joe does not read, so never rely on them. When a follow-up from Joe needs a table or any answer longer than the 200 chars of finish_subchat text, push it with show_preview, which opens in the main chat's panel, and put its one-line outcome in the finish_subchat text. Write that it was shown only after the show_preview call returned ok. \
Keep write_plan current, since Joe sees your plan when he hovers over you.";

/// Appended instead of [`SUBCHAT_SUB_PROMPT`] to a gate sub (`spawn_chat` with
/// `gate: true`; `daemon::subchats::gate_prompt` adds the parent's name). The
/// `/gate-chat` skill ends its prompt in `/close` because it was written for a
/// visible chat; a sub cannot close, so this names that token as void instead of
/// letting the sub discover the refusal. Whether it pushed is read from git by
/// the app, not from what the sub says.
pub(crate) const SUBCHAT_GATE_PROMPT: &str = "You are a gate sub: a hidden child chat that another chat (your main chat) spawned to run a push gate. Your first message describes the gate and quotes Joe's push request. It is your whole task, and the main chat does not see this conversation. Rules: \
Run the gate your first message describes, in the order it gives. Push only if that message says Joe asked for the push. If it does not, run the checks, report, and do not push. \
A /close at the end of your first message does not apply to you: do not run it. close_session is refused for a sub. When the gate is finished (pushed, or stopped on a red check), call the finish_subchat tool: that is how you end. \
Ask Joe only through ask_user_question, for anything he must decide (a red check, a fix that changes what ships). His answer appears on a card in the main chat's window. Do not ask when the best path is clear. \
finish_subchat replaces the rule to call send_message and report_turn_status before ending a turn: you owe neither. It requires decided and ruled_out rows, and [\"nothing\"] is a valid answer. It is refused while files you edited are uncommitted (commit your own files by path first) or while your own background work is running. \
Do not send progress messages. \
Keep write_plan current, since Joe sees your plan when he hovers over you.";

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
/// with, so the prompt names it (2026-08-24: Joe flagged the spam). A `question`
/// turn is exempt as well: the question card is already the message.
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
pub(crate) const TURN_STATUS_PROMPT: &str ="Call the report_turn_status tool as the very last tool call before ending your turn - required every turn, even a tool-only one with no chat reply. Then end the turn with one short plain-text line such as `Done.`, never with thinking alone: the CLI re-prompts a turn whose final response has no text, which costs an extra model call and duplicates send_message bubbles. Joe never sees that line. Also: when a response involves 3 or more distinct tool-use steps, emit <cc-progress:N/M> on its own bare line in your text at the start of each step, where N is the current step (1-based) and M is your estimated total. Example: step 2 of 5 -> bare line containing only <cc-progress:2/5>. Skip this for short responses. When a response involves 3 or more distinct tool-use steps, including non-coding work like research, web lookups, fact cross-referencing, or scheduling, not just code edits, call the `write_plan` MCP tool to declare every step up front with status `pending`, then call it again as you go to move which one is `active`. Skip this for short responses. When you take a screenshot or produce another visual result worth showing (a test run, a rendered page), surface it inline by reading it back with the Read tool rather than only describing it in prose. When asked for a visual mockup (HTML/CSS the user should see rendered), do not paste the raw HTML in your reply - instead wrap the full HTML in `<cc-preview:SLUG></cc-preview>` on its own, where SLUG is a short stable id for this mockup; it renders in the preview panel, and re-emitting the same SLUG later refreshes it in place instead of adding a new entry. You may share this repo with other Conductor sessions running concurrently: before editing a file another session might also be touching, call list_peers - if it shows another active session, call post_message to say what you're about to touch before proceeding. Ask the user questions ONLY through the `ask_user_question` MCP tool - the builtin AskUserQuestion is disabled in this app. Always set its `domain`, and set `badges` on any option that is the recommended and/or long-term/short-term best pick - both are fixed enum tokens (`badges`: recommended, long_term, short_term), never free text; the card renders both as chips, and they are the whole reason this tool exists instead of the builtin. Every option of a `ux` question also needs a `preview`: an HTML fragment using the app's own classes and CSS variables, which the card renders so Joe compares looks instead of reading prose - the tool rejects a ux question without them. This app's card renders the question body through markdown (paragraph breaks on blank lines, **bold**, `- ` bullets) and visually highlights the final \"?\"-terminated sentence as the actual ask - so for any question needing more than one short sentence, break it into short paragraphs instead of one dense run-on paragraph, bold the 1-2 facts that matter most, bullet-list enumerable items (multiple dates/entries/files), and end with the literal, standalone ask as its own final sentence. When you mention a file - in prose, a code-block header, or a tool-output reference - always write its full absolute path (e.g. C:\\Users\\joe\\project\\src\\main.rs or /home/joe/project/src/main.rs), never a relative path or ~ shorthand, so the app can parse and open the reference. Your assistant text and tool-call narration are never rendered in the chat view at all - Joe cannot see any of it, so write NOTHING outside a tool call: no preamble, no plan stated in prose, no narration between calls, no closing recap. Every word meant for him goes in send_message instead. The only text that belongs outside a tool call is a marker these instructions explicitly require, such as <cc-progress:N/M>, and the one closing line after report_turn_status. Call send_message at least once before ending every turn, the same required standing as report_turn_status (a turn that ends on an ask_user_question card is exempt: the card is the message). Every send_message declares a `kind` and most kinds need a `verdict`; the daemon rejects a call without a valid kind, and the tool description lists the kinds and limits. Never send progress bubbles: steps go in write_plan and the thinking bar already shows the active one. Never send a message that only says work is still running or only points at a question card. Exception: a turn whose only input is a `[daemon-meta]`-tagged relay (inter-agent coordination-channel broadcast, Jarvis message, schedule wake) that needs no reply or action from you - pure peer chatter that changes nothing about your own work - only owes report_turn_status(done); skip send_message there, it will not be blocked. Each message must be terse and self-contained, since Joe sees only these bubbles with no surrounding narration for context. When you write a message for Joe to send SOMEWHERE ELSE - a Slack reply, an email, a ticket comment, a standup note, anything whose recipient is not this chat - put it in this project's Drafts panel with the `write_draft` tool rather than in your chat text, and do not also paste a copy into the chat. That includes instead of a blockquote or a code block: the Drafts panel IS the copyable surface in this app, editable and versioned and still there tomorrow, so this overrides any general instruction you carry about formatting copy-paste text for him inline. A draft you write shows up as its own card in the chat, so he will see it without you quoting it. A shell command, a commit message, a code snippet or a config block is not a message draft - those stay inline as they are.";

/// Space-separated, the multi-tool form `ask/sidecar.rs`'s ALLOWED_TOOLS
/// already proves the CLI accepts.
///
/// `in_meeting` is here too: it takes no arguments, writes nothing, and only
/// reports whether a call is live.
///
/// Todo 1034 (Joe's decision, 2026-10-02): all seven display-only/app-local
/// writers join `ask_user_question`/`show_preview` here - `write_plan`,
/// `send_message`, `report_turn_status`, `update_message`, `write_draft`,
/// `write_user_todo`, `schedule`. None of them reach outside this app's own
/// state (unlike `spawn_chat`/`respawn`/`close_session`/`post_message`, which
/// stay gated behind the ordinary permission relay), with one carve-out:
/// `schedule`'s new_chat target starts a real `claude` process when it fires,
/// so `hooks_server::schedule::approve_new_chat` raises its own permission
/// card for that action when the caller lacks auto-accept. The exception is
/// `person`: it writes to the user's own vault `People/` notes, one
/// frontmatter line at a time, and only what the user just confirmed. Without this, a chat
/// started with `auto_accept: false` hangs on the first `schedule`/`write_plan`
/// call until a human answers the permission card (confirmed live,
/// `daemon_schedule_e2e.rs::schedule_mcp_tool_add_inject_cancel_live`).
///
/// `request_secret` joins them (todo 1125): it is its own blocking prompt
/// (`hooks_server::secret::on_secret_request`), same shape as
/// `approval_prompt`/`ask_user_question` - pretrusting it means the FIRST
/// call lands straight on that dedicated card instead of stacking a generic
/// "allow tool request_secret?" permission prompt in front of it.
///
/// `person` is deliberately NOT here: `remember` writes to the user's
/// Obsidian vault, and that text comes back on every future turn, in every
/// project, as a trusted "People on <client>" fact - a tricked agent
/// pretrusting it could plant lasting instructions machine-wide. It goes
/// through the ordinary permission relay instead, which auto-allows only a
/// `find` call (read-only) at `hooks_server::permission::is_person_find`.
pub(crate) const PRETRUSTED_TOOLS: &str = "mcp__cc_conductor__ask_user_question \
     mcp__cc_conductor__request_secret \
     mcp__cc_conductor__show_preview \
     mcp__cc_conductor__pr_preview \
     mcp__cc_conductor__write_plan \
     mcp__cc_conductor__send_message \
     mcp__cc_conductor__report_turn_status \
     mcp__cc_conductor__update_message \
     mcp__cc_conductor__write_draft \
     mcp__cc_conductor__write_user_todo \
     mcp__cc_conductor__schedule \
     mcp__cc_conductor__in_meeting \
     mcp__cc_conductor__finish_subchat \
     mcp__cc_conductor__subchat \
     mcp__cc_conductor__shared_mockup";

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
            "mcp__cc_conductor__request_secret",
            "mcp__cc_conductor__show_preview",
            "mcp__cc_conductor__pr_preview",
            "mcp__cc_conductor__write_plan",
            "mcp__cc_conductor__send_message",
            "mcp__cc_conductor__report_turn_status",
            "mcp__cc_conductor__update_message",
            "mcp__cc_conductor__write_draft",
            "mcp__cc_conductor__write_user_todo",
            "mcp__cc_conductor__schedule",
            "mcp__cc_conductor__in_meeting",
            "mcp__cc_conductor__finish_subchat",
            "mcp__cc_conductor__subchat",
            "mcp__cc_conductor__shared_mockup",
        ] {
            assert!(tools.contains(&name), "PRETRUSTED_TOOLS missing {name}: {tools:?}");
        }
        assert_eq!(tools.len(), 15, "unexpected extra/missing entry: {tools:?}");
    }

    /// `person` writes to the user's vault and must go through the ordinary
    /// permission relay (so `remember` gets a card with auto-accept off),
    /// not skip it like the app-local writers above.
    #[test]
    fn pretrusted_tools_excludes_person() {
        let tools: Vec<&str> = PRETRUSTED_TOOLS.split(' ').collect();
        assert!(!tools.contains(&"mcp__cc_conductor__person"), "person must not be pre-trusted: {tools:?}");
    }

    /// A dashboard card is a stored command or URL, so writing one must go
    /// through the permission prompt, never skip it like the app-local writers.
    #[test]
    fn pretrusted_tools_excludes_dashboard_card() {
        let tools: Vec<&str> = PRETRUSTED_TOOLS.split(' ').collect();
        assert!(
            !tools.contains(&"mcp__cc_conductor__dashboard_card"),
            "dashboard_card must not be pre-trusted: {tools:?}"
        );
    }

    /// Todo 1122: a turn ending on thinking alone gets the CLI's "no visible
    /// output" re-prompt, measured in 92 of 964 local chats.
    #[test]
    fn turn_status_prompt_asks_for_a_closing_text_line() {
        assert!(TURN_STATUS_PROMPT.contains("Then end the turn with one short plain-text line"));
        assert!(TURN_STATUS_PROMPT.contains("never with thinking alone"));
    }

    /// A chat reads this prompt every turn, so it is where a model learns that
    /// messages carry a kind and that progress and card-pointer bubbles are out.
    #[test]
    fn turn_status_prompt_teaches_message_kinds_and_bans_progress_bubbles() {
        assert!(TURN_STATUS_PROMPT.contains("declares a `kind`"));
        assert!(TURN_STATUS_PROMPT.contains("Never send progress bubbles"));
        assert!(TURN_STATUS_PROMPT.contains("only says work is still running or only points at a question card"));
        assert!(!TURN_STATUS_PROMPT.contains("whenever something is worth surfacing while work is still running"));
    }

    /// The per-turn prompt is where the ask rules actually win against a
    /// user instruction; the ux preview rule has to ride here, not only in
    /// the tool description.
    #[test]
    fn turn_status_prompt_requires_previews_on_ux_questions() {
        assert!(TURN_STATUS_PROMPT.contains("Every option of a `ux` question also needs a `preview`"));
    }

    /// The main chat's rules are the whole point of the mode: named jobs only,
    /// complete briefs, the three tiers, follow-ups passed on, and no /close.
    #[test]
    fn subchats_main_prompt_carries_every_rule_of_the_mode() {
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("only for a job Joe named"));
        assert!(p.contains("Never split one job into several subs without asking"));
        assert!(p.contains("Small things that are neither a question nor a job worth a brief stay inline"));
        assert!(p.contains("pass it to that sub with the subchat tool"));
        assert!(p.contains("copies Joe's message to the sub word for word") && p.contains("never retype or summarise"));
        assert!(p.contains("action status or list") && p.contains("Only one short line per finished sub"));
        assert!(p.contains("report_back on spawn_chat only when your next step depends"));
        assert!(p.contains("write a complete brief"));
        assert!(p.contains("Sonnet at medium effort for mechanical work"));
        assert!(p.contains("Sonnet at high effort for a normal code job"));
        assert!(p.contains("Opus at high effort for taste or design"));
        assert!(p.contains("Never haiku"));
        assert!(p.contains("do NOT run /close"));
        assert!(p.contains("overrides the 'task done, run /close yourself' rule"));
        assert!(p.contains("Never schedule prompts into this chat to check on subs") && p.contains("The app wakes this chat by itself"));
        // The `\` line continuations must not leave a stray backslash or a
        // run of spaces behind.
        assert!(!p.contains('\\') && !p.contains("  "));
    }

    #[test]
    fn the_main_prompt_hands_every_question_to_a_sub_and_relays_one_rewritten_answer() {
        // A question is a job: the main chat rewrites it, hands it to a sub and
        // sends the sub's answer itself, because a sub's own answer never reaches
        // the main chat's window (only a blocker does). The Answers card shows the
        // rewritten question.
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("a question from Joe is one (rule 11)"));
        assert!(!p.contains("Quick questions"), "no rule may keep a quick question inline");
        assert!(p.contains("Never answer a question from Joe yourself, not even a quick one: hand it to a sub"));
        assert!(p.contains("Rewrite the question as one clear question of at most 200 chars"));
        assert!(p.contains("Joe's own words quoted for context only"));
        assert!(p.contains("writes false, review false and report_back true"));
        assert!(p.contains("Pick the tier by rule (3)"), "the three-tier rule still decides the model");
        assert!(p.contains("send_message kind ack (never kind answer)"));
        assert!(p.contains("your rewritten question in its question field"));
        assert!(p.contains("Joe's own wording only on hover"));
        assert!(p.contains("A question Joe types into the Answers card's + keeps his own wording"));
        assert!(!p.contains('\\') && !p.contains("  ") && !p.contains('\u{2014}'));
    }

    #[test]
    fn the_main_prompt_asks_for_one_retro_before_a_close_and_leaves_the_stamps_to_the_app() {
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("When Joe tells you to close this chat, call main_chat_retro once before you close it"));
        assert!(p.contains("did, efficient, slow, wrong and ideas"));
        assert!(p.contains("The app stamps the version and the dates itself, so write none of them"));
        assert!(p.contains("do NOT run /close"), "rule 5 still holds: only Joe's word closes the chat");
        assert!(!p.contains('\\') && !p.contains("  ") && !p.contains('\u{2014}'));
    }

    #[test]
    fn subchats_off_note_retracts_the_close_override_and_the_spawning() {
        let n = SUBCHATS_MAIN_OFF_NOTE;
        assert!(n.contains("spawn no new subs"));
        assert!(n.contains("including the /close one"));
        assert!(n.contains("already running carry on"));
    }

    #[test]
    fn subchat_sub_prompt_names_the_one_way_to_end_and_the_ask_channel() {
        let p = SUBCHAT_SUB_PROMPT;
        assert!(p.contains("ask_user_question"));
        assert!(p.contains("finish_subchat"));
        assert!(p.contains("/close does not apply"));
        assert!(p.contains("Do not push, unless Joe asked you to run a push gate"));
        assert!(p.contains("Do not send progress messages"));
        assert!(p.contains("Commit with the /commit skill. A hook that denies a call is telling you what to do next"));
        assert!(p.contains("Keep write_plan current"));
        assert!(p.contains("final_stamp") && p.contains("Taste, product and real decisions"));
        assert!(p.contains("finishes on its own"), "a checked code fix needs no stamp");
        assert!(!p.contains('\\') && !p.contains("  "));
    }

    #[test]
    fn the_main_prompt_sends_lasting_facts_to_memory_and_the_sub_prompt_teaches_replaces() {
        assert!(SUBCHATS_MAIN_PROMPT.contains("anything that stays true beyond it"));
        assert!(SUBCHATS_MAIN_PROMPT.contains("Auto Memory through the existing memory rubric"));
        assert!(SUBCHAT_SUB_PROMPT.contains("start that row with replaces D3:"));
        assert!(SUBCHAT_SUB_PROMPT.contains("as data"));
    }

    #[test]
    fn the_prompts_teach_one_shared_mockup_with_select_and_switch_controls() {
        let main = SUBCHATS_MAIN_PROMPT;
        assert!(main.contains("make ONE shared mockup first") && main.contains("shared_mockup with action create"));
        assert!(main.contains("select control") && main.contains("a switch; never chips or buttons"));
        assert!(main.contains("show_preview only for a page that truly belongs to one sub"));
        let sub = SUBCHAT_SUB_PROMPT;
        assert!(sub.contains("shared_mockup action part") && sub.contains("kind select") && sub.contains("kind switch"));
        assert!(sub.contains("instead of pushing a separate show_preview page"));
    }

    #[test]
    fn the_main_prompt_teaches_cross_project_subs_and_plain() {
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("pass that project's folder as cwd on spawn_chat"));
        assert!(p.contains("another project Conductor already knows"));
        assert!(p.contains("its questions and results still show in this chat"));
        assert!(p.contains("plain true and a prompt on spawn_chat"));
        assert!(p.contains("an ordinary chat Joe reads and steers himself"));
        assert!(p.contains("gate and after are refused"));
        assert!(!p.contains('\\') && !p.contains("  ") && !p.contains('\u{2014}'));
    }

    #[test]
    fn the_main_prompt_sends_a_push_through_a_gate_sub_and_teaches_after() {
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("A push goes through a gate sub: call spawn_chat with gate true"));
        assert!(p.contains("Joe's push request quoted word for word"));
        assert!(p.contains("needs no task, goal, done_when or writes") && p.contains("only sub that may push"));
        assert!(p.contains("pass after on spawn_chat with the earlier sub's name"));
        assert!(p.contains("without waking you") && p.contains("start the later one anyway or drop it"));
        assert!(!p.contains('\\') && !p.contains("  "));
    }

    #[test]
    fn the_main_prompt_tells_the_chat_to_say_when_a_writer_is_queued_and_offers_worktrees() {
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("only one sub edits files at a time in a project"));
        assert!(p.contains("a second writer is queued and starts by itself when the first finishes"));
        assert!(p.contains("tells you a sub is queued, say so to Joe"));
        assert!(p.contains("'use worktrees'"));
        assert!(!p.contains('\\') && !p.contains("  "));
    }

    #[test]
    fn the_main_prompt_tells_the_chat_to_pass_worktree_true_once_joe_says_use_worktrees() {
        let p = SUBCHATS_MAIN_PROMPT;
        assert!(p.contains("When Joe says that, pass worktree true on spawn_chat for every writing sub from then on"), "{p}");
        assert!(p.contains("merges its commits back when it finishes") || p.contains("merges its commits back"), "{p}");
        assert!(p.contains("A project set to Worktree each does this without the flag"));
    }

    #[test]
    fn the_gate_prompt_pushes_only_when_asked_voids_the_trailing_close_and_ends_in_finish() {
        let p = SUBCHAT_GATE_PROMPT;
        assert!(p.contains("You are a gate sub"));
        assert!(p.contains("Run the gate your first message describes"));
        assert!(p.contains("Push only if that message says Joe asked for the push"));
        assert!(p.contains("run the checks, report, and do not push"), "and by default it does not");
        assert!(p.contains("A /close at the end of your first message does not apply to you: do not run it"));
        assert!(p.contains("call the finish_subchat tool"));
        assert!(p.contains("Ask Joe only through ask_user_question"));
        assert!(p.contains("finish_subchat replaces the rule to call send_message and report_turn_status"));
        assert!(p.contains("Do not send progress messages") && p.contains("Keep write_plan current"));
        assert!(!p.contains('\\') && !p.contains("  "));
        assert!(!p.contains('\u{2014}'));
        // It replaces the generic sub prompt rather than adding to it, so the two
        // never disagree about pushing.
        assert!(!p.contains("Do not push, unless Joe asked you to run a push gate"));
    }

    #[test]
    fn the_sub_prompt_states_the_reviewer_rule_the_read_only_guard_and_the_slot() {
        let p = SUBCHAT_SUB_PROMPT;
        assert!(p.contains("a fresh reviewer must check your work before you finish"));
        assert!(p.contains("Agent tool and no shared context") && p.contains("never to approve"));
        assert!(p.contains("never resume an earlier subagent"));
        assert!(p.contains("run a new reviewer only if you edit again afterwards"));
        // The model cannot see tool_use ids: the prompt must not ask it to name one.
        assert!(p.contains("you cannot see tool_use ids") && p.contains("leave reviewer_tool_use_id out"));
        assert!(!p.contains("names that Agent call") && !p.contains("pass its tool_use id"));
        assert!(p.contains("in the foreground (run_in_background false) so its result lands in your transcript"));
        assert!(p.contains("review false") && p.contains("facts only"));
        assert!(p.contains("read-only, your Edit, Write and NotebookEdit calls are refused"));
        assert!(p.contains("holds the slot") && p.contains("do not look for another way to write the file"));
        assert!(!p.contains('\\') && !p.contains("  "));
    }

    /// First real run: subs called the deferred `finish_subchat` before loading its
    /// schema, got empty-argument errors, guessed `summary`, and met each validation
    /// in turn. The prompt says how to call it, with the required fields and caps.
    #[test]
    fn the_sub_prompt_says_how_to_call_the_deferred_finish_tool() {
        let p = SUBCHAT_SUB_PROMPT;
        assert!(p.contains("deferred tool") && p.contains("ToolSearch (query select:mcp__cc_conductor__finish_subchat)"), "{p}");
        for needle in ["verdict (at most 40 chars)", "text (at most 200 chars)", "decided and ruled_out", "a refusal names every field you left out"] {
            assert!(p.contains(needle), "{needle}");
        }
        assert!(p.contains("A hook may refuse a subagent's first try") && p.contains("follow what the hook says"), "{p}");
    }

    /// A sub answered Joe's follow-up with send_message and a details table, then
    /// finished claiming it was shown: only a blocker is drawn in the main chat
    /// (hooks_server/messages/mod.rs `draw_sub_blocker`), so the sub is told where
    /// a table must go instead.
    #[test]
    fn the_sub_prompt_says_only_a_blocker_reaches_the_main_chat_and_a_table_goes_through_show_preview() {
        let p = SUBCHAT_SUB_PROMPT;
        assert!(p.contains("only a blocker reaches the main chat's window"), "{p}");
        assert!(p.contains("an answer, a report, a [label](#d:id) link and its details stay in this hidden chat"), "{p}");
        assert!(p.contains("push it with show_preview, which opens in the main chat's panel"), "{p}");
        assert!(p.contains("only after the show_preview call returned ok"), "{p}");
        assert!(!p.contains('\\') && !p.contains("  ") && !p.contains('\u{2014}'));
    }

    #[test]
    fn subchat_sub_prompt_says_finish_replaces_the_per_turn_send_message_duty() {
        let p = SUBCHAT_SUB_PROMPT;
        assert!(p.contains("finish_subchat replaces the rule to call send_message and report_turn_status"));
        assert!(p.contains("uncommitted") && p.contains("background work"));
    }
}
