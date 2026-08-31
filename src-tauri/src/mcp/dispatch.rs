//! `tools/call` dispatch for the stdio MCP server. Every arm has the same shape:
//! build a hooks-server URL, build a JSON body from `arguments`, hand off to
//! `relay`. Arms are grouped by domain so a new tool has an obvious home.

use serde_json::{json, Value};

use crate::daemon::preview::PREVIEW_SOURCE_CHAT_CARD;

use super::relay::{http_post, Ctx, HttpPost};
use super::server::{mcp_error, question_args, tool_error_result, waiting_target};
use super::tool_schemas::{
    TOOL_APPROVAL, TOOL_CLOSE, TOOL_FLEET_STATUS, TOOL_LIST_PEERS, TOOL_POST_MESSAGE, TOOL_QUESTION,
    TOOL_READ_MESSAGES, TOOL_REPORT_STATUS, TOOL_RESPAWN, TOOL_RESPOND_WORKER_PROMPT,
    TOOL_SEND_MESSAGE, TOOL_SEND_TO_SESSION, TOOL_SHOW_PREVIEW, TOOL_SPAWN_CHAT,
    TOOL_SPAWN_WORKER, TOOL_UPDATE_MESSAGE, TOOL_WRITE_DRAFT, TOOL_WRITE_USER_TODO,
};

/// Route one `tools/call` to its hooks-server endpoint.
pub(super) fn dispatch_tool(
    rt: &tokio::runtime::Runtime,
    id: &Value,
    name: &str,
    arguments: &Value,
    session_id: &str,
    port: u16,
) -> Value {
    dispatch_tool_with(rt, id, name, arguments, session_id, port, http_post)
}

/// Same routing as `dispatch_tool`, with the HTTP transport swapped for
/// `post` (todo 707's test seam).
pub(super) fn dispatch_tool_with(
    rt: &tokio::runtime::Runtime,
    id: &Value,
    name: &str,
    arguments: &Value,
    session_id: &str,
    port: u16,
    post: HttpPost,
) -> Value {
    let ctx = Ctx {
        rt,
        id,
        args: arguments,
        session_id,
        port,
        post,
    };
    prompt_tools(&ctx, name)
        .or_else(|| session_tools(&ctx, name))
        .or_else(|| channel_tools(&ctx, name))
        .or_else(|| user_facing_tools(&ctx, name))
        .or_else(|| jarvis_tools(&ctx, name))
        .unwrap_or_else(|| mcp_error(id, -32601, "unknown tool"))
}

/// The two prompts that block the turn until the dev answers.
fn prompt_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    let request_id = uuid::Uuid::new_v4().to_string();
    match name {
        TOOL_APPROVAL => {
            let tool_name = ctx.args["tool_name"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            let input = ctx.args["input"].clone();
            let body = json!({
                "id": request_id,
                "tool_name": tool_name,
                "input": input,
                "session_id": ctx.session_id,
            });
            Some(ctx.relay("/permissions/request", body, None, None))
        }
        TOOL_QUESTION => {
            // todo 818: reject out-of-enum domain/badges HERE - downstream is
            // permissive (untyped relay, card strips unknowns), so a bad chip
            // used to vanish behind a normal `{"acknowledged": true}`.
            let questions = match question_args::normalize(&ctx.args["questions"]) {
                Ok(q) => q,
                Err(reason) => return Some(tool_error_result(ctx.id, &reason)),
            };
            let body = json!({
                "id": request_id,
                "questions": questions,
                "session_id": ctx.session_id,
            });
            Some(ctx.relay("/questions/request", body, None, None))
        }
        _ => None,
    }
}

/// Session lifecycle: end this one, spawn a sibling chat, or hand off to a
/// successor and stand down.
fn session_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_CLOSE => {
            // Fire-and-confirm: the daemon records the close and
            // tears down at turn end (session_id comes from the
            // per-session CC_SESSION_ID env, not tool args).
            let body = json!({ "session_id": ctx.session_id });
            Some(ctx.relay(
                "/sessions/close-confirm",
                body,
                None,
                Some("close confirmed; session will end at turn completion"),
            ))
        }
        TOOL_SPAWN_CHAT | TOOL_RESPAWN => {
            // One endpoint, one flag: respawn IS spawn_chat plus the successor
            // link and the caller's close, both of which the daemon applies.
            let body = json!({
                "session_id": ctx.session_id,
                "cwd": ctx.args["cwd"],
                "prompt": ctx.args["prompt"],
                "model": ctx.args.get("model"),
                "effort": ctx.args.get("effort"),
                "name": ctx.args.get("name"),
                "respawn": name == TOOL_RESPAWN,
            });
            Some(ctx.relay("/chat/spawn", body, None, None))
        }
        _ => None,
    }
}

