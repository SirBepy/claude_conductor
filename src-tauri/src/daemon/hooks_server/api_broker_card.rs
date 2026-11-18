//! `/hooks/api-broker-card`: the `api_card` MCP tool. A chat asks Joe, on a card, to
//! import the tokens, add or replace one, or allow a call the policy denied. The MCP
//! child posts the model's arguments plus its own `session_id`; this route raises the
//! card in that chat's window (`broker::cards`) and answers at once. It never waits for
//! Joe: he answers on the card, and the chat retries.
//!
//! The route trusts the session id the MCP child sends the way the rest of the hooks
//! do. What a chat can get out of it is a card Joe can decline: the rows on the card
//! are built by the daemon, and only `respond_broker_card` on the desktop pipe applies
//! them (`broker::cards`).

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::broker::card_ops::{CardEnv, PolicyProposal};
use crate::daemon::broker::cards::{self, Raised};
use crate::daemon::broker::services::Service;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

fn reply(r: Result<Raised, String>) -> (StatusCode, Json<Value>) {
    let body = match r {
        Ok(r) => json!({ "ok": true, "text": r.summary, "already_open": r.already_open }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    (StatusCode::OK, Json(body))
}

fn str_arg<'a>(args: &'a Value, field: &str) -> Option<&'a str> {
    args[field].as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// What a card needs from the chat's arguments, checked for shape only.
async fn raise(ctx: &Arc<HookCtx>, env: Arc<CardEnv>, session: &str, args: &Value) -> Result<Raised, String> {
    match str_arg(args, "kind") {
        Some("import") => cards::raise_import(&ctx.state, env, session).await,
        Some("replace") => {
            let name = str_arg(args, "name").ok_or("name is missing: the token to add or replace, such as FIGMA_TOKEN")?;
            cards::raise_replace(&ctx.state, env, session, name).await
        }
        Some("policy") => {
            let service = str_arg(args, "service")
                .and_then(Service::parse)
                .ok_or("service is missing or unknown: name one of shortcut, linear, trello, figma, clockify, hubstaff")?;
            let method = str_arg(args, "method").unwrap_or(if service == Service::Linear { "POST" } else { "" });
            let path = str_arg(args, "path").unwrap_or(if service == Service::Linear { "/graphql" } else { "" });
            if method.is_empty() || path.is_empty() {
                return Err("method and path are missing: pass the denied call's".into());
            }
            // A name that is not a service is an error, not a silently narrower row.
            let bad = || "carry_from must be a list of service names such as [\"figma\", \"trello\"]".to_string();
            let carry_from = match &args["carry_from"] {
                Value::Null => Vec::new(),
                Value::Array(a) => a.iter().map(|n| n.as_str().and_then(Service::parse).ok_or_else(bad)).collect::<Result<Vec<_>, _>>()?,
                _ => return Err(bad()),
            };
            let proposal = PolicyProposal { service, method: method.to_string(), path: path.to_string(), op: str_arg(args, "op").map(str::to_string), carry_from };
            cards::raise_policy(&ctx.state, env, session, proposal).await
        }
        _ => Err("kind must be import, replace or policy".into()),
    }
}

pub(super) async fn on_api_broker_card(AxState(ctx): AxState<Arc<HookCtx>>, ValidatedJson(args): ValidatedJson<Value>) -> impl IntoResponse {
    let Some(session_id) = str_arg(&args, "session_id") else {
        return reply(Err("session_id is missing: the broker tools run from a chat".into()));
    };
    super::mark_mcp_tool_used(&ctx, session_id);
    let dir = match crate::settings::paths::data_dir() {
        Ok(d) => d,
        Err(e) => return reply(Err(format!("the broker cannot find its data folder: {e}"))),
    };
    reply(raise(&ctx, Arc::new(CardEnv::system(&dir)), session_id, &args).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.registry.upsert_interactive("chat-a", std::path::Path::new("."), "proj", "2026-11-18T00:00:00Z");
        Arc::new(HookCtx { state })
    }

    async fn call(c: &Arc<HookCtx>, v: Value) -> Value {
        let resp = on_api_broker_card(AxState(c.clone()), ValidatedJson(v)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The route only ever raises a card; it has no way to apply one, and a bad ask names
    /// what to fix. The import kind is left to `broker::cards`' tests: this route builds its
    /// environment from the machine's own `.env`, which a test must not read.
    #[tokio::test]
    async fn the_route_raises_a_card_for_a_chat_and_never_applies_one() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        assert!(call(&c, json!({"kind": "policy"})).await["error"].as_str().unwrap().starts_with("session_id is missing"));
        let r = call(&c, json!({"session_id": "chat-a", "kind": "remove"})).await;
        assert!(r["error"].as_str().unwrap().contains("import, replace or policy"), "{r}");
        let r = call(&c, json!({"session_id": "chat-a", "kind": "replace"})).await;
        assert!(r["error"].as_str().unwrap().starts_with("name is missing"), "{r}");
        let r = call(&c, json!({"session_id": "chat-a", "kind": "policy", "service": "nope", "method": "POST", "path": "/x"})).await;
        assert!(r["error"].as_str().unwrap().contains("service is missing or unknown"), "{r}");
        let r = call(&c, json!({"session_id": "chat-a", "kind": "policy", "service": "shortcut"})).await;
        assert!(r["error"].as_str().unwrap().contains("method and path are missing"), "{r}");
        assert!(c.state.list_prompts().await.is_empty(), "a refused ask raises nothing");

        let ask = json!({"session_id": "chat-a", "kind": "policy", "service": "shortcut", "method": "POST", "path": "/api/v3/epics"});
        let r = call(&c, ask.clone()).await;
        assert_eq!((r["ok"].clone(), r["already_open"].clone()), (json!(true), json!(false)), "{r}");
        let prompts = c.state.list_prompts().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0]["payload"]["card_kind"], "broker_policy");
        // The same ask while the card is open is the same card.
        let again = call(&c, ask).await;
        assert_eq!(again["already_open"], json!(true), "{again}");
        assert_eq!(c.state.list_prompts().await.len(), 1);
        let policy = crate::settings::paths::data_dir().unwrap().join(crate::daemon::broker::policy_file::POLICY_FILE);
        assert!(!policy.exists(), "asking for a card writes no policy row");
    }

    #[tokio::test]
    async fn a_carry_from_that_is_not_a_list_of_services_is_refused_not_dropped() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        let base = json!({"session_id": "chat-a", "kind": "policy", "service": "shortcut", "method": "POST", "path": "/api/v3/epics"});
        for bad in [json!("figma"), json!(["figma", "nope"]), json!([7]), json!({"a": 1})] {
            let mut ask = base.clone();
            ask["carry_from"] = bad.clone();
            let r = call(&c, ask).await;
            assert!(r["error"].as_str().unwrap_or_default().contains("carry_from must be a list"), "{bad}: {r}");
        }
        assert!(c.state.list_prompts().await.is_empty(), "a refused ask raises nothing");
        let mut ok = base;
        ok["carry_from"] = json!(["figma"]);
        let r = call(&c, ok).await;
        assert_eq!(r["ok"], json!(true), "{r}");
        let prompts = c.state.list_prompts().await;
        assert!(prompts[0]["payload"]["extra"].to_string().contains("carry_from") || prompts[0].to_string().contains("carry_from"), "the card's row line names carry_from: {prompts:?}");
    }
}
