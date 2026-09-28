//! Split out of `tool_schemas.rs` (todo 801): chat spawn/handoff and the
//! Todos/Drafts/Preview panel tool schemas. Content is byte-identical to
//! before.

use serde_json::{json, Value};

// Sibling-session spawn. Unconditional despite the name similarity with
// `spawn_worker`: no fleet. `cwd` must be the caller's own project or another
// project already in Settings.projects - never an arbitrary path.
pub const TOOL_SPAWN_CHAT: &str = "spawn_chat";
// Hand this chat's work to a fresh context window and stand down. Same spawn
// as above plus the successor link the sidebar follows, so the user stays put.
pub const TOOL_RESPAWN: &str = "respawn";
// "Your Todos" panel (todo 692). Unconditional: any session can hand the user
// an action item. ONE tool with an `action` enum rather than four, and a
// deliberately short description - this schema is injected into every turn of
// every session, so see `project_mcp_tool_def_per_turn_cost`.
pub const TOOL_WRITE_USER_TODO: &str = "write_user_todo";
// Draft messages the user sends elsewhere (todo 666). Unconditional: any
// session can be asked to write one, and the panel is project-scoped.
pub const TOOL_WRITE_DRAFT: &str = "write_draft";
// Rendered-HTML push (todo 291's `<cc-preview:..>` sentinel replaced by a real
// tool, Joe 2026-08-27). A sentinel the model has to open AND close correctly
// is the failure mode the status/title markers already hit; a tool call cannot
// be half-emitted. Unconditional, same as send_message.
pub const TOOL_SHOW_PREVIEW: &str = "show_preview";
// Turn-footer step checklist. A tool we serve ourselves is always in the list,
// unlike `TodoWrite`, which the harness withholds often enough that the
// checklist rendered in 4 of 188 transcripts (2026-09-04). Unconditional, and
// `TodoWrite` still feeds the same checklist wherever it does exist.
pub const TOOL_WRITE_PLAN: &str = "write_plan";
// Write access to the Schedule panel's `scheduled-items.json`, previously
// UI-only (`daemon::methods::schedule`'s mutators are desktop-RPC). `list` is
// deliberately NOT an action: pending items ride the `UserPromptSubmit`
// injection (`methods::schedule_mcp::render_for_injection`), which costs
// nothing when there are none and hands over real ids for free.
pub const TOOL_SCHEDULE: &str = "schedule";

