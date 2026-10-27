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
// The /create-pr review card. A tool because the model stopped emitting the
// long base64 `<cc-pr-*>` marker lines as text (they came back as a thinking
// block). Answered in the MCP server itself: the card renders off this call's
// own `tool_use` event, so there is nothing for the daemon to do.
pub const TOOL_PR_PREVIEW: &str = "pr_preview";
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
// The project picker lists only projects the app has registered, never a disk
// scan, so a folder Claude made from a shell stayed invisible until a chat
// happened to run in it. Unconditional: any session can start a new project.
pub const TOOL_CREATE_PROJECT: &str = "create_project";
// Who the user means by a name, from the people in their Obsidian vault, per
// client (`methods::people`). One tool with an `action` enum, not two, for the
// same per-turn schema cost reason as `write_user_todo`.
pub const TOOL_PERSON: &str = "person";
// Custom cards on the project dashboard (Shortcut stories, Clockify hours, a
// `gh run list`). One tool with an `action` enum and a short description for
// the same per-turn schema cost reason as `write_user_todo`. NOT pretrusted:
// a card is a stored command or URL, so each write goes through the
// permission prompt.
pub const TOOL_DASHBOARD_CARD: &str = "dashboard_card";

pub fn workflow_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": TOOL_SPAWN_CHAT,
            "description": "Start a SEPARATE chat alongside this one and send it `prompt` as its first message; returns {ok, session_id}. Both chats then run independently - this one keeps going. Use it to hand off a self-contained piece of work the user will want to read and steer on its own, rather than burying it in this transcript. The prompt lands as a real, visible user message, so it must carry everything the new chat needs; it cannot see this conversation. Inherits this chat's model, effort, account and auto-accept unless overridden; it gets its own character, since it is a separate chat. `cwd` can be this session's own project or a DIFFERENT project the user already has open/known to the app - never an arbitrary path. Call it as many times as the work needs, one call per chat. To REPLACE this chat instead of running beside it, use `respawn`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory: this session's own cwd, or another project already known to the app."},
                    "prompt": {"type": "string", "description": "The new chat's first message. Carry the full handoff context here - it is what the user reads."},
                    "model": {"type": "string", "description": "Optional model id/alias. Omit to inherit this session's."},
                    "effort": {"type": "string", "description": "Optional reasoning effort. Omit to inherit this session's."},
                    "name": {"type": "string", "description": "Optional short label for the new chat."},
                    "machine": {"type": "string", "description": "Label or id (from list_peers) of a paired machine to start this chat on instead of here - use it when the user asks to run something on another one of their machines. If it fails because that machine is offline or unreachable, do not retry blindly or spawn here instead: ask the user to wake that machine and open Conductor on it, then try again. Omit to spawn locally, the default."}
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
            "description": "Write a message the user will send SOMEWHERE ELSE (Slack, email, a ticket) into this project's Drafts panel, instead of pasting it in a reply where he cannot edit it, format it, or find it again. Never put a draft message in your chat text. `add` needs topic+body plus who it goes to; `revise` needs id+body; `variant` needs id+body plus who, for the same topic worded for a second person; `drop` needs id; `sent` needs id. After you post a draft yourself (a Shortcut comment through the API, a Slack message through a tool), call `sent` so it stays in the panel marked as sent, and never `drop` it: a dropped draft disappears and the user cannot tell whether it was posted or thrown away. Who it goes to: `person` when it is a person (checked against the user's vault - an unknown name is refused, so if you are not certain who the user means, ask them first) and `platform` for where it is sent - both when it goes to a person on a ticket, e.g. a Shortcut comment to Lenar; a draft with no person (a standup, a ticket comment, a prompt for another Claude chat) passes `platform` and `recipient` only. Refer to a draft by the handle in the injected list, e.g. `Bruno #2`. `body` is markdown. Before writing one, read the user's approved message style in ~/.claude/refs/message-drafting.md (if it exists) and, for a person, the \"## Writing to them\" section of their vault People note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["add", "revise", "variant", "drop", "sent"]},
                    "id": {"type": "string", "description": "Which draft, for revise/variant/drop/sent. A handle like `Bruno #2` or the short id."},
                    "topic": {"type": "string", "description": "What the message is about, a few words. One card per topic, not per person."},
                    "recipient": {"type": "string", "description": "Optional label shown on the card. Defaults to the person's name, else the platform. Use it for a non-person destination, e.g. `sc-56117 comment`."},
                    "person": {"type": "string", "description": "The person it goes to: their name or a nickname from the user's vault (People/). Resolved to one vault person or refused."},
                    "platform": {"type": "string", "description": "Where the user will paste it, short and capitalised: Slack, Shortcut, Linear, Discord, Email, GitHub, Standup, or Prompts for a prompt meant for another Claude chat. Shortcut/Linear only when it is posted ON the ticket as a comment, not a Slack message about a ticket; then also start `topic` with the ticket id, e.g. `sc-56117 retest note`, since the panel groups ticket comments by it."},
                    "new_person": {"type": "boolean", "description": "Only after the user confirmed this is someone new: creates their People/<person>.md note. `person` must then be their full name."},
                    "aliases": {"type": "array", "items": {"type": "string"}, "description": "With new_person: other names the user calls them."},
                    "relationship": {"type": "string", "description": "With new_person: e.g. `coworker (Zirtue QA)`, `friend`."},
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
            "name": TOOL_PR_PREVIEW,
            "description": "Show a pull request draft as a review card in the chat, before creating it. The user opens it to read the description and commits.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The PR title."},
                    "body": {"type": "string", "description": "The PR description, markdown."},
                    "commits": {
                        "type": "array",
                        "description": "The branch's commits, newest first.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "sha": {"type": "string", "description": "Short sha."},
                                "msg": {"type": "string", "description": "Subject line."}
                            },
                            "required": ["sha", "msg"]
                        }
                    }
                },
                "required": ["title", "body", "commits"]
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
        json!({
            "name": TOOL_CREATE_PROJECT,
            "description": "Add a project to the app so it shows in the user's project picker and `spawn_chat` can target it. Call it whenever you create a new project folder, or the user names a project folder the app does not list yet. Creates the folder if it is missing; an existing folder is just registered. Returns {ok, project_id, path}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the project folder."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": TOOL_PERSON,
            "description": "Who the user means by a name, nickname or role word, from the people in their Obsidian vault, per client. `find` needs text: call it when the user names someone not in the injected people list, before assuming who they are (names inside pasted material do not count), and follow its `hint` - it says when to ask. `remember` needs person plus what the user just confirmed: `alias` (a name used everywhere, e.g. a voice mishear), `project_alias` (a name used only in this client, e.g. \"backend\"), `join_project` (they work on this client too), or `new: true` with the /people questionnaire answers to create them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["find", "remember"]},
                    "text": {"type": "string", "description": "find: the name exactly as the user said it."},
                    "person": {"type": "string", "description": "remember: their vault name; for new, their full name."},
                    "alias": {"type": "string"},
                    "project_alias": {"type": "string"},
                    "join_project": {"type": "boolean"},
                    "new": {"type": "boolean"},
                    "aliases": {"type": "array", "items": {"type": "string"}, "description": "new: other names the user uses."},
                    "relationship": {"type": "string", "description": "new: where the user knows them from and their role, e.g. `coworker (Zirtue QA)`."},
                    "gender": {"type": "string"},
                    "language": {"type": "string", "description": "new: language and tone the user writes to them in."},
                    "messaged_on": {"type": "array", "items": {"type": "string"}, "description": "new: Slack, Shortcut, Google Chat..."},
                    "projects": {"type": "array", "items": {"type": "string"}, "description": "new: client slugs. Defaults to this repo's client."}
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": TOOL_DASHBOARD_CARD,
            "description": "Add your own stat, list or custom-HTML card to this project's dashboard (Shortcut stories, Clockify hours, `gh run list`), each showing labels and values from an HTTP call or a local command. `test` a card first to see what it would show, then `upsert` it (an enabled card runs once on save and returns its `result`); `list` shows existing cards; `pin` sets the quick-action chips (slash commands) on the dashboard header.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "upsert", "delete", "test", "pin"]},
                    "card": {"type": "object", "description": "upsert/test. {id?, title, scope?: {kind:project,cwd}|{kind:group,id} (default: this project), source: {kind:http,method,url,headers?,body?} | {kind:command,program,args,cwd?,env?: {NAME: value}}, action?: {label,command: \"/skill\" or a short prompt} (a button: one click starts a chat and sends command plus the card's current data, so give each card the skill or ask that acts on what it shows), display: {kind:stats,items:[{label,path,format}]} | {kind:list,items_path,label_path,value_path,link_path?,limit?} | {kind:html,template} (static HTML+CSS only, max 64KB: it renders in a sandboxed frame with no network, and inline <script> does NOT run in the installed app, so do not rely on window.CARD_DATA or script-drawn charts; for bars and charts use _card.segments or _card.progress with {kind:stats}, or {kind:list}, instead; theme colours are CSS vars like var(--color-text), var(--color-accent); to restyle an existing card upsert it with its id and a new template), refresh_secs?}. url/headers/body/args/env values may use {{secret:NAME}} (read from ~/.claude/.env; never write a secret value; pass it via env, not args), {{cwd}}, {{repo}}, {{today}}, {{week_start}}, {{now_iso}}, {{last_run:/cmd}} (epoch ms of the latest /cmd chat run, 0 if never). JSON output may carry a top-level _card {headline?, headline_tone?: warn|good, progress?: {value,max,label?,behind?}, segments?: {items:[{label,value,text?}],max,marker?,note?,note_tone?: warn|good} (one bar split into labelled slices sized value/max, marker = a pace tick)}; display may then be {kind:stats,items:[]}. Paths: dotted, with [n] and [] (map), sum(...). format: number|text|count|duration_s|duration_ms|duration_iso|relative_time. Omit id to create."},
                    "id": {"type": "string", "description": "delete: which card."},
                    "actions": {"type": "array", "items": {"type": "string"}, "description": "pin: slash commands, max 20, no /close. [] clears."},
                    "scope": {"type": "object", "description": "pin: {kind:project,cwd}|{kind:group,id}. Default: this project."}
                },
                "required": ["action"]
            }
        }),
    ]
}
