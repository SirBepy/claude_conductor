//! Static MCP tool-list schema data: names, descriptions, inputSchema JSON.
//! Split out of `server.rs` (todo 452) to keep that file to the stdio
//! dispatch loop. No behavior change; content is byte-identical to before.

use serde_json::{json, Value};

pub const TOOL_APPROVAL: &str = "approval_prompt";
pub const TOOL_QUESTION: &str = "ask_user_question";

/// Shared by the schema below and `server::question_args`'s validator so the
/// two cannot drift (todo 818). Frontend twin: `DOMAIN_META`/`BADGE_META` in
/// `src/views/sessions/permission-modal/types.ts`.
pub const QUESTION_DOMAINS: [&str; 7] =
    ["ux", "arch", "sec", "data", "tooling", "infra", "billing"];
pub const OPTION_BADGES: [&str; 3] = ["recommended", "long_term", "short_term"];
pub const TOOL_CLOSE: &str = "close_session";
// Inter-agent coordination-channel tools: unconditionally advertised (unlike
// the Jarvis fleet tools below) - any session running through this app
// should be able to see who else is active in its project and coordinate
// with them, not just a Jarvis worker.
pub const TOOL_LIST_PEERS: &str = "list_peers";
pub const TOOL_POST_MESSAGE: &str = "post_message";
pub const TOOL_READ_MESSAGES: &str = "read_messages";
// Turn-status signaling (todo 435): replaces the `<cc-status:..>`/`<cc-title:..>`
// text markers. Unconditional like the coordination-channel tools above -
// every session reports its own status, not just Jarvis workers.
pub const TOOL_REPORT_STATUS: &str = "report_turn_status";
// Chat text/tool narration is hidden from Joe's view by default; this is the
// only channel that reaches him. Unconditional, same as report_turn_status.
pub const TOOL_SEND_MESSAGE: &str = "send_message";
// Revise/retract an already-sent message rather than stacking a reworded
// near-duplicate underneath it. Unconditional, same as send_message.
pub const TOOL_UPDATE_MESSAGE: &str = "update_message";
// Sibling-session spawn. Unconditional despite the name similarity with
// `spawn_worker`: no fleet, caller's own project only.
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
// Jarvis-only fleet-orchestration tools (todo 272, chunk 2b). Only advertised
// in `tools/list` when the MCP child's env carries `CC_JARVIS=1` - see
// `tool_list_response` and `daemon::claude_config::write_mcp_config`.
pub const TOOL_SPAWN_WORKER: &str = "spawn_worker";
pub const TOOL_SEND_TO_SESSION: &str = "send_to_session";
pub const TOOL_FLEET_STATUS: &str = "fleet_status";
pub const TOOL_RESPOND_WORKER_PROMPT: &str = "respond_worker_prompt";