/// `post_message`'s optional `target` (todo 698): one session id or a list,
/// normalized to an array so the daemon body shape is stable. Absent, blank or
/// non-string stays null, which the daemon reads as today's broadcast.
fn normalize_targets(raw: Option<&Value>) -> Value {
    let ids: Vec<Value> = match raw {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => return Value::Null,
    }
    .into_iter()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(|s| Value::String(s.to_string()))
    .collect();
    if ids.is_empty() {
        Value::Null
    } else {
        Value::Array(ids)
    }
}

/// Inter-agent coordination channel, scoped per project.
fn channel_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_LIST_PEERS => {
            let body = json!({ "session_id": ctx.session_id });
            Some(ctx.relay("/channel/list-peers", body, None, None))
        }
        TOOL_POST_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "text": ctx.args["text"],
                "target": normalize_targets(ctx.args.get("target")),
            });
            Some(ctx.relay("/channel/post-message", body, None, None))
        }
        TOOL_READ_MESSAGES => {
            let body = json!({ "session_id": ctx.session_id });
            Some(ctx.relay("/channel/read-messages", body, None, None))
        }
        _ => None,
    }
}

/// Body for `/turn/report-status` (todo 675). `waitingOn` is null unless the
/// caller passed the optional waiting-target params AND they survive the
/// `waiting_target` guard, so an omitting caller is byte-identical to before.
fn report_status_body(args: &Value, session_id: &str, roots: &[std::path::PathBuf]) -> Value {
    let waiting_on = waiting_target::sanitize(
        args.get("waiting_on_label").and_then(Value::as_str),
        args.get("waiting_on_kind").and_then(Value::as_str),
        args.get("waiting_on_href").and_then(Value::as_str),
        roots,
    );
    json!({
        "session_id": session_id,
        "status": args["status"],
        "title": args.get("title"),
        "waitingOn": waiting_on,
    })
}

/// Turn status/title, chat messages, and the Your Todos panel.
fn user_facing_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_REPORT_STATUS => {
            let body =
                report_status_body(ctx.args, ctx.session_id, &waiting_target::default_roots());
            Some(ctx.relay("/turn/report-status", body, Some("invalid status"), None))
        }
        TOOL_SEND_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "text": ctx.args["text"],
            });
            Some(ctx.relay("/messages/send", body, Some("invalid message"), None))
        }
        TOOL_UPDATE_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "message": ctx.args["message"],
                "text": ctx.args.get("text"),
                "retract": ctx.args.get("retract").and_then(|v| v.as_bool()).unwrap_or(false),
            });
            Some(ctx.relay("/messages/update", body, Some("invalid update"), None))
        }
        TOOL_WRITE_USER_TODO => {
            // Omit absent keys rather than relaying `null`: `#[serde(default)]`
            // on the receiver only covers a missing key, not an explicit null.
            let mut body = serde_json::Map::new();
            body.insert("session_id".to_string(), json!(ctx.session_id));
            body.insert("action".to_string(), ctx.args["action"].clone());
            for key in ["id", "text", "reason"] {
                if let Some(v) = ctx.args.get(key) {
                    body.insert(key.to_string(), v.clone());
                }
            }
            Some(ctx.relay("/todos/write", Value::Object(body), Some("invalid todo write"), None))
        }
        TOOL_WRITE_DRAFT => {
            // Same omit-absent-keys rule as the todo write above.
            let mut body = serde_json::Map::new();
            body.insert("session_id".to_string(), json!(ctx.session_id));
            body.insert("action".to_string(), ctx.args["action"].clone());
            for key in ["id", "topic", "recipient", "body", "note", "brief", "receipts"] {
                if let Some(v) = ctx.args.get(key) {
                    body.insert(key.to_string(), v.clone());
                }
            }
            Some(ctx.relay("/drafts/write", Value::Object(body), Some("invalid draft write"), None))
        }
        TOOL_SHOW_PREVIEW => {
            // Same endpoint terminal Claude curls. `session_id` scopes the
            // snapshot to this chat's rail; the source value is what tells the
            // rail an inline card already exists, so it must not force open.
            let slug = ctx.args["slug"].as_str().unwrap_or("").to_string();
            let title = match ctx.args["title"].as_str().map(str::trim) {
                Some(t) if !t.is_empty() => t.to_string(),
                _ => crate::chat::parser::preview_title_from_slug(&slug),
            };
            let body = json!({
                "title": title,
                "slug": slug,
                "html": ctx.args["html"],
                "source": PREVIEW_SOURCE_CHAT_CARD,
                "session_id": ctx.session_id,
            });
            Some(ctx.relay("/hooks/preview", body, None, Some("preview shown in chat")))
        }
        _ => None,
    }
}

