//! `/secrets/capture`: HTTP half of the `capture_secret_from_page` MCP tool. A chat
//! driving a console page in Joe's browser says "save the element X into file F as
//! key K", and the value travels page -> daemon -> file without entering the model
//! context or the transcript (docs/architecture/claude-browser.md).
//!
//! Three rules keep a hostile page or a confused model from turning this into an
//! exfiltration path:
//! - nothing is read until Joe allows an approval card that names the label, the
//!   file, the key and the element, never a value (the card is also exempt from the
//!   front end's auto-allow: `needsHumanApproval` in `permission-modal/gating.ts`);
//! - the target obeys the masked card's rules, because both write through
//!   `methods::secret::write_secret` (inside the chat's folder, gitignored, no
//!   symlink tricks, the temporary-key rules);
//! - the value stays a local of [`capture`]: it is never logged, never in a tool
//!   result (only its length is), and never in an error text. A page-wide selector
//!   such as `body` is refused by the length cap, so it cannot grab a whole page.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::state::DaemonState;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::daemon::secret_target::CAPTURE_TOOL;

/// A credential is a short token; anything longer is a page, not a secret.
const MAX_VALUE_CHARS: usize = 4096;

#[derive(Deserialize)]
pub(super) struct CaptureBody {
    id: String,
    session_id: String,
    /// What Joe is shown the secret as ("OVH client secret").
    label: String,
    file: String,
    key: String,
    /// A snapshot ref or a unique selector, as Playwright's `target`.
    target: String,
    #[serde(default)]
    temporary: bool,
}

/// Reads the text of one element of the chat's page. The real one asks the chat's
/// own Playwright session; a test hands back a fixed string.
#[axum::async_trait]
pub(super) trait ElementReader: Send + Sync {
    /// `Err` is a short reason that must not contain any page text.
    async fn read(&self, session_id: &str, target: &str, label: &str) -> Result<String, String>;
}

pub(super) struct PageReader(pub Arc<DaemonState>);

#[axum::async_trait]
impl ElementReader for PageReader {
    async fn read(&self, session_id: &str, target: &str, label: &str) -> Result<String, String> {
        let settings = self.0.settings.snapshot();
        if !settings.claude_browser_enabled() {
            return Err(super::browser::DISABLED.to_string());
        }
        let args = json!({
            "element": label,
            "target": target,
            "function": "(element) => element.value ?? element.innerText ?? element.textContent ?? ''",
        });
        let result = crate::daemon::browser::get().call(session_id, "browser_evaluate", args, &settings).await?;
        result_string(&result)
    }
}

/// The string a `browser_evaluate` call returned. Playwright MCP answers with
/// `### Result` followed by the JSON of the returned value, then a `### Ran Playwright
/// code` section naming the code and target (never the value). UNVERIFIED against a
/// live page: the shape is the pinned version's documented one, so a mismatch
/// surfaces as the generic refusal below rather than as a wrong value.
pub(super) fn result_string(result: &Value) -> Result<String, String> {
    const UNREADABLE: &str = "the page did not return the element's text";
    if result["isError"].as_bool() == Some(true) {
        return Err(UNREADABLE.to_string());
    }
    let text = result["content"]
        .as_array()
        .and_then(|parts| parts.iter().find_map(|p| p["text"].as_str()))
        .ok_or(UNREADABLE)?;
    let after = text.split_once("### Result\n").map(|(_, rest)| rest).unwrap_or(text);
    let json_part = after.split("\n\n### ").next().unwrap_or(after).trim();
    serde_json::from_str::<String>(json_part).map_err(|_| UNREADABLE.to_string())
}

fn failure(reason: impl Into<String>) -> Value {
    json!({"ok": false, "error": reason.into()})
}

