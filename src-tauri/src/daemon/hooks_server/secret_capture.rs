//! `/secrets/capture`: HTTP half of the `capture_secret_from_page` MCP tool. A chat
//! driving a console page in Joe's browser says "save the element X into file F as
//! key K", and the value travels page -> daemon -> file without entering the model
//! context or the transcript (docs/architecture/claude-browser.md).
//!
//! Three rules keep a hostile page or a confused model from turning this into an
//! exfiltration path:
//! - the element's text is never returned to the daemon until Joe allows an approval
//!   card that names the label, the file, the key, the element, the page it sits on and
//!   its tag, id and length, never a value (the card is also exempt from the front end's
//!   auto-allow: `needsHumanApproval` in `permission-modal/gating.ts`). The page facts
//!   come from a metadata-only read made before the card (the page's own script sees the
//!   text to count it and hash it, and returns neither), and the read after the click
//!   must find the same element, text hash included, so a page that changed meanwhile (a
//!   snapshot ref now pointing elsewhere) saves nothing. That check catches drift, not a hostile page: the
//!   description is made by script in the page's own world, so a page that patches
//!   `JSON.stringify` can forge it. What a forging page can reach is bounded, because
//!   the text only ever lands in the gitignored file Joe approved, never in the model;
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

/// What Joe is shown about the element, read without its value. A hostile page words
/// these fields as it likes, so they are capped and stripped of control characters;
/// `page` is `origin + path` only, because a query or fragment is where a token sits.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct ElementInfo {
    pub page: String,
    pub tag: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub length: usize,
    /// A hash of the trimmed text made in the page, so two elements that look alike (two
    /// keys of the same length in one table) still differ. It is compared and never
    /// shown or sent anywhere: the card payload is built field by field.
    pub digest: String,
}

impl ElementInfo {
    /// Display form of one page-worded field: no control or invisible formatting
    /// characters (a bidi override could reorder what Joe reads), no `"` (it would let an
    /// id fake a second attribute on the card), capped. The raw fields stay as read, so
    /// the before/after comparison never treats two different strings as equal just
    /// because their display forms match.
    fn clean(raw: &str) -> String {
        Self::visible(raw).map(|c| if c == '"' { '\'' } else { c }).take(120).collect()
    }

    /// Only what Joe can see: `raw` without control and invisible formatting characters,
    /// uncapped (a file path must not be cut on the card).
    fn visible(raw: &str) -> impl Iterator<Item = char> + '_ {
        raw.chars().filter(|c| {
            !c.is_control()
                && !matches!(
                    *c,
                    '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}' | '\u{180E}' | '\u{200B}'..='\u{200F}'
                        | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{2800}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}'
                        | '\u{FFA0}' | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{E007F}'
                )
        })
    }

    /// The page as the card shows it: origin and path only, and a long opaque path
    /// segment (an invite or reset token) is elided, because the card is published to
    /// every client and stored with the prompt.
    fn page_text(&self) -> String {
        // Elide on the whole raw path first: truncating before it would leave the front
        // of a token that the cut fell inside.
        let Some((scheme, rest)) = self.page.split_once("://") else { return Self::clean(&self.page) };
        let rest = rest
            .split('/')
            .enumerate()
            .map(|(i, seg)| if i > 0 && seg.chars().count() >= 20 && seg.chars().any(|c| c.is_ascii_digit()) { "...".to_string() } else { seg.to_string() })
            .collect::<Vec<_>>()
            .join("/");
        Self::clean(&format!("{scheme}://{rest}"))
    }

    /// `<input id="x" name="y" type="password">`, the form the card shows.
    fn tag_text(&self) -> String {
        let mut out = format!("<{}", Self::clean(&self.tag));
        for (k, v) in [("id", &self.id), ("name", &self.name), ("type", &self.kind)] {
            if !v.is_empty() {
                out.push_str(&format!(" {k}=\"{}\"", Self::clean(v)));
            }
        }
        out.push('>');
        out
    }
}

/// Reads one element of the chat's page. The real one asks the chat's own Playwright
/// session; a test hands back fixed answers.
#[axum::async_trait]
pub(super) trait ElementReader: Send + Sync {
    /// The element's description without its value, asked before the card.
    /// `Err` is a short reason that must not contain any page text.
    async fn inspect(&self, session_id: &str, target: &str, label: &str) -> Result<ElementInfo, String>;
    /// The element's text plus its description at the moment of reading, so the caller
    /// can tell it is still the element Joe approved. Same `Err` rule.
    async fn read(&self, session_id: &str, target: &str, label: &str) -> Result<(String, ElementInfo), String>;
}