/// Only advertised to a Jarvis child's `tools/list` (see `is_jarvis` in
/// `server`), but a `tools/call` for a never-shown tool still lands here, so
/// every daemon route re-validates that `session_id` (this child's own
/// CC_SESSION_ID) is the registry's Jarvis session before doing anything.
fn jarvis_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    match name {
        TOOL_SPAWN_WORKER => {
            let body = json!({
                "jarvis_session_id": ctx.session_id,
                "cwd": ctx.args["cwd"],
                "task": ctx.args["task"],
                "name": ctx.args.get("name"),
                "model": ctx.args.get("model"),
                "account": ctx.args.get("account"),
            });
            Some(ctx.relay("/jarvis/spawn-worker", body, None, None))
        }
        TOOL_SEND_TO_SESSION => {
            let body = json!({
                "jarvis_session_id": ctx.session_id,
                "session_id": ctx.args["session_id"],
                "text": ctx.args["text"],
            });
            Some(ctx.relay("/jarvis/send-to-session", body, None, None))
        }
        TOOL_FLEET_STATUS => {
            let body = json!({ "jarvis_session_id": ctx.session_id });
            Some(ctx.relay("/jarvis/fleet-status", body, None, None))
        }
        TOOL_RESPOND_WORKER_PROMPT => {
            let body = json!({
                "jarvis_session_id": ctx.session_id,
                "request_id": ctx.args["request_id"],
                "allow": ctx.args["allow"],
                "message": ctx.args.get("message"),
                "updated_input": ctx.args.get("updated_input"),
            });
            Some(ctx.relay("/jarvis/respond-worker-prompt", body, None, None))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_status_without_the_new_params_still_validates() {
        let args = json!({"status": "done", "title": "Fix bug"});
        let body = report_status_body(&args, "sess-1", &[]);
        assert_eq!(body["status"], json!("done"));
        assert_eq!(body["title"], json!("Fix bug"));
        assert_eq!(body["session_id"], json!("sess-1"));
        assert_eq!(body["waitingOn"], Value::Null);
    }

    #[test]
    fn report_status_with_no_title_at_all_still_validates() {
        let body = report_status_body(&json!({"status": "waiting"}), "s", &[]);
        assert_eq!(body["status"], json!("waiting"));
        assert_eq!(body["title"], Value::Null);
        assert_eq!(body["waitingOn"], Value::Null);
    }

    #[test]
    fn report_status_carries_a_guarded_ci_target() {
        let url = "https://github.com/o/r/actions/runs/32115742584";
        let args = json!({
            "status": "waiting",
            "waiting_on_label": "release CI",
            "waiting_on_kind": "ci",
            "waiting_on_href": url,
        });
        let body = report_status_body(&args, "s", &[]);
        assert_eq!(body["waitingOn"]["kind"], json!("ci"));
        assert_eq!(body["waitingOn"]["label"], json!("release CI"));
        assert_eq!(body["waitingOn"]["href"], json!(url));
    }

    #[test]
    fn report_status_strips_an_out_of_tree_local_path() {
        let args = json!({
            "status": "waiting",
            "waiting_on_label": "build",
            "waiting_on_kind": "local-process",
            "waiting_on_href": "/etc/passwd",
        });
        let body = report_status_body(&args, "s", &[]);
        assert_eq!(body["waitingOn"]["label"], json!("build"));
        assert_eq!(body["waitingOn"]["href"], Value::Null);
    }

    /// TRUST BOUNDARY (todo 675): a hostile local path and a hostile href are
    /// BOTH stripped at this MCP ingest point - the label survives (so the
    /// chip still shows what's being waited on), but nothing unsafe reaches
    /// storage.
    #[test]
    fn report_status_rejects_a_hostile_path_and_a_hostile_href_at_ingest() {
        let hostile_path = report_status_body(
            &json!({
                "status": "waiting",
                "waiting_on_label": "build",
                "waiting_on_kind": "local-process",
                "waiting_on_href": "../../etc/passwd",
            }),
            "s",
            &[],
        );
        assert_eq!(hostile_path["waitingOn"]["label"], json!("build"));
        assert_eq!(hostile_path["waitingOn"]["href"], Value::Null, "relative traversal must not reach storage");

        let hostile_href = report_status_body(
            &json!({
                "status": "waiting",
                "waiting_on_label": "run",
                "waiting_on_kind": "ci",
                "waiting_on_href": "javascript:alert(document.cookie)",
            }),
            "s",
            &[],
        );
        assert_eq!(hostile_href["waitingOn"]["label"], json!("run"));
        assert_eq!(hostile_href["waitingOn"]["href"], Value::Null, "non-http(s) scheme must not reach storage");
    }

    #[test]
    fn post_message_without_a_target_stays_a_broadcast() {
        assert_eq!(normalize_targets(None), Value::Null);
        assert_eq!(normalize_targets(Some(&json!([]))), Value::Null);
        assert_eq!(normalize_targets(Some(&json!("   "))), Value::Null);
        assert_eq!(normalize_targets(Some(&json!(7))), Value::Null);
    }

    #[test]
    fn post_message_target_normalizes_to_an_array() {
        assert_eq!(normalize_targets(Some(&json!("sess-a"))), json!(["sess-a"]));
        assert_eq!(
            normalize_targets(Some(&json!([" sess-a ", "", "sess-b", 3]))),
            json!(["sess-a", "sess-b"]),
            "blanks and non-strings dropped, ids trimmed"
        );
    }
}
