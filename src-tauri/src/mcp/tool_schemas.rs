//! Static MCP tool-list schema data: names, descriptions, inputSchema JSON.
//! Split out of `server.rs` (todo 452) to keep that file to the stdio
//! dispatch loop. No behavior change; content is byte-identical to before.

use serde_json::{json, Value};

pub const TOOL_APPROVAL: &str = "approval_prompt";
pub const TOOL_QUESTION: &str = "ask_user_question";
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
// Jarvis-only fleet-orchestration tools (todo 272, chunk 2b). Only advertised
// in `tools/list` when the MCP child's env carries `CC_JARVIS=1` - see
// `tool_list_response` and `daemon::claude_config::write_mcp_config`.
pub const TOOL_SPAWN_WORKER: &str = "spawn_worker";
pub const TOOL_SEND_TO_SESSION: &str = "send_to_session";
pub const TOOL_FLEET_STATUS: &str = "fleet_status";
pub const TOOL_RESPOND_WORKER_PROMPT: &str = "respond_worker_prompt";

/// `is_jarvis` gates the four fleet-orchestration tools below - they're only
/// meaningful (and only wired server-side) for the Jarvis singleton, and
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
            "description": "Present one or more questions to the user as a floating card. There is NO cap on how many questions you may send - unlike the built-in AskUserQuestion tool, which stops at 4, this one accepts any number. Prefer it whenever you have more than 4, and always ask everything you need in ONE call instead of drip-feeding the user across several rounds. Keep 'question' scannable: short paragraphs (blank line between) rather than one dense run-on paragraph, bold the 1-2 facts that matter, bullet enumerable items, and end with the literal, standalone ask as its own final sentence. Options need short labels; put nuance in each option's description. 'domain' tags what kind of decision this is, so the user can weigh it accordingly. 'badges' mark an option as the recommended and/or long-term/short-term best pick. Returns answers keyed by question text.",
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
                                    "enum": ["ux", "arch", "sec", "data", "tooling", "infra", "billing"]
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
                                                    "enum": ["recommended", "long_term", "short_term"]
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
            "description": "Call this BEFORE editing any file another Conductor session might also be touching, and before running `git commit` - other concurrent sessions in this same project can silently sweep your uncommitted edits into their own commit. Lists other Claude Conductor sessions currently active in this same project (repo), with their busy/awaiting state. If it returns any peers, call post_message before proceeding.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": TOOL_POST_MESSAGE,
            "description": "Call this right after list_peers shows another active session, before you start editing or committing - post a short note saying what you're about to touch (e.g. \"about to edit foo.ts, is anyone on this?\"). Every other currently-active session in this project is nudged to read it at its next idle moment. Only visible to other Conductor sessions in this same project - not a general chat.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The note to post."}
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": TOOL_READ_MESSAGES,
            "description": "Check this before editing or committing, alongside list_peers: recent coordination-channel history for this project (see post_message) - a peer may have already flagged the exact file or area you're about to touch.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": TOOL_REPORT_STATUS,
            "description": "Report this turn's status and title as the LAST thing you do, every turn (even a tool-only one). status: done=fully finished, not blocked; question=awaiting the user's input; working=your own background subagents/tasks in THIS session are still running and will re-invoke you; waiting=parked on an external process (CI, deploy, scheduled wake) that resumes you later. Never done/waiting while your own tasks are still running - that's working. title: fresh 3-6 word topic summary, sent every turn - the app decides which become the visible chat title.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["done", "question", "waiting", "working"]},
                    "title": {"type": "string"}
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