pub(super) struct PageReader(pub Arc<DaemonState>);

const UNREADABLE: &str = "the page did not return the element's text";

/// The `browser_evaluate` arguments for one read. Both reads build the description
/// from the same expression so the two can be compared field by field.
pub(super) fn evaluate_args(label: &str, target: &str, with_value: bool) -> Value {
    const TEXT: &str = "const v = String(element.value ?? element.innerText ?? element.textContent ?? '');";
    // `location.origin` is "null" on about:, data: and blob: pages, whose path is the whole
    // payload: show the scheme alone there. The digest is a 31-bit multiplicative hash, small enough that h * 33 stays exact in a double.
    const INFO: &str = "page: location.origin === 'null' ? location.protocol : location.origin + location.pathname, digest: (() => { let h = 5381; for (const ch of v.trim()) h = (h * 33 + ch.codePointAt(0)) % 2147483647; return String(h); })(), tag: element.tagName.toLowerCase(), id: element.id || '', name: element.getAttribute('name') || '', kind: element.getAttribute('type') || '', length: Array.from(v.trim()).length";
    let fields = if with_value { format!("value: v, {INFO}") } else { INFO.to_string() };
    json!({
        "element": label,
        "target": target,
        "function": format!("(element) => {{ {TEXT} return JSON.stringify({{ {fields} }}); }}"),
    })
}

/// The JSON a `with_value: false` read returned, as the description.
pub(super) fn parse_info(raw: &str) -> Result<ElementInfo, String> {
    serde_json::from_str::<ElementInfo>(raw).map_err(|_| UNREADABLE.to_string())
}

/// The JSON a `with_value: true` read returned, as the text and its description.
pub(super) fn parse_read(raw: &str) -> Result<(String, ElementInfo), String> {
    #[derive(Deserialize)]
    struct WithValue {
        value: String,
        #[serde(flatten)]
        info: ElementInfo,
    }
    let parsed = serde_json::from_str::<WithValue>(raw).map_err(|_| UNREADABLE.to_string())?;
    Ok((parsed.value, parsed.info))
}

impl PageReader {
    async fn run(&self, session_id: &str, target: &str, label: &str, with_value: bool) -> Result<String, String> {
        let settings = self.0.settings.snapshot();
        if !settings.claude_browser_enabled() {
            return Err(super::browser::DISABLED.to_string());
        }
        // Any failure here is reduced to one generic reason: the contract of the trait
        // is that an error never carries page text, and the browser's own error
        // strings are not ours to vouch for.
        let result = crate::daemon::browser::get()
            .call(session_id, "browser_evaluate", evaluate_args(label, target, with_value), &settings)
            .await
            .map_err(|_| "the browser could not read the element (is it on the open page, and is the browser connected?)".to_string())?;
        result_string(&result)
    }
}

#[axum::async_trait]
impl ElementReader for PageReader {
    async fn inspect(&self, session_id: &str, target: &str, label: &str) -> Result<ElementInfo, String> {
        parse_info(&self.run(session_id, target, label, false).await?)
    }

    async fn read(&self, session_id: &str, target: &str, label: &str) -> Result<(String, ElementInfo), String> {
        parse_read(&self.run(session_id, target, label, true).await?)
    }
}

/// The string a `browser_evaluate` call returned. Playwright MCP answers with
/// `### Result` followed by the JSON of the returned value, then a `### Ran Playwright
/// code` section naming the code and target (never the value). The ignored
/// `live_capture_reads_a_real_page_element` checks this shape against a real page; a
/// different shape surfaces as the generic refusal below, never as a wrong value.
pub(super) fn result_string(result: &Value) -> Result<String, String> {
    if result["isError"].as_bool() == Some(true) {
        return Err(UNREADABLE.to_string());
    }
    let text = result["content"]
        .as_array()
        .and_then(|parts| parts.iter().find_map(|p| p["text"].as_str()))
        .ok_or(UNREADABLE)?;
    let after = text.split_once("### Result\n").map(|(_, rest)| rest).unwrap_or(text);
    // A JSON string never holds a raw newline, so the first "\n### " ends the result.
    // The live run (2026-11-20) showed one newline before the next section, not two.
    let json_part = after.split("\n### ").next().unwrap_or(after).trim();
    serde_json::from_str::<String>(json_part).map_err(|_| UNREADABLE.to_string())
}

