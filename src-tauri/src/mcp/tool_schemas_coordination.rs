//! Split out of `tool_schemas.rs` (todo 801): the inter-agent coordination
//! channel and turn-status/messaging tool schemas. Content is byte-identical
//! to before.

use serde_json::{json, Value};

// Inter-agent coordination-channel tools: unconditionally advertised (unlike
// the Jarvis fleet tools) - any session running through this app should be
// able to see who else is active in its project and coordinate with them,
// not just a Jarvis worker.
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

pub fn coordination_schemas() -> Vec<Value> {
    vec![
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
    ]
}