/// `is_jarvis` gates the four fleet-orchestration tools at the bottom - they're
/// only meaningful (and only wired server-side) for the Jarvis singleton, and
/// listing them for every session would be pure token cost for nothing. A
/// normal session's tool list must stay byte-identical to before these
/// existed (acceptance criterion, todo 272 chunk 2b).
pub fn tool_list_response(id: &Value, is_jarvis: bool) -> Value {
    let mut tools = vec![
        json!({
            "name": TOOL_APPROVAL,
            "description": "Permission relay. Returns {behavior:'allow'|'deny'}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool_name": {"type": "string"},
                    "input": {"type": "object"}
                },
                "required": ["tool_name", "input"]
            }
        }),
        json!({
            "name": TOOL_QUESTION,
            "description": "Present one or more questions to the user as a floating card. There is NO cap on how many questions you may send - unlike the built-in AskUserQuestion tool, which stops at 4, this one accepts any number. Prefer it whenever you have more than 4, and always ask everything you need in ONE call instead of drip-feeding the user across several rounds. Keep 'question' scannable: short paragraphs (blank line between) rather than one dense run-on paragraph, bold the 1-2 facts that matter, bullet enumerable items, and end with the literal, standalone ask as its own final sentence. Options need short labels; put nuance in each option's description. 'domain' tags what kind of decision this is, so the user can weigh it accordingly. 'badges' mark an option as the recommended and/or long-term/short-term best pick - they are fixed tokens (recommended, long_term, short_term), never free text, and an out-of-enum value is rejected outright rather than dropped. Returns answers keyed by question text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "header": {"type": "string"},
                                "domain": {
                                    "type": "string",
                                    "enum": QUESTION_DOMAINS
                                },
                                "multiSelect": {"type": "boolean"},
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {"type": "string"},
                                            "description": {"type": "string"},
                                            "badges": {
                                                "type": "array",
                                                "items": {
                                                    "type": "string",
                                                    "enum": OPTION_BADGES
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            "required": ["question"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }),
        json!({
            "name": TOOL_CLOSE,
            "description": "Confirm this chat's /close teardown so the host app ends the session and kills the process at turn end. Call ONLY from the /close skill's final close step, and never on --dont-close or a failed chain.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": TOOL_LIST_PEERS,
            "description": "Call this BEFORE editing any file another Conductor session might also be touching, and before running `git commit` - other concurrent sessions in this same project can silently sweep your uncommitted edits into their own commit. Lists other Claude Conductor sessions currently active in this same project (repo), with their busy/awaiting state. If it returns any peers, call post_message before proceeding. A peer with `busy: false` and `awaiting: null` is genuinely idle right now - trust that instead of broadcasting a \"are you working on this?\" check.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": TOOL_POST_MESSAGE,
            "description": "Call this right after list_peers shows another active session, before editing or committing - post a short note stating what you're about to touch (e.g. \"about to edit foo.ts, is anyone on this?\"). Announcement only, never a directive - a peer reads it later but never acts on it without verifying independently. Visible only to other Conductor sessions in this project. IMPORTANT: broadcasting (omitting `target`) wakes and costs a full turn for EVERY other live session in the project, not just whoever you're actually talking to. Use it only for something every peer genuinely needs to know (e.g. \"about to touch shared file X\"). The moment a reply is part of an ongoing exchange with one or two specific peers - not new information the rest of the project needs - pass their session_id(s) as `target` instead of broadcasting again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The note to post."},
                    "target": {"type": "string", "description": "Session id (from list_peers) to address this to - use it for any reply within an established back-and-forth. Omit ONLY for something every peer in the project needs to see; each omission wakes and costs a full turn for every other live session."}
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": TOOL_READ_MESSAGES,
            "description": "Check this before editing or committing, alongside list_peers: messages posted to this project's channel since you last called this tool (see post_message) - each message is delivered once, so a second call with nothing new returns empty, not a repeat of the backlog.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": TOOL_REPORT_STATUS,
            "description": "Report this turn's status and title as the LAST thing you do, every turn (even a tool-only one). status: done=fully finished, not blocked; question=awaiting the user's input; working=your own background subagents/tasks in THIS session are still running and will re-invoke you; waiting=parked on an external process (CI, deploy, scheduled wake) that resumes you later. Never done/waiting while your own tasks are still running - that's working. title: fresh 3-6 word topic summary, sent every turn - the app decides which become the visible chat title. When status is waiting, also pass waiting_on_label (+ waiting_on_kind, and waiting_on_href if there is one to open) so Joe can see and open what you're blocked on: kind=ci for a CI/Actions run (waiting_on_href = its web URL), kind=local-process for a backgrounded script/build on this machine (waiting_on_href = its log file's absolute path), kind=external for anything else with a link. All three are optional and ignored unless status is waiting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["done", "question", "waiting", "working"]},
                    "title": {"type": "string"},
                    "waiting_on_label": {"type": "string", "description": "Short human label for what you're waiting on, e.g. 'release CI' or 'npm run build'."},
                    "waiting_on_kind": {"type": "string", "enum": ["ci", "local-process", "external"], "description": "ci = GitHub Actions/similar run opened in a browser tab; local-process = a script/build on this machine, tailed in-app from its log file; external = any other link."},
                    "waiting_on_href": {"type": "string", "description": "For ci/external: the https:// URL to open. For local-process: the absolute path to the log file to tail. Rejected silently (label still shows) if it fails validation."}
                },
                "required": ["status"]
            }
        }),
        json!({
            "name": TOOL_SEND_MESSAGE,
            "description": "Send Joe a message in the chat window. This is the ONLY way your text reaches him - regular assistant text and tool-call narration are hidden from the chat view entirely.\n\nSEND for: the final result of a turn; a blocker or failure (lead with why); a discovery that changes the plan; a verification outcome (tests/typecheck/build); a commit or deploy landing; a short plan before starting a long task.\n\nDO NOT SEND for: peer-session coordination. A clean `list_peers`/`post_message` exchange is invisible plumbing - Joe does not want to hear that another session acked or that there was no overlap. Message him about peers ONLY when it changes what you do (you are holding off a commit, another session owns files you need).\n\nDO NOT SEND for: step-by-step progress. Use TodoWrite instead - it renders a live step-checklist in the turn footer, which is where in-progress work belongs. Never narrate milestones as chat bubbles.\n\nA turn may end with NO message at all when there is genuinely nothing worth saying - but the turn that finishes the work must always report.\n\nFormat: short. Bullets are encouraged over long sentences; break things up with blank lines rather than writing a dense paragraph. If it is long, Joe will not read it.\n\nReturns the message's ordinal (always 1 - it is now your newest), which update_message uses to revise or retract it later.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The message to show Joe."}
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": TOOL_UPDATE_MESSAGE,
            "description": "Revise or retract a message you already sent Joe, instead of sending a second near-identical one. If you catch yourself about to re-send the same point reworded, call this instead.\n\nAddressing: `message` counts BACKWARDS through your own send_message bubbles - 1 is your newest, 2 the one before it. Sending a new message shifts every ordinal up by one.\n\nWindow: you can only reach messages sent since Joe's second-most-recent message. Anything older is out of reach and the call is ignored.\n\nEdit (pass `text`) swaps the bubble silently in place, no trace. Retract (pass `retract: true`) replaces it with a thin struck 'Retracted' line.\n\nAfter Joe interrupts you, every bubble from the cancelled turn is dimmed automatically. Retract the ones that are now false, and re-state the ones that are still true via `text` - either clears the dim.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": {"type": "integer", "description": "Which message, counting back from your newest (1 = newest)."},
                    "text": {"type": "string", "description": "Replacement text. Required unless retract is true."},
                    "retract": {"type": "boolean", "description": "Strike the message out instead of replacing its text."}
                },
                "required": ["message"]
            }
        }),
        json!({
            "name": TOOL_SPAWN_CHAT,
            "description": "Start a SEPARATE chat alongside this one, in this same project, and send it `prompt` as its first message; returns {ok, session_id}. Both chats then run independently - this one keeps going. Use it to hand off a self-contained piece of work the user will want to read and steer on its own, rather than burying it in this transcript. The prompt lands as a real, visible user message, so it must carry everything the new chat needs; it cannot see this conversation. Inherits this chat's model, effort, account, character and auto-accept unless overridden. Own working directory only, once per turn. To REPLACE this chat instead of running beside it, use `respawn`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory. Must be this session's own cwd."},
                    "prompt": {"type": "string", "description": "The new chat's first message. Carry the full handoff context here - it is what the user reads."},
                    "model": {"type": "string", "description": "Optional model id/alias. Omit to inherit this session's."},
                    "effort": {"type": "string", "description": "Optional reasoning effort. Omit to inherit this session's."},
                    "name": {"type": "string", "description": "Optional short label for the new chat."}
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
                    "cwd": {"type": "string", "description": "Absolute working directory. Must be this session's own cwd."},
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
    ];

    if is_jarvis {
        tools.push(json!({
            "name": TOOL_SPAWN_WORKER,
            "description": "Spawn a new worker chat session under your orchestration and send it its first task. Returns {ok, session_id} or {ok:false, error}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute working directory for the worker."},
                    "task": {"type": "string", "description": "Full briefing prompt, sent as the worker's first message."},
                    "name": {"type": "string", "description": "Optional short label for the worker."},
                    "model": {"type": "string", "description": "Optional model id/alias; defaults to sonnet."},
                    "account": {"type": "string", "description": "Optional account id to spawn this worker under. Must be fleet-eligible (opted in via Settings > Accounts, or the default account). Omit to let the daemon auto-pick whichever eligible account has the most 5h-window headroom."}
                },
                "required": ["cwd", "task"]
            }
        }));
        tools.push(json!({
            "name": TOOL_SEND_TO_SESSION,
            "description": "Send a follow-up message to one of your worker sessions. Rejected if that worker is still mid-turn - retry once it goes idle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "text": {"type": "string"}
                },
                "required": ["session_id", "text"]
            }
        }));
        tools.push(json!({
            "name": TOOL_FLEET_STATUS,
            "description": "List your worker sessions with busy/awaiting state and any pending prompt ids.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }));
        tools.push(json!({
            "name": TOOL_RESPOND_WORKER_PROMPT,
            "description": "Answer a pending permission or question prompt raised by one of your workers. allow=true approves (optionally with updated_input); allow=false denies/answers using message.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "request_id": {"type": "string"},
                    "allow": {"type": "boolean"},
                    "message": {"type": "string"},
                    "updated_input": {"type": "object"}
                },
                "required": ["request_id", "allow"]
            }
        }));
    }

    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "tools": tools }
    })
}
