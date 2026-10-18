//! `tools/call` dispatch for the stdio MCP server. Every arm has the same shape:
//! build a hooks-server URL, build a JSON body from `arguments`, hand off to
//! `relay`. Arms are grouped by domain so a new tool has an obvious home.
//!
//! The Jarvis fleet arms live in the sibling `dispatch_jarvis.rs` (todo 901):
//! that group already matched a `tool_schemas_jarvis.rs` domain 1:1, so it
//! was the split with no re-litigated seam.

use serde_json::{json, Value};

use crate::daemon::preview::PREVIEW_SOURCE_CHAT_CARD;

use super::dispatch_browser::browser_tools;
use super::dispatch_jarvis::jarvis_tools;
use super::relay::{http_post, Ctx, HttpPost};
use super::server::{mcp_error, question_args, tool_error_result, tool_result, waiting_target};
use super::tool_schemas::{
    TOOL_APPROVAL, TOOL_CLOSE, TOOL_CREATE_PROJECT, TOOL_LIST_PEERS, TOOL_POST_MESSAGE, TOOL_QUESTION,
    TOOL_READ_MESSAGES, TOOL_REPORT_STATUS, TOOL_REQUEST_SECRET, TOOL_RESPAWN, TOOL_SCHEDULE,
    TOOL_PERSON, TOOL_SEND_MESSAGE, TOOL_SHOW_PREVIEW, TOOL_SPAWN_CHAT, TOOL_UPDATE_MESSAGE, TOOL_WRITE_DRAFT,
    TOOL_WRITE_PLAN, TOOL_WRITE_USER_TODO,
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
        .or_else(|| browser_tools(&ctx, name))
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
        TOOL_REQUEST_SECRET => {
            let label = ctx.args["label"].as_str().unwrap_or("").trim().to_string();
            let file = ctx.args["file"].as_str().unwrap_or("").trim().to_string();
            let key = ctx.args["key"].as_str().unwrap_or("").trim().to_string();
            if label.is_empty() || file.is_empty() || key.is_empty() {
                return Some(tool_error_result(ctx.id, "label, file, and key are all required"));
            }
            let body = json!({
                "id": request_id,
                "session_id": ctx.session_id,
                "label": label,
                "file": file,
                "key": key,
            });
            // Not `ctx.relay`: that helper's `success` param is a single static
            // string, but the daemon's ok=true reply carries a per-call
            // `text` field ("saved N characters...") that must pass through
            // verbatim - so the transport is called directly here. Same
            // `ctx.post` fn pointer `relay()` itself uses, so this inherits
            // the same RELAY_TIMEOUT_SECS (3660s) the blocking write needs.
            let url = format!("http://127.0.0.1:{}/secrets/request", ctx.port);
            Some(request_secret_result(ctx.id, (ctx.post)(ctx.rt, &url, body)))
        }
        _ => None,
    }
}