/// Runs one capture and returns the tool result: `{ok, text}` with only a length,
/// or `{ok: false, error}`.
pub(super) async fn capture(state: &Arc<DaemonState>, reader: &dyn ElementReader, body: CaptureBody) -> Value {
    // Refuse before any card: a target that fails the check never reaches Joe.
    let resolved = match crate::daemon::secret_target::validate(state, Some(&body.session_id), &body.file, &body.key).await {
        Ok(path) => path,
        Err(reason) => return failure(reason),
    };
    if body.temporary {
        if let Some(reason) = crate::daemon::secret_target::temporary_conflict(&resolved, &body.key) {
            return failure(reason);
        }
    }
    if body.target.trim().is_empty() {
        return failure("target is required: a snapshot ref or a unique selector");
    }

    let input = json!({
        "label": body.label,
        "file": resolved.to_string_lossy(),
        "key": body.key,
        "element": body.target,
        "temporary": body.temporary,
    });
    let decision = super::permission::ask_human(state, &body.id, CAPTURE_TOOL, input, Some(&body.session_id)).await;
    if decision["behavior"] != "allow" {
        return failure(
            decision["message"].as_str().map(|m| format!("not saved: {m}")).unwrap_or_else(|| "not saved: Joe declined".to_string()),
        );
    }

    let value = match reader.read(&body.session_id, &body.target, &body.label).await {
        Ok(v) => v.trim().to_string(),
        Err(reason) => return failure(reason),
    };
    if value.is_empty() {
        return failure("the element has no text to save");
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return failure(format!("the element holds more than {MAX_VALUE_CHARS} characters, which is a page and not a secret; point at the one element that shows it"));
    }
    // The resolved absolute path, not `body.file`: a relative file means this chat's
    // folder, and `write_secret` resolves a relative path against the daemon's own
    // working directory.
    let target = resolved.to_string_lossy();
    match crate::daemon::methods::secret::write_secret(state, Some(&body.session_id), &target, &body.key, body.temporary, &value).await {
        Ok(n) => json!({"ok": true, "text": format!("saved {n} characters to {target} ({})", body.key)}),
        Err(reason) => failure(reason),
    }
}