fn too_long() -> String {
    format!("the element holds more than {MAX_VALUE_CHARS} characters, which is a page and not a secret; point at the one element that shows it")
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

    // Describe the element before Joe is asked, so the card says what he is approving
    // and an empty or page-sized element never costs him a click.
    let seen = match reader.inspect(&body.session_id, &body.target, &body.label).await {
        Ok(info) => info,
        Err(reason) => return failure(reason),
    };
    if seen.length == 0 {
        return failure("the element has no text to save");
    }
    if seen.length > MAX_VALUE_CHARS {
        return failure(too_long());
    }

    let input = json!({
        // The model words the label, and it is the card's first row: no invisible or
        // direction-changing characters in it either.
        "label": ElementInfo::clean(&body.label),
        "file": ElementInfo::visible(&resolved.to_string_lossy()).collect::<String>(),
        "key": body.key,
        "element": ElementInfo::clean(&body.target),
        "page": seen.page_text(),
        "found": seen.tag_text(),
        "length": seen.length,
        "temporary": body.temporary,
    });
    let decision = super::permission::ask_human(state, &body.id, CAPTURE_TOOL, input, Some(&body.session_id)).await;
    if decision["behavior"] != "allow" {
        return failure(
            decision["message"].as_str().map(|m| format!("not saved: {m}")).unwrap_or_else(|| "not saved: Joe declined".to_string()),
        );
    }

    let value = match reader.read(&body.session_id, &body.target, &body.label).await {
        Ok((v, now)) if now == seen => v.trim().to_string(),
        // Compared after the click: a snapshot ref resolves only when read, so a page that
        // changed while the card was open could now hand back another element's text.
        Ok(_) => return failure("the element on the page changed after Joe was asked, so nothing was saved; look at the page again and retry"),
        Err(reason) => return failure(reason),
    };
    if value.is_empty() {
        return failure("the element has no text to save");
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return failure(too_long());
    }
    // The page trims with JavaScript's rules and this side with Rust's (they differ on
    // U+FEFF and U+0085), so the saved text must be the length the card showed.
    if value.chars().count() != seen.length {
        return failure("the text to save differs from what Joe was shown, so nothing was saved; look at the page again and retry");
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

    fn info(length: usize) -> ElementInfo {
        ElementInfo {
            page: "https://console.example.com/keys".into(),
            tag: "input".into(),
            id: "client-secret".into(),
            name: "secret".into(),
            kind: "password".into(),
            length,
            digest: "d0".into(),
        }
    }

    /// A page with one element. `inspect` answers `before`, `read` answers `value` with
    /// `after` as the element's description at that moment; `reads` counts the calls that
    /// return the text.
    struct Page {
        before: Result<ElementInfo, String>,
        value: Result<String, String>,
        after: ElementInfo,
        reads: std::sync::atomic::AtomicUsize,
    }

    impl Page {
        fn showing(value: &str) -> Self {
            let i = ElementInfo { digest: format!("d-{}", value.trim()), ..info(value.trim().chars().count()) };
            Page { before: Ok(i.clone()), value: Ok(value.to_string()), after: i, reads: Default::default() }
        }
    }

    #[axum::async_trait]
    impl ElementReader for Page {
        async fn inspect(&self, _s: &str, _t: &str, _l: &str) -> Result<ElementInfo, String> {
            self.before.clone()
        }
        async fn read(&self, _s: &str, _t: &str, _l: &str) -> Result<(String, ElementInfo), String> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.value.clone().map(|v| (v, self.after.clone()))
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
        let call = tokio::spawn(async move { capture(&st, &Page::showing(&format!(" {SECRET}\n")), b).await });

        let id = first_pending_id(&state).await;
        let prompts = state.list_prompts().await;
        let card = prompts.iter().find(|p| p["id"] == id.as_str()).expect("card is listed");
        assert_eq!(card["payload"]["tool_name"], CAPTURE_TOOL);
        // The digest of the page text is the fixture's `d-<SECRET>`: it must not ride on the card either.
        assert!(!card.to_string().contains(SECRET), "the open card carries neither the value nor its digest: {card}");
        assert_eq!(card["payload"]["input"]["label"], "OVH client secret");
        assert_eq!(card["payload"]["input"]["key"], "OVH_SECRET");
        // What Joe is told about the element, so he can tell it from a look-alike.
        assert_eq!(card["payload"]["input"]["page"], "https://console.example.com/keys");
        assert_eq!(card["payload"]["input"]["found"], "<input id=\"client-secret\" name=\"secret\" type=\"password\">");
        assert_eq!(card["payload"]["input"]["length"], json!(SECRET.chars().count()));
        assert!(!target.exists(), "nothing is written while the card is open");
        answer(&state, "allow").await;

        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), format!("OVH_SECRET={SECRET}\n"));
        assert!(v["text"].as_str().unwrap().starts_with(&format!("saved {} characters to ", SECRET.chars().count())), "{v}");
        assert!(!v.to_string().contains(SECRET), "the tool result never carries the value");
        let mut frames = 0;
        while let Ok(frame) = rx.try_recv() {
            frames += 1;
            assert!(!frame.to_string().contains(SECRET), "no published frame carries the value: {frame}");
        }
        assert!(frames > 0, "the card was published, so the scan above saw it");
    }

    /// A relative `file` means the chat's folder: the value lands there and not in the
    /// daemon's own working directory (which no target check covered).
    #[tokio::test]
    async fn a_relative_file_is_written_inside_the_chat_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_session("s1", tmp.path());
        let (st, b) = (state.clone(), body("rel-capture-test.env"));
        let call = tokio::spawn(async move { capture(&st, &Page::showing(SECRET), b).await });
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
        let page = Arc::new(Page::showing(SECRET));
        let seen_by_call = page.clone();
        let call = tokio::spawn(async move { capture(&st, &*seen_by_call, b).await });
        answer(&state, "deny").await;
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().starts_with("not saved"), "{v}");
        assert!(!target.exists());
        assert_eq!(page.reads.load(std::sync::atomic::Ordering::SeqCst), 0, "the text is never read without an allow");
    }

    #[tokio::test]
    async fn a_target_outside_the_chat_folder_is_refused_before_any_card() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("chat");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = state_with_session("s1", &cwd);
        let v = capture(&state, &Page::showing(SECRET), body("../outside.env")).await;
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
        let v = capture(&state, &Page::showing(SECRET), b).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("target is required"), "{v}");
        assert!(state.pending.lock().await.is_empty());
    }

    /// A page-wide selector, an empty element and an unreadable one are all answered from
    /// the metadata read, so Joe is never asked to approve a save that cannot happen.
    #[tokio::test]
    async fn a_page_sized_empty_or_unreadable_element_is_refused_before_any_card() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        let big = "x".repeat(MAX_VALUE_CHARS + 1);
        let unreadable = Page { before: Err("the page did not return the element's text".into()), ..Page::showing(SECRET) };
        for (page, needle) in [
            (Page::showing(&big), "a page and not a secret"),
            (Page::showing("  \n"), "no text to save"),
            (unreadable, "did not return"),
        ] {
            let v = capture(&state, &page, body(&target.to_string_lossy())).await;
            assert_eq!(v["ok"], json!(false), "{v}");
            assert!(v["error"].as_str().unwrap().contains(needle), "{v}");
            assert!(state.pending.lock().await.is_empty(), "no card was raised");
        }
        assert!(!target.exists());
    }

    /// The element can differ between the description Joe approved and the moment of
    /// the read (a snapshot ref resolves late): that saves nothing and says nothing of
    /// the text.
    #[tokio::test]
    async fn an_element_that_changed_after_the_card_saves_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        // Each variant differs from the approved description in exactly one field.
        let approved = Page::showing(SECRET).after;
        let other = ElementInfo { id: "session-token".into(), ..approved.clone() };
        let longer = ElementInfo { length: approved.length + 1, ..approved.clone() };
        // Reads the card would draw identically (a zero-width character) are still
        // different strings, so still a changed element.
        let look_alike = ElementInfo { id: "client\u{200B}-secret".into(), ..approved.clone() };
        assert_eq!(look_alike.tag_text(), approved.tag_text());
        // Two keys of one length in one table, no id, name or type: only the text hash
        // tells the re-resolved element from the one Joe approved.
        let same_shape_other_text = ElementInfo { digest: "d-another-key".into(), ..approved.clone() };
        for after in [other, longer, look_alike, same_shape_other_text] {
            let page = Page { after, ..Page::showing(SECRET) };
            let (st, b) = (state.clone(), body(&target.to_string_lossy()));
            let call = tokio::spawn(async move { capture(&st, &page, b).await });
            answer(&state, "allow").await;
            let v = call.await.unwrap();
            assert_eq!(v["ok"], json!(false), "{v}");
            assert!(v["error"].as_str().unwrap().contains("changed after Joe was asked"), "{v}");
            assert!(!v.to_string().contains(SECRET));
        }
        assert!(!target.exists());
    }

    /// The label, the file and the element are worded by the model, so the card draws them
    /// without invisible or direction-changing characters.
    #[tokio::test]
    async fn the_card_cleans_the_model_worded_label_file_and_element() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_with_session("s1", tmp.path());
        let mut b = body(&tmp.path().join("ov\u{202E}h.env").to_string_lossy());
        b.label = "OVH \u{202E}terces\u{200B} \"key\"".into();
        b.target = "#a\u{2800}b".into();
        let (st, page) = (state.clone(), Page::showing(SECRET));
        let call = tokio::spawn(async move { capture(&st, &page, b).await });
        let id = first_pending_id(&state).await;
        let prompts = state.list_prompts().await;
        let input = &prompts.iter().find(|p| p["id"] == id.as_str()).expect("card is listed")["payload"]["input"];
        assert_eq!(input["label"], "OVH terces 'key'");
        assert_eq!(input["element"], "#ab");
        assert!(input["file"].as_str().unwrap().ends_with("ovh.env"), "{input}");
        assert!(!input.to_string().contains('\u{202E}'), "{input}");
        answer(&state, "deny").await;
        call.await.unwrap();
    }

    /// JavaScript's `trim` strips U+FEFF and Rust's does not: the saved text must still be
    /// exactly as long as the card said, or nothing is saved.
    #[tokio::test]
    async fn a_text_whose_length_differs_from_the_card_saves_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        let page = Page { value: Ok(format!("\u{FEFF}{SECRET}")), ..Page::showing(SECRET) };
        let (st, b) = (state.clone(), body(&target.to_string_lossy()));
        let call = tokio::spawn(async move { capture(&st, &page, b).await });
        answer(&state, "allow").await;
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(false), "{v}");
        assert!(v["error"].as_str().unwrap().contains("differs from what Joe was shown"), "{v}");
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn a_failed_read_after_the_card_saves_nothing_and_leaks_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("ovh.env");
        let state = state_with_session("s1", tmp.path());
        let page = Page { value: Err("the page did not return the element's text".into()), ..Page::showing(SECRET) };
        let (st, b) = (state.clone(), body(&target.to_string_lossy()));
        let call = tokio::spawn(async move { capture(&st, &page, b).await });
        answer(&state, "allow").await;
        let v = call.await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(!v.to_string().contains(SECRET));
        assert!(!target.exists());
    }

    /// The real reader's two replies, end to end through Playwright's answer text: the
    /// description carries no value, the read carries it, and a page-controlled field
    /// cannot smuggle control characters or a long string onto the card.
    #[test]
    fn the_reader_parses_its_two_replies_and_cleans_page_text() {
        let wrap = |inner: &str| json!({"content": [{"type": "text", "text": format!("### Result\n{}\n### Ran Playwright code\n```js\nawait page.locator('#x').evaluate(...)\n```", serde_json::to_string(inner).unwrap())}]});
        let args = evaluate_args("OVH client secret", "#x", false);
        assert!(!args["function"].as_str().unwrap().contains("value: v"), "the description read never returns the text");
        assert!(evaluate_args("l", "#x", true)["function"].as_str().unwrap().contains("value: v"));

        let meta = r#"{"page":"https://c.example/k","tag":"input","id":"a\nb","name":"","kind":"password","length":27,"digest":"7"}"#;
        let got = parse_info(&result_string(&wrap(meta)).unwrap()).unwrap();
        assert_eq!(got.id, "a\nb", "the raw field is kept for the comparison");
        assert_eq!(got.tag_text(), "<input id=\"ab\" type=\"password\">", "the card form drops control characters");
        assert_eq!(got.length, 27);

        let with = r#"{"value":"s3cret \"q\"","page":"https://c.example/k","tag":"input","id":"a","name":"","kind":"","length":12,"digest":"7"}"#;
        let (value, read_info) = parse_read(&result_string(&wrap(with)).unwrap()).unwrap();
        assert_eq!(value, "s3cret \"q\"");
        assert_eq!(read_info.tag_text(), "<input id=\"a\">");

        // A value that itself looks like Playwright's section markers stays whole: it
        // rides inside a JSON string, whose newlines are escaped.
        let tricky = "line one\n### Result\n\"fake\"\n### Ran Playwright code";
        let with_tricky = serde_json::to_string(&json!({"value": tricky, "page": "p", "tag": "input", "id": "", "name": "", "kind": "", "length": 5, "digest": "7"})).unwrap();
        let (value, _) = parse_read(&result_string(&wrap(&with_tricky)).unwrap()).unwrap();
        assert_eq!(value, tricky);

        // Page-worded fields cannot fake an attribute, reorder the line or show a token.
        let forged = ElementInfo { id: "x\" type=\"text\u{202E}".into(), ..info(1) };
        assert_eq!(forged.tag_text(), "<input id=\"x' type='text\" name=\"secret\" type=\"password\">");
        let invite = ElementInfo { page: "https://c.example/invite/a1b2c3d4e5f6a7b8c9d0e1f2/accept".into(), ..info(1) };
        assert_eq!(invite.page_text(), "https://c.example/invite/.../accept");

        // A token that sits where the 120-character cap would cut is elided before the cut.
        // The token starts at character 105, so the 120-character cut would leave its first 15
        // characters, too short to count as a token if the cut came first.
        let deep = ElementInfo { page: format!("https://c.example/{}/{}", "a".repeat(86), "k9".repeat(15)), ..info(1) };
        assert!(!deep.page_text().contains("k9"), "{}", deep.page_text());
        // about:, data: and blob: pages have no origin: the page is its scheme alone.
        assert!(evaluate_args("l", "#x", false)["function"].as_str().unwrap().contains("location.origin === 'null' ? location.protocol"));
        // Invisible filler and line-breaking characters cannot pass for part of an id.
        let sneaky = ElementInfo { id: "a\u{2028}b\u{3164}c\u{E0041}d\u{061C}e".into(), ..info(1) };
        assert_eq!(sneaky.tag_text(), "<input id=\"abcde\" name=\"secret\" type=\"password\">");

        let long = format!(r#"{{"page":"{}","tag":"input","id":"","name":"","kind":"","length":1,"digest":"7"}}"#, "p".repeat(500));
        assert_eq!(parse_info(&long).unwrap().page_text().chars().count(), 120);
        assert_eq!(parse_info("{\"tag\":\"input\"}").unwrap_err(), UNREADABLE);
        assert_eq!(parse_read("not json").unwrap_err(), UNREADABLE);
    }

    /// Real Chrome and the pinned Playwright MCP, so it is `#[ignore]`d: run by hand with
    /// `cargo test --lib -- --ignored live_capture_reads_a_real_page_element`. Builds a
    /// page printing a dummy secret, then checks that `browser_evaluate`'s answer parses
    /// into the description and the text through the same functions the daemon uses.
    #[tokio::test]
    #[ignore]
    async fn live_capture_reads_a_real_page_element() {
        let dir = tempfile::tempdir().unwrap();
        let b = crate::daemon::browser::ClaudeBrowser::new(dir.path().to_path_buf());
        let settings = Settings::default();
        b.call("s1", "browser_navigate", json!({"url": "about:blank"}), &settings).await.unwrap();
        let page = format!("(() => {{ document.body.innerHTML = '<input id=\"client-secret\" name=\"secret\" type=\"password\" value=\"{SECRET}\">'; return 1; }})");
        b.call("s1", "browser_evaluate", json!({"function": page}), &settings).await.unwrap();

        let shown = b.call("s1", "browser_evaluate", evaluate_args("secret", "#client-secret", false), &settings).await.unwrap();
        let info = parse_info(&result_string(&shown).unwrap_or_else(|e| panic!("{e}: {shown}"))).unwrap();
        assert_eq!((info.tag.as_str(), info.id.as_str(), info.kind.as_str()), ("input", "client-secret", "password"));
        assert_eq!(info.length, SECRET.chars().count());
        assert_eq!(info.page, "about:", "an origin-less page is described by its scheme alone");
        assert!(!info.digest.is_empty() && !info.digest.contains(SECRET));
        assert!(!shown.to_string().contains(SECRET), "the description read carries no value");

        let read = b.call("s1", "browser_evaluate", evaluate_args("secret", "#client-secret", true), &settings).await.unwrap();
        let (value, again) = parse_read(&result_string(&read).unwrap()).unwrap();
        assert_eq!(value, SECRET);
        assert_eq!(again, info, "both reads describe the element the same way");
        b.shutdown().await;
    }

    #[test]
    fn the_playwright_result_text_yields_the_returned_string() {
        // The shape a live Playwright MCP answered with: one newline between sections.
        let live = json!({"content": [{"type": "text", "text": "### Result\n\"abc 123\"\n### Ran Playwright code\n```js\nawait page.locator('#x').evaluate(...)\n```"}]});
        assert_eq!(result_string(&live).unwrap(), "abc 123");
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