/// Maps the daemon's `/secrets/request` reply to a tool result: `ok:true`
/// carries a safe `text` summary ("saved N characters..." / "cancelled"),
/// never the secret value itself (which never reaches this process at all -
/// it travels only through the app's own `respond_secret` call straight into
/// the daemon's write). `ok:false` carries `error`.
fn request_secret_result(id: &Value, posted: Result<Value, String>) -> Value {
    match posted {
        Ok(resp) if resp["ok"].as_bool() == Some(true) => {
            tool_result(id, resp["text"].as_str().unwrap_or(""))
        }
        Ok(resp) => {
            let err = resp["error"].as_str().unwrap_or("request_secret failed");
            tool_error_result(id, err)
        }
        Err(e) => tool_error_result(id, &format!("relay error: {e}")),
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
            // `machine` only ever comes from `spawn_chat`'s own schema (`respawn`
            // has no such property) - the daemon still rejects it defensively
            // if it somehow arrives on a respawn call.
            let body = json!({
                "session_id": ctx.session_id,
                "cwd": ctx.args["cwd"],
                "prompt": ctx.args["prompt"],
                "model": ctx.args.get("model"),
                "effort": ctx.args.get("effort"),
                "name": ctx.args.get("name"),
                "respawn": name == TOOL_RESPAWN,
                "machine": ctx.args.get("machine"),
            });
            Some(ctx.relay("/chat/spawn", body, None, None))
        }
        TOOL_SCHEDULE => {
            // Same omit-absent-keys rule as the todo/draft writes below: the
            // receiver's `#[serde(default)]` covers a missing key, not an
            // explicit null.
            let mut body = serde_json::Map::new();
            body.insert("session_id".to_string(), json!(ctx.session_id));
            body.insert("action".to_string(), ctx.args["action"].clone());
            for key in ["prompt", "target", "in_minutes", "at", "repeat", "cwd", "name", "id"] {
                if let Some(v) = ctx.args.get(key) {
                    body.insert(key.to_string(), v.clone());
                }
            }
            Some(ctx.relay("/schedule/write", Value::Object(body), Some("invalid schedule write"), None))
        }
        TOOL_CREATE_PROJECT => {
            let body = json!({
                "session_id": ctx.session_id,
                "path": ctx.args["path"],
            });
            Some(ctx.relay("/projects/create", body, Some("invalid project path"), None))
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
            let body = json!({
                "session_id": ctx.session_id,
                "scope": ctx.args.get("scope"),
            });
            Some(ctx.relay("/channel/list-peers", body, None, None))
        }
        TOOL_POST_MESSAGE => {
            let body = json!({
                "session_id": ctx.session_id,
                "text": ctx.args["text"],
                "target": normalize_targets(ctx.args.get("target")),
                "to": ctx.args.get("to"),
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
            Some(ctx.relay("/drafts/write", forward_all_args(ctx.args, ctx.session_id), Some("invalid draft write"), None))
        }
        TOOL_PERSON => {
            let route = match ctx.args["action"].as_str() {
                Some("find") => "/people/find",
                Some("remember") => "/people/remember",
                _ => return Some(tool_error_result(ctx.id, "action must be find or remember")),
            };
            Some(ctx.relay(route, forward_all_args(ctx.args, ctx.session_id), Some("invalid person call"), None))
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
        TOOL_WRITE_PLAN => {
            // The checklist renders off this call's own `tool_use` event in the
            // transcript, the same path `TodoWrite` takes, so the route only
            // validates the shape - a duplicate step text silently collapses
            // two rows in the renderer's keyed map.
            let body = json!({
                "session_id": ctx.session_id,
                "steps": ctx.args["steps"],
            });
            Some(ctx.relay("/plan/write", body, Some("invalid plan"), None))
        }
        _ => None,
    }
}

/// Every argument the model sent, plus `session_id`, for a route that reads
/// the rest as one flattened object. A hand-kept key list here drifted from
/// the tool's schema once and silently dropped `person`/`platform`; copying
/// what arrived cannot. Absent keys stay absent, never an explicit null.
fn forward_all_args(args: &Value, session_id: &str) -> Value {
    let mut body = args.as_object().cloned().unwrap_or_default();
    body.insert("session_id".to_string(), json!(session_id));
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every property `write_draft` declares reaches the daemon route.
    #[test]
    fn write_draft_forwards_every_schema_property() {
        let tools = super::super::tool_schemas_workflow::workflow_schemas();
        let schema = tools
            .iter()
            .find(|t| t["name"] == TOOL_WRITE_DRAFT)
            .expect("write_draft is registered");
        let props = schema["inputSchema"]["properties"].as_object().unwrap();
        let args: serde_json::Map<String, Value> = props.keys().map(|k| (k.clone(), json!("x"))).collect();
        let body = forward_all_args(&Value::Object(args), "s1");
        for key in props.keys() {
            assert_eq!(body[key.as_str()], json!("x"), "{key} was dropped on the way to the daemon");
        }
        assert_eq!(body["session_id"], json!("s1"));
        assert!(forward_all_args(&json!({"action": "add"}), "s1").get("person").is_none(), "absent stays absent");
    }

    /// An `ok:false` daemon reply (refused target, write failure, or the
    /// "user did not respond in time" timeout) must become an error tool
    /// result carrying the daemon's own `error` text, never a false success.
    #[test]
    fn request_secret_ok_false_becomes_an_error_tool_result() {
        let id = json!(1);
        let resp = request_secret_result(&id, Ok(json!({"ok": false, "error": "target escapes cwd"})));
        assert_eq!(resp["result"]["isError"], json!(true));
        assert_eq!(resp["result"]["content"][0]["text"], json!("target escapes cwd"));
    }

    /// An `ok:true` reply's `text` field ("saved N characters...") passes
    /// through as the tool result text - this is the ONLY thing the model
    /// ever learns about the written value.
    #[test]
    fn request_secret_ok_true_passes_through_the_text_field() {
        let id = json!(1);
        let resp = request_secret_result(
            &id,
            Ok(json!({"ok": true, "text": "saved 6 characters to secrets.env (API_KEY)"})),
        );
        assert_eq!(resp["result"]["isError"], json!(false));
        assert_eq!(
            resp["result"]["content"][0]["text"],
            json!("saved 6 characters to secrets.env (API_KEY)")
        );
    }

    /// A transport-level failure (daemon unreachable) must not panic on a
    /// missing `ok` field - it degrades to an error result.
    #[test]
    fn request_secret_transport_error_becomes_an_error_tool_result() {
        let id = json!(1);
        let resp = request_secret_result(&id, Err("connection refused".to_string()));
        assert_eq!(resp["result"]["isError"], json!(true));
        assert!(resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("connection refused"));
    }

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
