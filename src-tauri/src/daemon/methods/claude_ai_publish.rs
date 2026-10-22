//! `publish_to_claude_ai`: uploads a preview as a private claude.ai Artifact
//! and records the link on it, so publishing it again updates the same page.
//! The upload itself is `crate::claude_ai_publish`; this file picks the
//! content and the account and stores the link.
//!
//! Desktop pipe only (no `remote_transport_table` row): it spends a model
//! turn and uploads content, a write the phone path has not been reviewed for.

use crate::claude_ai_publish::{publish, PublishedLink};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(serde::Deserialize)]
struct Params {
    id: String,
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

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

async fn publish_preview(state: &Arc<DaemonState>, id: &str) -> Result<Value, String> {
    let default_account = state.settings.snapshot().default_account_id;
    let snap = crate::daemon::preview::get(id).ok_or_else(|| format!("no such preview: {id}"))?;
    let account = snap
        .session_id
        .as_deref()
        .and_then(|sid| state.registry.get(sid))
        .and_then(|i| i.account_id);
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
    let stored = crate::daemon::preview::set_published_and_notify(state, id, link.clone()).is_some();
    if !stored {
        log::warn!("claude.ai link for preview {id} not stored: the preview was removed during the publish");
    }
    Ok(outcome(link, stored))
}

/// `stored: false` means the preview vanished mid-run (history cap), so the
/// link exists on claude.ai but nothing here remembers it.
fn outcome(link: PublishedLink, stored: bool) -> Value {
    json!({ "published": link, "stored": stored })
}

/// Returned when a publish of the same preview is already running. Distinct
/// from a failure so a client can tell "wait" from "retry".
pub const ERR_ALREADY_PUBLISHING: i32 = -32014;

/// Preview ids with a publish running. The frontend guard only covers one JS
/// realm; the phone and desktop, or two windows, would otherwise each mint an
/// artifact for the same preview.
static IN_FLIGHT: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

struct InFlightGuard(String);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).retain(|id| id != &self.0);
    }
}

fn begin(id: &str) -> Option<InFlightGuard> {
    let mut ids = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if ids.iter().any(|i| i == id) {
        return None;
    }
    ids.push(id.to_string());
    Some(InFlightGuard(id.to_string()))
}

/// Runs `publish` unless one is already running for `id`; the guard is held
/// across the await and released on completion, error or cancellation.
async fn publish_once<F, Fut>(id: &str, publish: F) -> Result<Value, RpcError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let Some(_guard) = begin(id) else {
        return Err(RpcError {
            code: ERR_ALREADY_PUBLISHING,
            message: "this preview is already being published".into(),
            data: None,
        });
    };
    publish().await.map_err(RpcError::internal)
}

pub fn register_claude_ai_publish(router: &mut Router, state: Arc<DaemonState>) {
    router.register("publish_to_claude_ai", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: Params = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            publish_once(&p.id, || publish_preview(&state, &p.id)).await
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
    fn the_result_says_whether_the_link_was_stored() {
        let link = PublishedLink { url: "https://claude.ai/artifact/AB".into(), version: 1, account: "Joe".into(), published_at: "now".into() };
        assert_eq!(outcome(link.clone(), false)["stored"], false);
        assert_eq!(outcome(link, true)["stored"], true);
    }

    #[tokio::test]
    async fn two_concurrent_publishes_of_one_preview_spawn_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let spawns = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(tokio::sync::Notify::new());
        let run = |spawns: Arc<AtomicUsize>, gate: Arc<tokio::sync::Notify>| async move {
            spawns.fetch_add(1, Ordering::SeqCst);
            gate.notified().await;
            Ok(json!({}))
        };
        let first = tokio::spawn({
            let fut = run(spawns.clone(), gate.clone());
            async move { publish_once("dup-preview", || fut).await }
        });
        while spawns.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let second = publish_once("dup-preview", || run(spawns.clone(), gate.clone())).await;
        assert_eq!(second.expect_err("second publish is refused").code, ERR_ALREADY_PUBLISHING);
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "only one publish may spawn");

        gate.notify_one();
        first.await.unwrap().expect("first publish completes");
        // The slot is free again once the first finished.
        assert!(begin("dup-preview").is_some());
    }

    #[test]
    fn a_full_document_is_published_untouched() {
        let doc = "<!DOCTYPE html><HTML><body>x</body></HTML>";
        assert_eq!(standalone_page(doc, "t"), doc);
    }
}
