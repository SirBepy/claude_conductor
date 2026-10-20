//! `publish_to_claude_ai`: uploads a preview or a draft as a
//! private claude.ai Artifact and records the link on it, so publishing it
//! again updates the same page. The upload itself is
//! `crate::claude_ai_publish`; this file picks the content, the account and
//! where the link is stored.
//!
//! Desktop pipe only (no `remote_transport_table` row): it spends a model
//! turn and uploads content, a write the phone path has not been reviewed for.

use super::drafts_store::{find_draft, set_draft_published};
use crate::claude_ai_publish::{publish, PublishedLink};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(serde::Deserialize)]
#[serde(tag = "target", rename_all = "lowercase")]
enum Params {
    Preview {
        id: String,
    },
    /// `html` is rendered by the app from the variant's current markdown;
    /// `version` is the app's hash of that markdown (see
    /// `PublishedLink::version`), recorded so the panel can tell when a later
    /// edit or revise has left the link behind.
    Draft {
        session_id: String,
        id: String,
        #[serde(default)]
        recipient: String,
        title: String,
        html: String,
        version: u32,
    },
}

/// A pushed preview may be a bare fragment. The panel wraps one in the same
/// dark boilerplate (`wrapFragmentIfNeeded` in `preview-panel-document.ts`),
/// so the published page has to as well or it would not look like the panel.
fn standalone_page(html: &str, title: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if lower.contains("<html") || lower.contains("<body") {
        return html.to_string();
    }
    let title = title.replace('&', "&amp;").replace('<', "&lt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" \
content=\"width=device-width,initial-scale=1\"><title>{title}</title>\
<style>body{{background:#15151e;color:#e0e0e0}}</style></head><body>{html}</body></html>"
    )
}

fn account_of(state: &Arc<DaemonState>, session_id: Option<&str>) -> Option<String> {
    session_id.and_then(|sid| state.registry.get(sid)).and_then(|i| i.account_id)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

async fn publish_target(state: &Arc<DaemonState>, params: Params) -> Result<Value, String> {
    let default_account = state.settings.snapshot().default_account_id;
    match params {
        Params::Preview { id } => {
            let snap = crate::daemon::preview::get(&id).ok_or_else(|| format!("no such preview: {id}"))?;
            let account = account_of(state, snap.session_id.as_deref());
            let out = publish(
                &standalone_page(&snap.html, &snap.title),
                &snap.title,
                snap.published.as_ref().map(|p| p.url.as_str()),
                account.as_deref(),
                default_account.as_deref(),
            )
            .await
            .map_err(|e| format!("{e:#}"))?;
            let link = PublishedLink { url: out.url, version: snap.version, account: out.account, published_at: now() };
            crate::daemon::preview::set_published_and_notify(state, &id, link.clone());
            Ok(json!({ "published": link }))
        }
        Params::Draft { session_id, id, recipient, title, html, version } => {
            let (project_id, draft) = find_draft(state, &session_id, &id)?;
            let variant = draft
                .variants
                .iter()
                .find(|v| recipient.trim().is_empty() || v.recipient.eq_ignore_ascii_case(recipient.trim()))
                .ok_or_else(|| format!("no variant for recipient: {recipient}"))?;
            let account = account_of(state, Some(&draft.origin_session_id));
            let out = publish(
                &html,
                &title,
                variant.published.as_ref().map(|p| p.url.as_str()),
                account.as_deref(),
                default_account.as_deref(),
            )
            .await
            .map_err(|e| format!("{e:#}"))?;
            let link = PublishedLink { url: out.url, version, account: out.account, published_at: now() };
            set_draft_published(state, &project_id, &draft.id, &variant.recipient, link.clone())?;
            Ok(json!({ "published": link }))
        }
    }
}

pub fn register_claude_ai_publish(router: &mut Router, state: Arc<DaemonState>) {
    router.register("publish_to_claude_ai", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: Params = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            publish_target(&state, p).await.map_err(RpcError::internal)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fragment_gets_the_panels_dark_wrapper_and_a_title() {
        let page = standalone_page("<h1>Hi</h1>", "Q3 <draft>");
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("<title>Q3 &lt;draft></title>"));
        assert!(page.contains("background:#15151e"));
        assert!(page.contains("<body><h1>Hi</h1></body>"));
    }

    #[test]
    fn a_full_document_is_published_untouched() {
        let doc = "<!DOCTYPE html><HTML><body>x</body></HTML>";
        assert_eq!(standalone_page(doc, "t"), doc);
    }

    #[test]
    fn params_parse_both_targets() {
        let p: Params = serde_json::from_value(json!({"target": "preview", "id": "p1"})).unwrap();
        assert!(matches!(p, Params::Preview { id } if id == "p1"));
        let d: Params = serde_json::from_value(json!({
            "target": "draft", "session_id": "s", "id": "d", "title": "T", "html": "<p/>", "version": 3
        }))
        .unwrap();
        assert!(matches!(d, Params::Draft { version: 3, ref recipient, .. } if recipient.is_empty()));
    }
}