pub(super) async fn on_secret_capture(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<CaptureBody>,
) -> impl IntoResponse {
    if !body.session_id.is_empty() {
        super::mark_mcp_tool_used(&ctx, &body.session_id);
    }
    let reader = PageReader(ctx.state.clone());
    (StatusCode::OK, Json(capture(&ctx.state, &reader, body).await))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::path::Path;

    const SECRET: &str = "ovh-secret-VALUE-1234567890";

    struct Page(Result<String, String>);

    #[axum::async_trait]
    impl ElementReader for Page {
        async fn read(&self, _s: &str, _t: &str, _l: &str) -> Result<String, String> {
            self.0.clone()
        }
    }

    fn state_with_session(sid: &str, cwd: &Path) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session(sid, cwd, &settings, "2026-11-15T00:00:00Z");
        state
    }

    fn body(file: &str) -> CaptureBody {
        CaptureBody {
            id: "cap-1".into(),
            session_id: "s1".into(),
            label: "OVH client secret".into(),
            file: file.into(),
            key: "OVH_SECRET".into(),
            target: "#client-secret".into(),
            temporary: false,
        }
    }

    async fn first_pending_id(state: &Arc<DaemonState>) -> String {
        for _ in 0..200 {
            if let Some(id) = state.pending.lock().await.keys().next().cloned() {
                return id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("no approval card was raised");
    }

    async fn answer(state: &Arc<DaemonState>, behavior: &str) {
        let id = first_pending_id(state).await;
        let tx = state.pending.lock().await.remove(&id).unwrap();
        tx.send(json!({"behavior": behavior, "message": "no thanks"})).unwrap();
    }

    /// The whole property in one run: one allowed card, the value lands in the file, and
    /// it appears in no tool result and in no card payload.
    #[tokio::test]
    async fn an_allowed_capture_writes_the_value_and_reports_only_its_length() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        let mut rx = state.notifier.subscribe();

        let (st, b) = (state.clone(), body(&target.to_string_lossy()));
        let call = tokio::spawn(async move { capture(&st, &Page(Ok(format!(" {SECRET}\n"))), b).await });

        let id = first_pending_id(&state).await;
        let prompts = state.list_prompts().await;
        let card = prompts.iter().find(|p| p["id"] == id.as_str()).expect("card is listed");
        assert_eq!(card["payload"]["tool_name"], CAPTURE_TOOL);
        assert_eq!(card["payload"]["input"]["label"], "OVH client secret");
        assert_eq!(card["payload"]["input"]["key"], "OVH_SECRET");
        assert!(!target.exists(), "nothing is written while the card is open");
        answer(&state, "allow").await;

        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), format!("OVH_SECRET={SECRET}\n"));
        assert!(v["text"].as_str().unwrap().starts_with(&format!("saved {} characters to ", SECRET.chars().count())), "{v}");
        assert!(!v.to_string().contains(SECRET), "the tool result never carries the value");
        while let Ok(frame) = rx.try_recv() {
            assert!(!frame.to_string().contains(SECRET), "no published frame carries the value: {frame}");
        }
        assert!(!state.list_prompts().await.iter().any(|p| p.to_string().contains(SECRET)));
    }

    /// A relative `file` means the chat's folder: the value lands there and not in the
    /// daemon's own working directory (which no target check covered).
    #[tokio::test]
    async fn a_relative_file_is_written_inside_the_chat_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_session("s1", tmp.path());
        let (st, b) = (state.clone(), body("rel-capture-test.env"));
        let call = tokio::spawn(async move { capture(&st, &Page(Ok(SECRET.into())), b).await });
        answer(&state, "allow").await;
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(true), "{v}");
        let inside = tmp.path().join("rel-capture-test.env");
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), format!("OVH_SECRET={SECRET}\n"));
        let stray = std::env::current_dir().unwrap().join("rel-capture-test.env");
        assert!(!stray.exists(), "nothing is written beside the daemon's working directory");
    }

    #[tokio::test]
    async fn a_declined_card_reads_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        let (st, b) = (state.clone(), body(&target.to_string_lossy()));
        let call = tokio::spawn(async move { capture(&st, &Page(Ok(SECRET.into())), b).await });
        answer(&state, "deny").await;
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().starts_with("not saved"), "{v}");
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn a_target_outside_the_chat_folder_is_refused_before_any_card() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("chat");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("s1", &cwd);
        let v = capture(&state, &Page(Ok(SECRET.into())), body("../outside.env")).await;
        assert_eq!(v["ok"], json!(false));
        assert!(state.pending.lock().await.is_empty(), "no card for a refused target");
        assert!(!tmp.path().join("outside.env").exists());
    }

    #[tokio::test]
    async fn a_blank_target_is_refused_before_any_card() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_session("s1", tmp.path());
        let mut b = body(&tmp.path().join("ovh.env").to_string_lossy());
        b.target = "  ".into();
        let v = capture(&state, &Page(Ok(SECRET.into())), b).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("target is required"), "{v}");
        assert!(state.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_page_sized_element_is_refused_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        let (st, b) = (state.clone(), body(&target.to_string_lossy()));
        let call = tokio::spawn(async move { capture(&st, &Page(Ok("x".repeat(MAX_VALUE_CHARS + 1))), b).await });
        answer(&state, "allow").await;
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("a page and not a secret"), "{v}");
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn an_empty_element_and_a_failed_read_save_nothing_and_leak_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        for page in [Page(Ok("  \n".into())), Page(Err("the page did not return the element's text".into()))] {
            let (st, b) = (state.clone(), body(&target.to_string_lossy()));
            let call = tokio::spawn(async move { capture(&st, &page, b).await });
            answer(&state, "allow").await;
            assert_eq!(call.await.unwrap()["ok"], json!(false));
        }
        assert!(!target.exists());
    }

    #[test]
    fn the_playwright_result_text_yields_the_returned_string() {
        let ok = json!({"content": [{"type": "text", "text": "### Result\n\"abc 123\"\n\n### Ran Playwright code\n```js\nawait page.locator('#x').evaluate(...)\n```"}]});
        assert_eq!(result_string(&ok).unwrap(), "abc 123");
        let escaped = json!({"content": [{"type": "text", "text": "### Result\n\"a\\\"b\"\n"}]});
        assert_eq!(result_string(&escaped).unwrap(), "a\"b");
        for bad in [
            json!({"isError": true, "content": [{"type": "text", "text": "### Result\n\"abc\""}]}),
            json!({"content": []}),
            json!({"content": [{"type": "text", "text": "### Result\n42\n"}]}),
            json!({"content": [{"type": "text", "text": "### Error\nElement not found"}]}),
        ] {
            assert_eq!(result_string(&bad).unwrap_err(), "the page did not return the element's text", "{bad}");
        }
    }
}
