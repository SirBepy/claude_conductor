//! Split out of `tool_schemas.rs` (todo 801): the permission-relay,
//! question-card, and close-confirm tool schemas. Content is byte-identical
//! to before.

use serde_json::{json, Value};

pub const TOOL_APPROVAL: &str = "approval_prompt";
pub const TOOL_QUESTION: &str = "ask_user_question";
pub const TOOL_REQUEST_SECRET: &str = "request_secret";
pub const TOOL_CAPTURE_SECRET: &str = "capture_secret_from_page";

/// Shared by the schema below and `server::question_args`'s validator so the
/// two cannot drift (todo 818). Frontend twin: `DOMAIN_META`/`BADGE_META` in
/// `src/views/sessions/permission-modal/types.ts`.
pub const QUESTION_DOMAINS: [&str; 7] =
    ["ux", "arch", "sec", "data", "tooling", "infra", "billing"];
pub const OPTION_BADGES: [&str; 3] = ["recommended", "long_term", "short_term"];
pub const TOOL_CLOSE: &str = "close_session";

pub fn core_schemas() -> Vec<Value> {
    vec![
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
            "description": "Present one or more questions to the user as a floating card. There is NO cap on how many questions you may send - unlike the built-in AskUserQuestion tool, which stops at 4, this one accepts any number. Prefer it whenever you have more than 4, and always ask everything you need in ONE call instead of drip-feeding the user across several rounds. Keep 'question' scannable: short paragraphs (blank line between) rather than one dense run-on paragraph, bold the 1-2 facts that matter, bullet enumerable items, and end with the literal, standalone ask as its own final sentence. Options need short labels; put nuance in each option's description. 'domain' tags what kind of decision this is, so the user can weigh it accordingly. 'badges' mark an option as the recommended and/or long-term/short-term best pick - they are fixed tokens (recommended, long_term, short_term), never free text, and an out-of-enum value is rejected outright rather than dropped. 'preview' shows what an option would LOOK like: an HTML fragment (no <html>/<head>, no scripts - they never run) rendered on the card in a sandboxed frame that already has the app's own stylesheets loaded, so use the app's real classes and CSS variables (var(--color-surface), var(--color-text), ...) instead of hand-drawn imitations. A local raster image (png, jpg, gif, webp, bmp) can be shown with <img src=\"file:///C:/path/x.png\">: the desktop app inlines it from any local path, but the phone and a paired machine only read files under a project folder or this chat's own folder (never svg), and anything unreadable shows 'Picture unavailable', so save screenshots inside the project. To show the REAL thing, take a screenshot of it (save it inside the project, e.g. under .for_bepy/screenshots/) or render it through the app's real components, and put that in the preview: a hand-drawn HTML imitation of a screen looks nothing like it and is the wrong picture. A QUESTION can carry one 'preview' of its own (a property of the question, next to 'options'), shown at the top of the card above the question text with a fullscreen button: use it when one picture is what the whole question is about, e.g. 'Is this good, or do you want to change something?' with options that look alike. It is optional, one per question. A domain 'ux' question needs a preview on at least one option or on the question itself, or the call is rejected. Give an option a preview ONLY when it differs from the other options and from the question's picture: never copy one image onto every option, put a shared image on the question once; options without a preview show as plain options. A question about behaviour rather than looks belongs to another domain. A sub (a hidden chat run for a main chat) can end a job that needs Joe's judgement with 'final_stamp': true, a flag on the whole call that is refused for any other chat. The app then prints git and transcript facts (commits, files changed, uncommitted, last test result, reviewer result) under the card itself, so never write them. 'reviewer_tool_use_id', used only with final_stamp, is normally left out: the app finds the fresh reviewer subagent you ran after your last edit by itself, so the reviewer chip can show its result, and an id you pass is checked. When one ordering is what you want (\"what is first, second, third\"), ask ONE question with 'ordered': true instead of several: Joe taps the options in the order he wants and leaves out any that do not belong. Its answer is a list of \"1. label\", \"2. label\" in that order, then one \"Unmarked: a, b\" entry naming the options he left out. 'ordered' needs at least two options and is not combined with 'multiSelect'. Returns answers keyed by question text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "final_stamp": {"type": "boolean"},
                    "reviewer_tool_use_id": {"type": "string"},
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
                                "preview": {"type": "string"},
                                "multiSelect": {"type": "boolean"},
                                "ordered": {"type": "boolean"},
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {"type": "string"},
                                            "description": {"type": "string"},
                                            "preview": {"type": "string"},
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
            "name": TOOL_REQUEST_SECRET,
            "description": "Ask Joe to type a secret (an API key, password, or token) directly into a masked card instead of pasting it into this chat. The value NEVER comes back to you - the tool result only ever reports 'saved N characters' (or an error/cancellation), so you learn the length, never the contents. 'label' names what the secret is for (e.g. 'Kinetic Panel API key'), 'file' is the path of a key=value file to write it into (relative paths resolve against this chat's folder; the target must be gitignored), and 'key' is that line's key. Use this whenever a task needs a credential from Joe instead of asking him to paste it in chat text, where it would sit in the transcript in plaintext.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "file": {"type": "string"},
                    "key": {"type": "string"},
                    "temporary": {
                        "type": "boolean",
                        "description": "Set true for a credential you only need while this chat is open: the line is deleted from the file (or the whole file, if this call created it) when the chat closes, and the card tells Joe so. Leave it out for a secret that must outlive the chat."
                    }
                },
                "required": ["label", "file", "key"]
            }
        }),
        json!({
            "name": TOOL_CAPTURE_SECRET,
            "description": "Copy a credential that is SHOWN ON A WEB PAGE in the browser you are driving (a client secret or API key a console prints once) straight into a gitignored key=value file, without the value ever reaching you. Joe approves each save on a card that names the label, the file and the element; the value goes from the page to the file inside the daemon and the tool result only reports 'saved N characters'. 'target' is the element's snapshot ref or a unique selector, and it must point at the ONE element that holds the secret (a whole-page selector is refused). 'label' names the secret for Joe, 'file' and 'key' follow request_secret's rules (relative paths resolve against this chat's folder, the target must be gitignored). Use this instead of browser_evaluate with a file name, and instead of asking Joe to copy the value by hand; request_secret is still the tool for a secret that is not on a page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "file": {"type": "string"},
                    "key": {"type": "string"},
                    "target": {"type": "string", "description": "A snapshot ref (from browser_snapshot) or a unique CSS selector for the element showing the secret."},
                    "temporary": {
                        "type": "boolean",
                        "description": "Set true for a credential you only need while this chat is open: the line is deleted when the chat closes. Leave it out for a secret that must outlive the chat."
                    }
                },
                "required": ["label", "file", "key", "target"]
            }
        }),
        json!({
            "name": TOOL_CLOSE,
            "description": "End this chat. Call it once, when the task is fully done and nothing is pending for Joe (after the save step), or when Joe tells you to close. The session ends when the turn completes, so end the turn right after the call. A sub cannot call it: a sub ends with finish_subchat. A main chat with running subs is held: Joe is asked on a card, and the call answers that the chat is not closed yet.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
    ]
}
