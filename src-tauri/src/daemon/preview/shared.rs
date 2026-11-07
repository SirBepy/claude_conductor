//! Shared mockups (todo pc-1620): one preview entry owned by a main chat whose
//! page is a shell with named regions, each region filled by one sub's part.
//! A part brings its own html, css and controls; the panel applies a control by
//! setting `data-<control id>` on the part's root element, so a control never
//! re-stages the document.
//!
//! Who may write is decided here, from the registry: the main chat creates the
//! page (a sub never does), and a part is written by the owner or by one of the
//! owner's subs. Every refusal is an `ok:false` naming the fix, because the
//! model reads it as the tool result and retries.

use super::{evict_if_at_cap, load_list, now_rfc3339, save, store_path, PreviewSnapshot, MAX_HTML_BYTES, WRITE_LOCK};
use crate::daemon::state::DaemonState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use ts_rs::TS;

/// `source` of a shared mockup's entry. Plain `"chat"` rules (the rail opens for
/// a push), because a shared mockup has no inline card in the transcript.
pub const SHARED_SOURCE: &str = "chat";

const MAX_CONTROLS: usize = 8;
const MAX_OPTIONS: usize = 12;
const MAX_PARTS: usize = 12;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Control {
    pub id: String,
    pub label: String,
    /// `"switch"` (values `on`/`off`) or `"select"` (one of `options`).
    pub kind: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub default: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Part {
    pub id: String,
    pub owner_session_id: String,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub css: String,
    #[serde(default)]
    pub controls: Vec<Control>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SharedMockup {
    pub owner_session_id: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub parts: Vec<Part>,
}

impl SharedMockup {
    /// Bytes this copy holds on top of the snapshot's composed `html`, for the
    /// store budget: the shell plus each part's own html and css.
    pub(super) fn stored_bytes(&self) -> usize {
        self.shell.len() + self.parts.iter().map(|p| p.html.len() + p.css.len()).sum::<usize>()
    }
}

// ── Document ────────────────────────────────────────────────────────────────

/// One empty element carrying `data-part="<id>"` in the shell.
struct Region {
    start: usize,
    open_end: usize,
    end: usize,
    tag: String,
    id: String,
}

fn find_regions(shell: &str) -> Vec<Region> {
    const KEY: &str = "data-part=\"";
    let lower = shell.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = shell[from..].find(KEY) {
        let at = from + rel;
        from = at + KEY.len();
        let Some(start) = shell[..at].rfind('<') else { continue };
        if shell[start..at].contains('>') {
            continue;
        }
        let tag: String = shell[start + 1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if tag.is_empty() {
            continue;
        }
        let id_start = at + KEY.len();
        let Some(id_len) = shell[id_start..].find('"') else { continue };
        let id = shell[id_start..id_start + id_len].to_string();
        let Some(gt_rel) = shell[id_start..].find('>') else { continue };
        let open_end = id_start + gt_rel;
        if shell[..open_end].ends_with('/') {
            continue;
        }
        let close = format!("</{}>", tag.to_ascii_lowercase());
        let after = &lower[open_end + 1..];
        let trimmed = after.trim_start();
        if !trimmed.starts_with(&close) {
            continue;
        }
        let end = open_end + 1 + (after.len() - trimmed.len()) + close.len();
        out.push(Region { start, open_end, end, tag, id });
        from = end;
    }
    out
}

/// The region ids a shell declares, in document order.
pub fn regions(shell: &str) -> Vec<String> {
    find_regions(shell).into_iter().map(|r| r.id).collect()
}

fn esc_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

/// A `</style` inside part css would end the block early and spill the rest into
/// the page.
fn safe_css(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let lower = css.to_ascii_lowercase();
    let mut i = 0;
    while i < css.len() {
        if lower[i..].starts_with("</style") {
            out.push_str("<\\/style");
            i += "</style".len();
        } else {
            let ch = css[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Listens for the panel's control changes. `e.source` is checked because a
/// part's own script could post the same shape at itself.
const CONTROL_SCRIPT: &str = "<script>window.addEventListener(\"message\",function(e){var d=e.data;if(e.source!==window.parent||!d||d.cc!==\"control\")return;var els=document.querySelectorAll(\"[data-part]\");for(var i=0;i<els.length;i++){if(els[i].getAttribute(\"data-part\")===d.part){els[i].setAttribute(\"data-\"+d.id,String(d.value));}}});</script>";

/// The page the panel renders: the shell with every filled region replaced by
/// its part (default control values as `data-*`, css wrapped in `@scope` so one
/// sub's rules cannot reach another's region) and the control listener.
pub fn compose(shell: &str, parts: &[Part]) -> String {
    let mut out = String::with_capacity(shell.len());
    let mut last = 0;
    for r in find_regions(shell) {
        out.push_str(&shell[last..r.start]);
        last = r.end;
        let Some(part) = parts.iter().find(|p| p.id == r.id) else {
            out.push_str(&shell[r.start..r.end]);
            continue;
        };
        out.push_str(&shell[r.start..r.open_end]);
        for c in &part.controls {
            out.push_str(&format!(" data-{}=\"{}\"", c.id, esc_attr(&c.default)));
        }
        out.push('>');
        out.push_str(&part.html);
        out.push_str(&format!("</{}>", r.tag));
        if !part.css.trim().is_empty() {
            out.push_str(&format!("<style>@scope ([data-part=\"{}\"]) {{\n{}\n}}</style>", r.id, safe_css(&part.css)));
        }
    }
    out.push_str(&shell[last..]);
    let lower = out.to_ascii_lowercase();
    match lower.rfind("</body>") {
        Some(i) => out.insert_str(i, CONTROL_SCRIPT),
        None => out.push_str(CONTROL_SCRIPT),
    }
    out
}

// ── Input ───────────────────────────────────────────────────────────────────

fn valid_id(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= 31
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Checks the model's `controls` array. A select's default must be one of its
/// options; a switch's is `on` or `off`.
pub fn clean_controls(raw: &Value) -> Result<Vec<Control>, String> {
    let arr = raw.as_array().ok_or("controls must be an array")?;
    if arr.len() > MAX_CONTROLS {
        return Err(format!("at most {MAX_CONTROLS} controls per part, got {}", arr.len()));
    }
    let mut out: Vec<Control> = Vec::new();
    for c in arr {
        let id = c["id"].as_str().unwrap_or("").trim().to_string();
        if !valid_id(&id) || id == "part" {
            return Err(format!("control id \"{id}\" must be lowercase letters, digits, - or _ (max 31) and not \"part\""));
        }
        if out.iter().any(|o| o.id == id) {
            return Err(format!("control id \"{id}\" is used twice"));
        }
        let label: String = c["label"].as_str().unwrap_or("").trim().chars().take(40).collect();
        if label.is_empty() {
            return Err(format!("control \"{id}\" needs a label"));
        }
        match c["kind"].as_str() {
            Some("switch") => {
                let on = match &c["default"] {
                    Value::Bool(b) => *b,
                    Value::String(s) => s == "on",
                    _ => false,
                };
                out.push(Control { id, label, kind: "switch".into(), options: Vec::new(), default: if on { "on" } else { "off" }.into() });
            }
            Some("select") => {
                let mut options: Vec<String> = Vec::new();
                for o in c["options"].as_array().into_iter().flatten() {
                    let o: String = o.as_str().unwrap_or("").trim().chars().take(40).collect();
                    if !o.is_empty() && !options.contains(&o) {
                        options.push(o);
                    }
                }
                if options.len() < 2 || options.len() > MAX_OPTIONS {
                    return Err(format!("select \"{id}\" needs 2 to {MAX_OPTIONS} distinct options (a yes/no choice is kind \"switch\")"));
                }
                let default = c["default"].as_str().map(str::trim).filter(|d| options.iter().any(|o| o == d)).map(str::to_string).unwrap_or_else(|| options[0].clone());
                out.push(Control { id, label, kind: "select".into(), options, default });
            }
            other => return Err(format!("control \"{id}\" has kind {other:?}: use \"select\" for a choice or \"switch\" for yes/no")),
        }
    }
    Ok(out)
}

// ── Tool ────────────────────────────────────────────────────────────────────

fn refuse(msg: impl Into<String>) -> Value {
    json!({ "ok": false, "error": msg.into() })
}

/// Refusal for a composed page past the cap an ordinary push is held to
/// (`push_at`); the route body limit alone would let a shell plus 12 parts
/// reach about 12 times that.
fn over_page_cap(composed: &str) -> Option<Value> {
    (composed.len() > MAX_HTML_BYTES).then(|| {
        refuse(format!(
            "the composed page is {} bytes, over the {MAX_HTML_BYTES}-byte cap every preview page has: shorten the shell or the parts' html and css",
            composed.len()
        ))
    })
}

fn display_name(state: &DaemonState, session_id: &str) -> String {
    let Some(inst) = state.registry.get(session_id) else { return session_id.chars().take(8).collect() };
    if let Some(n) = inst.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        return n.to_string();
    }
    crate::sessions::chat_config::get(session_id)
        .and_then(|c| c.subchat)
        .map(|b| b.task.trim().chars().take(40).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| session_id.chars().take(8).collect())
}

/// The `shared_mockup` tool: `create` (the main chat) and `part` (the main chat
/// or one of its subs). Writes the real store and announces the entry.
pub fn run(state: &DaemonState, session_id: &str, body: &Value) -> Value {
    let Some(path) = store_path() else { return refuse("the preview store has no data directory") };
    let out = {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        run_at(&path, state, session_id, body)
    };
    if out["ok"] == json!(true) {
        if let Some(id) = out["id"].as_str() {
            if let Some(meta) = super::list().into_iter().find(|m| m.id == id) {
                state.notifier.publish("preview", json!({ "snapshot": meta }));
            }
        }
    }
    out
}

pub(crate) fn run_at(path: &Path, state: &DaemonState, session_id: &str, body: &Value) -> Value {
    match body["action"].as_str() {
        Some("create") => create_at(path, state, session_id, body),
        Some("part") => part_at(path, state, session_id, body),
        _ => refuse("action must be create (the main chat makes the page) or part (a sub fills its region)"),
    }
}

fn create_at(path: &Path, state: &DaemonState, caller: &str, body: &Value) -> Value {
    let Some(me) = state.registry.get(caller) else { return refuse("this chat is not known to the app") };
    if me.subchat_of.is_some() {
        return refuse("a sub never creates the shared mockup: its main chat does. Add your region with action part instead.");
    }
    let shell = body["shell"].as_str().unwrap_or("").to_string();
    let found = regions(&shell);
    if found.is_empty() {
        return refuse("shell needs at least one empty region element, for example <div data-part=\"header\"></div>, one per sub's part");
    }
    let slug = body["slug"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("shared-mockup").to_string();
    let title = body["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| slug.clone());

    let mut list = load_list(path);
    if let Some(existing) = list.iter_mut().find(|s| s.slug == slug) {
        let Some(shared) = existing.shared.as_mut().filter(|s| s.owner_session_id == caller) else {
            return refuse(format!("slug \"{slug}\" already belongs to another preview: pick a different slug"));
        };
        // A part whose region the new shell dropped never renders, but would
        // still show a chip in the row and count toward MAX_PARTS.
        let kept: Vec<Part> = shared.parts.iter().filter(|p| found.contains(&p.id)).cloned().collect();
        let html = compose(&shell, &kept);
        if let Some(refused) = over_page_cap(&html) {
            return refused;
        }
        shared.shell = shell;
        shared.parts = kept;
        existing.title = title;
        existing.html = html;
        existing.version += 1;
        existing.created_at = now_rfc3339();
        let id = existing.id.clone();
        save(path, &mut list);
        return json!({ "ok": true, "id": id, "regions": found });
    }
    let html = compose(&shell, &[]);
    if let Some(refused) = over_page_cap(&html) {
        return refused;
    }
    let id = uuid::Uuid::new_v4().to_string();
    evict_if_at_cap(&mut list);
    list.push(PreviewSnapshot {
        id: id.clone(),
        slug,
        title,
        html,
        source: SHARED_SOURCE.into(),
        session_id: Some(caller.to_string()),
        version: 1,
        created_at: now_rfc3339(),
        published: None,
        previous: Vec::new(),
        shared: Some(SharedMockup { owner_session_id: caller.to_string(), shell, parts: Vec::new() }),
    });
    save(path, &mut list);
    json!({ "ok": true, "id": id, "regions": found })
}

fn part_at(path: &Path, state: &DaemonState, caller: &str, body: &Value) -> Value {
    let Some(me) = state.registry.get(caller) else { return refuse("this chat is not known to the app") };
    let owner = me.subchat_of.clone().unwrap_or_else(|| caller.to_string());
    let mut list = load_list(path);
    let slug = body["slug"].as_str().map(str::trim).filter(|s| !s.is_empty());
    let idx = match slug {
        Some(slug) => list.iter().position(|s| s.slug == slug),
        // Newest shared mockup of the owner, so a sub that was never told the slug still finds it.
        None => list
            .iter()
            .enumerate()
            .filter(|(_, s)| s.shared.as_ref().is_some_and(|m| m.owner_session_id == owner))
            .max_by(|a, b| a.1.created_at.cmp(&b.1.created_at))
            .map(|(i, _)| i),
    };
    let Some(idx) = idx else {
        return refuse(match slug {
            Some(s) => format!("no shared mockup \"{s}\": ask the main chat to create it first (shared_mockup action create)"),
            None => "the main chat has not created a shared mockup yet: it must call shared_mockup action create first".to_string(),
        });
    };
    let snap = &mut list[idx];
    let Some(shared) = snap.shared.as_mut() else {
        return refuse(format!("\"{}\" is an ordinary preview, not a shared mockup: ask the main chat to create one", snap.slug));
    };
    if shared.owner_session_id != owner {
        return refuse(format!("\"{}\" belongs to another main chat, and you only add parts to your own main chat's mockup", snap.slug));
    }
    let part_id = body["part"].as_str().unwrap_or("").trim().to_string();
    let declared = regions(&shared.shell);
    if !declared.contains(&part_id) {
        return refuse(format!("part \"{part_id}\" is not a region of this page. Regions: {}", declared.join(", ")));
    }
    let html = body["html"].as_str().unwrap_or("").to_string();
    let css = body["css"].as_str().unwrap_or("").to_string();
    if html.len() + css.len() > MAX_HTML_BYTES {
        return refuse(format!("part is over the {MAX_HTML_BYTES}-byte cap"));
    }
    let existing = shared.parts.iter().position(|p| p.id == part_id);
    if let Some(i) = existing {
        let p = &shared.parts[i];
        if p.owner_session_id != caller && caller != owner {
            return refuse(format!("region \"{part_id}\" is already filled by {}: pick a region of your own", p.owner_name));
        }
    } else if shared.parts.len() >= MAX_PARTS {
        return refuse(format!("a shared mockup holds at most {MAX_PARTS} parts"));
    }
    let controls = match body.get("controls").filter(|c| !c.is_null()) {
        Some(raw) => match clean_controls(raw) {
            Ok(c) => c,
            Err(e) => return refuse(e),
        },
        None => existing.map(|i| shared.parts[i].controls.clone()).unwrap_or_default(),
    };
    let (owner_session_id, owner_name) = match existing {
        Some(i) => (shared.parts[i].owner_session_id.clone(), shared.parts[i].owner_name.clone()),
        None => (caller.to_string(), display_name(state, caller)),
    };
    let part = Part { id: part_id, owner_session_id, owner_name, html, css, controls };
    match existing {
        Some(i) => shared.parts[i] = part,
        None => shared.parts.push(part),
    }
    let composed = compose(&shared.shell, &shared.parts);
    if let Some(refused) = over_page_cap(&composed) {
        return refused;
    }
    snap.html = composed;
    snap.version += 1;
    snap.created_at = now_rfc3339();
    let id = snap.id.clone();
    save(path, &mut list);
    json!({ "ok": true, "id": id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    const SHELL: &str = "<main><div data-part=\"header\"></div><section class=\"x\" data-part=\"footer\"> </section></main>";

    fn state() -> std::sync::Arc<DaemonState> {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        for id in ["main", "sub-a", "sub-b", "other-main", "other-sub"] {
            st.registry.upsert_interactive(id, Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        st.registry.set_subchat_of("sub-a", Some("main".into()));
        st.registry.set_subchat_of("sub-b", Some("main".into()));
        st.registry.set_subchat_of("other-sub", Some("other-main".into()));
        st
    }

    fn sw(id: &str, default: bool) -> Value {
        json!({"id": id, "label": id, "kind": "switch", "default": default})
    }

    fn store() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        (tmp, path)
    }

    fn create(path: &Path, st: &DaemonState, who: &str) -> Value {
        run_at(path, st, who, &json!({"action": "create", "slug": "page", "title": "Page", "shell": SHELL}))
    }

    #[test]
    fn regions_are_the_empty_elements_carrying_data_part_in_document_order() {
        assert_eq!(regions(SHELL), ["header", "footer"]);
        assert!(regions("<div data-part=\"a\">not empty</div>").is_empty());
        assert!(regions("<div data-part=\"a\"/>").is_empty());
        assert!(regions("<p>no regions</p>").is_empty());
    }

    #[test]
    fn compose_fills_a_region_with_defaults_as_data_attributes_and_scopes_its_css() {
        let part = Part {
            id: "header".into(),
            owner_session_id: "sub-a".into(),
            owner_name: "Hero".into(),
            html: "<h3>Ana</h3>".into(),
            css: ":scope[data-style=\"ember\"] h3 { color: red }".into(),
            controls: vec![
                Control { id: "style".into(), label: "Style".into(), kind: "select".into(), options: vec!["aurora".into(), "ember".into()], default: "aurora".into() },
                Control { id: "photo".into(), label: "Photo".into(), kind: "switch".into(), options: vec![], default: "on".into() },
            ],
        };
        let doc = compose(SHELL, &[part]);
        assert!(doc.contains("<div data-part=\"header\" data-style=\"aurora\" data-photo=\"on\"><h3>Ana</h3></div>"), "{doc}");
        assert!(doc.contains("@scope ([data-part=\"header\"])"), "{doc}");
        assert!(doc.contains("<section class=\"x\" data-part=\"footer\"> </section>"), "an unfilled region stays as the shell wrote it: {doc}");
        assert!(doc.contains("addEventListener(\"message\""), "the control listener is in the page");
        assert!(doc.find("<script>").unwrap() > doc.find("</main>").unwrap());
    }

    #[test]
    fn part_css_cannot_close_its_style_block() {
        let part = Part { id: "header".into(), owner_session_id: "s".into(), owner_name: "n".into(), html: String::new(), css: "a{} </STYLE><b>x</b>".into(), controls: vec![] };
        let doc = compose(SHELL, &[part]);
        assert_eq!(doc.matches("</style>").count(), 1, "{doc}");
    }

    #[test]
    fn the_listener_goes_before_the_last_closing_body() {
        let doc = compose("<html><body><div data-part=\"a\"></div></body></html>", &[]);
        assert!(doc.find("<script>").unwrap() < doc.rfind("</body>").unwrap());
    }

    #[test]
    fn controls_are_checked_a_choice_is_a_select_and_yes_no_is_a_switch() {
        let ok = clean_controls(&json!([
            {"id": "style", "label": "Style", "kind": "select", "options": ["a", "b"], "default": "zzz"},
            {"id": "photo", "label": "Photo", "kind": "switch", "default": true}
        ])).unwrap();
        assert_eq!(ok[0].default, "a", "a default outside the options falls back to the first");
        assert_eq!(ok[1].default, "on");
        assert!(clean_controls(&json!([{"id": "x", "label": "X", "kind": "select", "options": ["only"]}])).unwrap_err().contains("switch"));
        assert!(clean_controls(&json!([{"id": "x", "label": "X", "kind": "chips"}])).is_err());
        assert!(clean_controls(&json!([sw("a", false), sw("a", false)])).unwrap_err().contains("twice"));
        assert!(clean_controls(&json!([sw("part", false)])).is_err(), "part is the region attribute");
        assert!(clean_controls(&json!([{"id": "Bad Id", "label": "X", "kind": "switch"}])).is_err());
    }

    #[test]
    fn only_a_main_chat_creates_the_page_and_a_sub_is_told_to_add_a_part() {
        let (_t, path) = store();
        let st = state();
        let refused = create(&path, &st, "sub-a");
        assert_eq!(refused["ok"], json!(false));
        assert!(refused["error"].as_str().unwrap().contains("part"), "{refused}");
        assert!(load_list(&path).is_empty());
        let made = create(&path, &st, "main");
        assert_eq!(made["ok"], json!(true), "{made}");
        let stored = &load_list(&path)[0];
        assert_eq!(stored.session_id.as_deref(), Some("main"));
        assert_eq!(stored.shared.as_ref().unwrap().owner_session_id, "main");
    }

    #[test]
    fn a_shell_without_a_region_is_refused_naming_the_fix() {
        let (_t, path) = store();
        let v = run_at(&path, &state(), "main", &json!({"action": "create", "slug": "p", "shell": "<p>x</p>"}));
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("data-part"));
    }

    #[test]
    fn a_slug_held_by_an_ordinary_preview_or_another_owner_is_refused() {
        let (_t, path) = store();
        let st = state();
        crate::daemon::preview::push_at(&path, "T".into(), Some("page".into()), "<p></p>".into(), "chat".into(), Some("main".into())).unwrap();
        assert_eq!(create(&path, &st, "main")["ok"], json!(false));
        let (_t2, path2) = store();
        assert_eq!(create(&path2, &st, "main")["ok"], json!(true));
        assert_eq!(create(&path2, &st, "other-main")["ok"], json!(false));
    }

    #[test]
    fn a_sub_fills_its_own_main_chats_region_and_the_document_follows() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        let v = run_at(&path, &st, "sub-a", &json!({
            "action": "part", "part": "header", "html": "<h3>Ana</h3>", "css": "h3{margin:0}",
            "controls": [{"id": "photo", "label": "Photo", "kind": "switch", "default": true}]
        }));
        assert_eq!(v["ok"], json!(true), "no slug needed: the owner's newest shared mockup is found: {v}");
        let snap = &load_list(&path)[0];
        assert_eq!(snap.version, 2);
        assert!(snap.html.contains("<h3>Ana</h3>") && snap.html.contains("data-photo=\"on\""));
        let part = &snap.shared.as_ref().unwrap().parts[0];
        assert_eq!(part.owner_session_id, "sub-a");
    }

    #[test]
    fn a_sub_of_another_main_chat_cannot_add_a_part() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        let v = run_at(&path, &st, "other-sub", &json!({"action": "part", "slug": "page", "part": "header", "html": "x"}));
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("another main chat"), "{v}");
        let unrelated = run_at(&path, &st, "other-sub", &json!({"action": "part", "part": "header", "html": "x"}));
        assert_eq!(unrelated["ok"], json!(false), "its own main chat has no mockup either");
    }

    #[test]
    fn a_part_for_a_region_the_page_does_not_have_lists_the_regions() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        let v = run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "sidebar", "html": "x"}));
        assert!(v["error"].as_str().unwrap().contains("header, footer"), "{v}");
    }

    #[test]
    fn one_sub_cannot_overwrite_another_subs_region_but_the_owner_can() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "A"}));
        let clash = run_at(&path, &st, "sub-b", &json!({"action": "part", "part": "header", "html": "B"}));
        assert_eq!(clash["ok"], json!(false), "{clash}");
        assert!(load_list(&path)[0].html.contains('A'));
        let own = run_at(&path, &st, "main", &json!({"action": "part", "part": "header", "html": "M"}));
        assert_eq!(own["ok"], json!(true));
        let again = run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "A2"}));
        assert_eq!(again["ok"], json!(true), "the part keeps its first writer, who may still update it");
    }

    #[test]
    fn a_part_without_controls_keeps_the_controls_it_had() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "A", "controls": [sw("photo", true)]}));
        run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "A2"}));
        assert_eq!(load_list(&path)[0].shared.as_ref().unwrap().parts[0].controls.len(), 1);
        run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "A3", "controls": []}));
        assert!(load_list(&path)[0].shared.as_ref().unwrap().parts[0].controls.is_empty());
    }

    #[test]
    fn a_part_that_pushes_the_composed_page_past_the_cap_is_refused_naming_the_fix() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        // Each part is under the per-part cap; together they are not.
        let big = "x".repeat(MAX_HTML_BYTES / 2 + 1);
        let a = run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": big}));
        assert_eq!(a["ok"], json!(true), "{}", a["error"]);
        let b = run_at(&path, &st, "sub-b", &json!({"action": "part", "part": "footer", "html": big}));
        assert_eq!(b["ok"], json!(false));
        assert!(b["error"].as_str().unwrap().contains("composed page") && b["error"].as_str().unwrap().contains("shorten"), "{b}");
        let stored = &load_list(&path)[0];
        assert_eq!(stored.shared.as_ref().unwrap().parts.len(), 1, "the refused part is not stored");
        assert!(stored.html.len() <= MAX_HTML_BYTES);
    }

    #[test]
    fn a_shell_over_the_page_cap_is_refused_on_create_and_on_re_create() {
        let (_t, path) = store();
        let st = state();
        let huge = format!("{SHELL}<!--{}-->", "x".repeat(MAX_HTML_BYTES));
        let v = run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": huge}));
        assert_eq!(v["ok"], json!(false));
        assert!(load_list(&path).is_empty());
        create(&path, &st, "main");
        let again = run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": huge}));
        assert_eq!(again["ok"], json!(false));
        assert_eq!(load_list(&path)[0].shared.as_ref().unwrap().shell, SHELL, "the old shell stays");
    }

    #[test]
    fn re_creating_with_a_shell_that_drops_a_region_drops_its_part_and_frees_the_slot() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "A"}));
        run_at(&path, &st, "sub-b", &json!({"action": "part", "part": "footer", "html": "B"}));
        let again = run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": "<main><div data-part=\"top\"></div><section data-part=\"footer\"></section></main>"}));
        assert_eq!(again["ok"], json!(true), "{again}");
        let snap = &load_list(&path)[0];
        let ids: Vec<&str> = snap.shared.as_ref().unwrap().parts.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["footer"], "the header part had no region left");
        assert!(snap.html.contains('B') && !snap.html.contains(">A<") && !snap.html.contains("data-part=\"header\""), "{}", snap.html);
    }

    #[test]
    fn a_history_file_written_before_shared_existed_loads_as_an_ordinary_preview() {
        let (_t, path) = store();
        std::fs::write(&path, r#"[{"id":"a","slug":"s","title":"t","html":"<p></p>","source":"chat","session_id":null,"version":1,"created_at":"2026-01-01T00:00:00.000Z"}]"#).unwrap();
        assert!(load_list(&path)[0].shared.is_none());
    }

    #[test]
    fn a_plain_push_to_a_shared_slug_turns_it_back_into_an_ordinary_preview() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        crate::daemon::preview::push_at(&path, "T".into(), Some("page".into()), "<p>plain</p>".into(), "chat".into(), Some("main".into())).unwrap();
        assert!(load_list(&path)[0].shared.is_none(), "a stale shell must not recompose over the new page");
    }
}