pub fn workflow_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": TOOL_SPAWN_CHAT,
            "description": "Start a SEPARATE chat alongside this one and send it `prompt` as its first message; returns {ok, session_id}. Both chats then run independently - this one keeps going. Use it to hand off a self-contained piece of work the user will want to read and steer on its own, rather than burying it in this transcript. The prompt lands as a real, visible user message, so it must carry everything the new chat needs; it cannot see this conversation. Inherits this chat's model, effort, account and auto-accept unless overridden; it gets its own character, since it is a separate chat. `cwd` can be this session's own project or a DIFFERENT project the user already has open/known to the app - never an arbitrary path. Once per turn. To REPLACE this chat instead of running beside it, use `respawn`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory: this session's own cwd, or another project already known to the app."},
                    "prompt": {"type": "string", "description": "The new chat's first message. Carry the full handoff context here - it is what the user reads."},
                    "model": {"type": "string", "description": "Optional model id/alias. Omit to inherit this session's."},
                    "effort": {"type": "string", "description": "Optional reasoning effort. Omit to inherit this session's."},
                    "name": {"type": "string", "description": "Optional short label for the new chat."},
                    "machine": {"type": "string", "description": "Label or id (from list_peers) of a paired machine to start this chat on instead of here - use it when the user asks to run something on another one of their machines. Omit to spawn locally, the default."}
                },
                "required": ["cwd", "prompt"]
            }
        }),
        json!({
            "name": TOOL_RESPAWN,
            "description": "Replace THIS chat with a fresh one that has an empty context window, carrying `prompt` across as its first visible message; returns {ok, session_id}. Use it when the context is nearly full or has drifted, and the work should continue. One call does both halves - the successor is spawned and this chat is closed at the end of the current turn - so there is no ordering trap and no separate close_session call. The app keeps the user on the successor automatically: same window, same place in the sidebar, composer draft intact. The visible messages do NOT carry over, which is the point, so `prompt` must restate everything the successor needs. Inherits this chat's model, effort, account, character and auto-accept unless overridden. To start a chat that runs ALONGSIDE this one instead, use `spawn_chat`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory: this session's own cwd, or another project already known to the app."},
                    "prompt": {"type": "string", "description": "The successor's first message. Carry the full handoff context here - it is what the user reads."},
                    "model": {"type": "string", "description": "Optional model id/alias. Omit to inherit this session's."},
                    "effort": {"type": "string", "description": "Optional reasoning effort. Omit to inherit this session's."},
                    "name": {"type": "string", "description": "Optional short label for the successor."}
                },
                "required": ["cwd", "prompt"]
            }
        }),
        json!({
            "name": TOOL_WRITE_USER_TODO,
            "description": "Park an action item only the user can do (a login, a cloud console, hardware, an approval) in this project's durable Todos panel, instead of just mentioning it in a reply where it dies with the turn. His open items are injected into every turn already, so never ask him to recite them. `add` needs text; `rewrite` needs id+text; `done` needs id (use it the moment you learn he did it); `drop` needs id+reason when it stopped being needed. Ids are the short ones shown in the injected list.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "rewrite", "done", "drop"]},
                    "text": {"type": "string", "description": "The action item, one line, imperative. Inline `code` is fine."},
                    "id": {"type": "string", "description": "Which card, for rewrite/done/drop."},
                    "reason": {"type": "string", "description": "Why it is no longer needed. Required for drop, shown on the card."}
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": TOOL_WRITE_DRAFT,
            "description": "Write a message the user will send SOMEWHERE ELSE (Slack, email, a ticket) into this project's Drafts panel, instead of pasting it in a reply where he cannot edit it, format it, or find it again. Never put a draft message in your chat text. `add` needs topic+recipient+body; `revise` needs id+body; `variant` needs id+recipient+body for the same topic worded for a second person; `drop` needs id. Refer to a draft by the handle in the injected list, e.g. `Bruno #2`, which also names the recipient. `body` is markdown.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "revise", "variant", "drop"]},
                    "id": {"type": "string", "description": "Which draft, for revise/variant/drop. A handle like `Bruno #2` or the short id."},
                    "topic": {"type": "string", "description": "What the message is about, a few words. One card per topic, not per person."},
                    "recipient": {"type": "string", "description": "Who it goes to. Their name as the user says it."},
                    "body": {"type": "string", "description": "The message itself, in markdown."},
                    "note": {"type": "string", "description": "What changed, for the version list. Revise only."},
                    "brief": {"type": "string", "description": "Why this message exists and what must land, for a later reviewer."},
                    "receipts": {
                        "type": "array",
                        "description": "Each factual claim in the body paired with where it came from: a file:line, a command's output, or the user's own words.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "claim": {"type": "string"},
                                "source": {"type": "string"}
                            }
                        }
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": TOOL_SHOW_PREVIEW,
            "description": "Render HTML for the user to LOOK at - a mockup, a chart, a timeline, a diagram. The card lands inline in the chat, expanded, and he can promote it to the side panel from there. Use it whenever the answer is easier to see than to read; a table in your message text is the fallback, not the goal.\n\nThe HTML is self-contained: it renders in a sandboxed frame with no access to the app, so inline `<style>`/`<script>` and CDN links all work, but nothing relative resolves - no `<link href=\"./x.css\">`.\n\n`slug` is the identity. Pushing the same slug again REPLACES that card in place rather than stacking a second one, so iterate on a design by re-pushing one slug.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Stable kebab-case id. Re-push the same slug to update the card in place."},
                    "html": {"type": "string", "description": "A complete self-contained HTML document."},
                    "title": {"type": "string", "description": "Short human label for the card header. Derived from the slug if omitted."}
                },
                "required": ["slug", "html"]
            }
        }),
        json!({
            "name": TOOL_WRITE_PLAN,
            "description": "Declare the steps of a multi-step response BEFORE you start, then update their status as you go; they render as a live checklist in the turn footer. Call it once up front with every step `pending`, so the user can object to step 4 while you are still on step 1 - that is the whole point, and a plan that appears one step at a time is worth much less than one he can read ahead in. Send the WHOLE plan every call, not a delta; each call replaces the last. A step is identified by its `text`, so keep the wording stable across calls or the row is treated as a new step. Exactly one step should be `active`. Use it for any response with 3+ real steps, including non-coding work. The JSON this call returns can include a `comments` object, keyed by step text: a note the user left on a step you are marking `active` in THIS call, read it before doing that step's work - it may say to skip the step or question whether it's needed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "Every step, in order. Resend the full list on each call.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string", "description": "The step, a few words, imperative. This is its identity - keep it byte-stable across calls."},
                                "status": {"type": "string", "enum": ["pending", "active", "done", "skipped"]},
                                "detail": {"type": "string", "description": "Optional one line on what this step actually involves, shown when the user expands the step. Write it so he can judge whether the step is worth doing."}
                            },
                            "required": ["text", "status"]
                        }
                    }
                },
                "required": ["steps"]
            }
        }),
        json!({
            "name": TOOL_SCHEDULE,
            "description": "Run a prompt LATER, once or on a repeat, without this chat having to stay open for it. The item lands in the app's Schedule panel, where the user can see, edit and delete it, and it fires on its own.\n\n`add` defaults to starting a NEW chat at that time, which is what you want for anything recurring - a fresh context beats a three-hour-old one. `target: \"this_chat\"` sends the prompt into this chat instead; use it only for a genuine \"come back to me later\" nudge, never with `repeat`, since a recurring message into your own session just fills its own context window. A new chat inherits this session's model, effort and account.\n\nGive the time as `in_minutes` - you do not reliably know the current wall-clock time, so a relative offset is the safe form. Use `at` (local `YYYY-MM-DDTHH:MM`) only when the user named a clock time.\n\n`cancel` needs `id`. Ids come from the pending list injected into your turn, so never ask the user to read one out.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "cancel"]},
                    "prompt": {"type": "string", "description": "What to send when it fires. It lands as a real user message with nothing else around it, so it must stand alone - the future chat cannot see this conversation."},
                    "target": {"type": "string", "enum": ["new_chat", "this_chat"], "description": "Where it fires. Defaults to new_chat."},
                    "in_minutes": {"type": "integer", "description": "Fire this many minutes from now. Preferred over `at`."},
                    "at": {"type": "string", "description": "Local wall-clock time, `YYYY-MM-DDTHH:MM`. Only when the user named a specific time."},
                    "repeat": {"type": "string", "description": "Makes it recurring at the same time of day: `daily`, `weekdays`, `weekly`, or `every-N-days`. Omit for a one-shot."},
                    "cwd": {"type": "string", "description": "Project for a new_chat. This session's own, or another already known to the app. Defaults to this session's."},
                    "name": {"type": "string", "description": "Optional short label for the chat this spawns."},
                    "id": {"type": "string", "description": "Which item, for cancel. The short id from the injected list."}
                },
                "required": ["action"]
            }
        }),
    ]
}
