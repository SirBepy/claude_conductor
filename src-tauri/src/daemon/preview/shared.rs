//! Shared mockups (todo pc-1620): one preview entry owned by a main chat whose
//! page is a shell with named regions, each region filled by one sub's part.
//! A part brings its own html, css and controls; the panel applies a control by
//! setting `data-<control id>` on the part's root element, so a control never
//! re-stages the document.
//!
//! Who may write is decided here, from the registry: the main chat creates the
//! page (a sub only re-creates it when the main chat named it the layout sub),
//! and a part is written by the owner or by one of the owner's subs. The shell
//! has controls of its own (`SharedMockup.controls`), set on the page root. Every refusal is an `ok:false` naming the fix, because the
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
    /// The one sub the main chat named to own the shell (todo pc-1668). It may
    /// re-create the page; any other sub is refused.
    #[serde(default)]
    pub layout_session_id: Option<String>,
    /// Controls of the page itself (layout alternatives), applied as
    /// `data-<id>` on the page root. Saved values use the key `ctl|shell|<id>`.
    #[serde(default)]
    pub controls: Vec<Control>,
}

/// The `view_state` key region id of the shell's own controls.
pub const SHELL_ID: &str = "shell";

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
const CONTROL_SCRIPT: &str = "<script>window.addEventListener(\"message\",function(e){var d=e.data;if(e.source!==window.parent||!d||d.cc!==\"control\")return;if(d.part===\"shell\"){var r=document.querySelector(\"[data-cc-root]\")||document.body||document.documentElement;r.setAttribute(\"data-\"+d.id,String(d.value));return;}var els=document.querySelectorAll(\"[data-part]\");for(var i=0;i<els.length;i++){if(els[i].getAttribute(\"data-part\")===d.part){els[i].setAttribute(\"data-\"+d.id,String(d.value));}}});</script>";

/// Tells the panel which region an Alt-click (desktop) or a 500ms long-press
/// (phone) landed in: the nearest ancestor with `data-part`, else "shell". The
/// capture-phase handler swallows the click so an Alt-clicked link does not
/// navigate and the click that ends a long-press does not act.
const ELEMENT_SCRIPT: &str = "<script>(function(){function reg(t){while(t&&t.nodeType===1){var p=t.getAttribute(\"data-part\");if(p)return p;t=t.parentElement;}return \"shell\";}function send(t,x,y){parent.postMessage({cc:\"element\",region:reg(t),x:x,y:y},\"*\");}var tm=null,lp=false;function stop(){if(tm){clearTimeout(tm);tm=null;}}document.addEventListener(\"click\",function(e){if(!e.altKey&&!lp)return;e.preventDefault();e.stopPropagation();if(lp){lp=false;return;}send(e.target,e.clientX,e.clientY);},true);document.addEventListener(\"touchstart\",function(e){stop();var t=e.touches[0],el=e.target;tm=setTimeout(function(){tm=null;lp=true;send(el,t.clientX,t.clientY);},500);},{passive:true});document.addEventListener(\"touchmove\",stop,{passive:true});document.addEventListener(\"touchend\",stop,{passive:true});document.addEventListener(\"touchcancel\",stop,{passive:true});})();</script>";

/// The page the panel renders: the shell with every filled region replaced by
/// its part (default control values as `data-*`, css wrapped in `@scope` so one
/// sub's rules cannot reach another's region) and the control listener.
pub fn compose(shell: &str, parts: &[Part], shell_controls: &[Control]) -> String {
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
    mark_root(&mut out, shell_controls);
    let lower = out.to_ascii_lowercase();
    match lower.rfind("</body>") {
        Some(i) => {
            out.insert_str(i, ELEMENT_SCRIPT);
            out.insert_str(i, CONTROL_SCRIPT);
        }
        None => {
            out.push_str(CONTROL_SCRIPT);
            out.push_str(ELEMENT_SCRIPT);
        }
    }
    out
}

/// Puts `data-cc-root` and the shell controls' defaults on the page root: the
/// `<body>` when the shell has one, else the first element that is not
/// document furniture. Shell css selects with `[data-<id>="v"]`.
fn mark_root(doc: &mut String, controls: &[Control]) {
    let lower = doc.to_ascii_lowercase();
    let at = match lower.find("<body") {
        Some(i) => Some(i),
        None => {
            let mut from = 0;
            let mut found = None;
            while let Some(rel) = lower[from..].find('<') {
                let i = from + rel;
                let rest = &lower[i + 1..];
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                if name.is_empty() || rest.starts_with('!') || rest.starts_with('?') || rest.starts_with('/') {
                    from = i + 1;
                    continue;
                }
                if matches!(name.as_str(), "style" | "script") {
                    let close = format!("</{name}");
                    from = lower[i..].find(&close).map_or(lower.len(), |c| i + c + close.len());
                    continue;
                }
                if matches!(name.as_str(), "html" | "head" | "meta" | "link" | "title" | "base") {
                    from = i + 1;
                    continue;
                }
                found = Some(i);
                break;
            }
            found
        }
    };
    let Some(at) = at else { return };
    let Some(gt_rel) = doc[at..].find('>') else { return };
    let mut gt = at + gt_rel;
    if doc[..gt].ends_with('/') {
        gt -= 1;
    }
    let mut attrs = String::from(" data-cc-root");
    for c in controls {
        attrs.push_str(&format!(" data-{}=\"{}\"", c.id, esc_attr(&c.default)));
    }
    doc.insert_str(gt, &attrs);
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
        Some("layout") => layout_at(path, state, session_id, body),
        _ => refuse("action must be create (the main chat makes the page), layout (the main chat names the sub that owns the shell) or part (a sub fills its region)"),
    }
}

/// The main chat's newest shared mockup, or the one `slug` names.
fn find_idx(list: &[PreviewSnapshot], owner: &str, slug: Option<&str>) -> Option<usize> {
    match slug {
        Some(slug) => list.iter().position(|s| s.slug == slug),
        None => list
            .iter()
            .enumerate()
            .filter(|(_, s)| s.shared.as_ref().is_some_and(|m| m.owner_session_id == owner))
            .max_by(|a, b| a.1.created_at.cmp(&b.1.created_at))
            .map(|(i, _)| i),
    }
}

fn create_at(path: &Path, state: &DaemonState, caller: &str, body: &Value) -> Value {
    let Some(me) = state.registry.get(caller) else { return refuse("this chat is not known to the app") };
    let owner = me.subchat_of.clone().unwrap_or_else(|| caller.to_string());
    let is_sub = me.subchat_of.is_some();
    let shell = body["shell"].as_str().unwrap_or("").to_string();
    let found = regions(&shell);
    if found.is_empty() {
        return refuse("shell needs at least one empty region element, for example <div data-part=\"header\"></div>, one per sub's part");
    }
    if found.iter().any(|r| r == SHELL_ID) {
        return refuse("\"shell\" is the page's own name for its controls and messages: pick another region id");
    }
    let slug = body["slug"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("shared-mockup").to_string();
    let title = body["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| slug.clone());
    let new_controls = match body.get("controls").filter(|c| !c.is_null()) {
        Some(raw) => match clean_controls(raw) {
            Ok(c) => Some(c),
            Err(e) => return refuse(e),
        },
        None => None,
    };

    let mut list = load_list(path);
    if is_sub {
        // A sub re-creates the shell only as the layout sub of an existing page.
        let existing = list.iter().find(|s| s.slug == slug).and_then(|s| s.shared.as_ref()).filter(|m| m.owner_session_id == owner);
        let Some(shared) = existing else {
            return refuse("a sub never creates the shared mockup: its main chat does. Add your region with action part instead.");
        };
        if shared.layout_session_id.as_deref() != Some(caller) {
            return refuse(match shared.layout_session_id.as_deref() {
                Some(id) => format!(
                    "only the layout sub re-creates the shell, and that is {}: send it your layout change, or add your region with action part.",
                    display_name(state, id)
                ),
                None => "only the layout sub re-creates the shell, and the main chat has named none: ask it, or add your region with action part.".to_string(),
            });
        }
    }
    if let Some(existing) = list.iter_mut().find(|s| s.slug == slug) {
        let Some(shared) = existing.shared.as_mut().filter(|s| s.owner_session_id == owner) else {
            return refuse(format!("slug \"{slug}\" already belongs to another preview: pick a different slug"));
        };
        // A part whose region the new shell dropped never renders, but would
        // still show a chip in the row and count toward MAX_PARTS.
        let kept: Vec<Part> = shared.parts.iter().filter(|p| found.contains(&p.id)).cloned().collect();
        let controls = new_controls.unwrap_or_else(|| shared.controls.clone());
        let html = compose(&shell, &kept, &controls);
        if let Some(refused) = over_page_cap(&html) {
            return refused;
        }
        shared.shell = shell;
        shared.parts = kept;
        shared.controls = controls;
        existing.title = title;
        existing.html = html;
        existing.version += 1;
        existing.created_at = now_rfc3339();
        let id = existing.id.clone();
        save(path, &mut list);
        return json!({ "ok": true, "id": id, "regions": found });
    }
    let controls = new_controls.unwrap_or_default();
    let html = compose(&shell, &[], &controls);
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
        shared: Some(SharedMockup { owner_session_id: caller.to_string(), shell, parts: Vec::new(), layout_session_id: None, controls }),
        view_state: Default::default(),
    });
    save(path, &mut list);
    json!({ "ok": true, "id": id, "regions": found })
}

/// `layout`: the main chat names one of its own subs (by session id or name) as
/// the sub that owns the shell. The main chat keeps its own right to re-create.
fn layout_at(path: &Path, state: &DaemonState, caller: &str, body: &Value) -> Value {
    let Some(me) = state.registry.get(caller) else { return refuse("this chat is not known to the app") };
    if me.subchat_of.is_some() {
        return refuse("only the main chat names the layout sub");
    }
    let query = body["sub"].as_str().map(str::trim).unwrap_or("");
    if query.is_empty() {
        return refuse("layout needs sub: the session id or name of one of your own subs");
    }
    let mine: Vec<_> = state.registry.list().into_iter().filter(|i| i.subchat_of.as_deref() == Some(caller)).collect();
    let by_id = mine.iter().find(|i| i.session_id == query);
    let named: Vec<_> = mine.iter().filter(|i| i.name.as_deref().map(str::trim) == Some(query)).collect();
    let sub = match (by_id, named.as_slice()) {
        (Some(i), _) => i,
        (None, [one]) => one,
        (None, []) => return refuse(format!("\"{query}\" is not one of your subs: use the session id or name from subchat list")),
        (None, _) => return refuse(format!("{} of your subs are named \"{query}\": use the session id", named.len())),
    };
    let mut list = load_list(path);
    let slug = body["slug"].as_str().map(str::trim).filter(|s| !s.is_empty());
    let Some(idx) = find_idx(&list, caller, slug) else {
        return refuse("no shared mockup of yours yet: call action create first");
    };
    let snap = &mut list[idx];
    let Some(shared) = snap.shared.as_mut().filter(|m| m.owner_session_id == caller) else {
        return refuse(format!("\"{}\" is not a shared mockup of yours", snap.slug));
    };
    shared.layout_session_id = Some(sub.session_id.clone());
    let id = snap.id.clone();
    save(path, &mut list);
    json!({ "ok": true, "id": id, "layout_session_id": sub.session_id })
}

fn part_at(path: &Path, state: &DaemonState, caller: &str, body: &Value) -> Value {
    let Some(me) = state.registry.get(caller) else { return refuse("this chat is not known to the app") };
    let owner = me.subchat_of.clone().unwrap_or_else(|| caller.to_string());
    let mut list = load_list(path);
    let slug = body["slug"].as_str().map(str::trim).filter(|s| !s.is_empty());
    // No slug: the owner's newest shared mockup, so a sub never told the slug still finds it.
    let idx = find_idx(&list, &owner, slug);
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
    let composed = compose(&shared.shell, &shared.parts, &shared.controls);
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
        let doc = compose(SHELL, &[part], &[]);
        assert!(doc.contains("<div data-part=\"header\" data-style=\"aurora\" data-photo=\"on\"><h3>Ana</h3></div>"), "{doc}");
        assert!(doc.contains("@scope ([data-part=\"header\"])"), "{doc}");
        assert!(doc.contains("<section class=\"x\" data-part=\"footer\"> </section>"), "an unfilled region stays as the shell wrote it: {doc}");
        assert!(doc.contains("addEventListener(\"message\""), "the control listener is in the page");
        assert!(doc.find("<script>").unwrap() > doc.find("</main>").unwrap());
    }

    #[test]
    fn compose_puts_the_element_click_reporter_in_the_page() {
        let doc = compose(SHELL, &[], &[]);
        assert!(doc.contains("cc:\"element\""), "the page reports an element click to the panel: {doc}");
        assert!(doc.contains("altKey"), "desktop reports on Alt-click: {doc}");
        assert!(doc.contains("touchstart") && doc.contains("500"), "phone reports on a 500ms long-press: {doc}");
        assert!(doc.contains("data-part") && doc.contains("\"shell\""), "no enclosing region reports as the shell: {doc}");
    }

    #[test]
    fn part_css_cannot_close_its_style_block() {
        let part = Part { id: "header".into(), owner_session_id: "s".into(), owner_name: "n".into(), html: String::new(), css: "a{} </STYLE><b>x</b>".into(), controls: vec![] };
        let doc = compose(SHELL, &[part], &[]);
        assert_eq!(doc.matches("</style>").count(), 1, "{doc}");
    }

    #[test]
    fn the_listener_goes_before_the_last_closing_body() {
        let doc = compose("<html><body><div data-part=\"a\"></div></body></html>", &[], &[]);
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

    fn set_layout(path: &Path, st: &DaemonState, sub: &str) -> Value {
        run_at(path, st, "main", &json!({"action": "layout", "slug": "page", "sub": sub}))
    }

    fn recreate(path: &Path, st: &DaemonState, who: &str, shell: &str) -> Value {
        run_at(path, st, who, &json!({"action": "create", "slug": "page", "shell": shell}))
    }

    const SHELL2: &str = "<main><div data-part=\"header\"></div><div data-part=\"side\"></div></main>";

    #[test]
    fn the_layout_sub_re_creates_the_shell_an_ordinary_sub_is_refused_naming_the_layout_sub_and_the_owner_overrides() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        st.registry.set_name("sub-a", "Layouter".to_string());
        let none = recreate(&path, &st, "sub-b", SHELL2);
        assert_eq!(none["ok"], json!(false));
        assert!(none["error"].as_str().unwrap().contains("named none"), "{none}");
        let named = set_layout(&path, &st, "Layouter");
        assert_eq!(named["ok"], json!(true), "{named}");
        assert_eq!(named["layout_session_id"], json!("sub-a"));
        let refused = recreate(&path, &st, "sub-b", SHELL2);
        assert_eq!(refused["ok"], json!(false));
        assert!(refused["error"].as_str().unwrap().contains("Layouter"), "{refused}");
        assert_eq!(load_list(&path)[0].shared.as_ref().unwrap().shell, SHELL, "the refused re-create changed nothing");
        let ok = recreate(&path, &st, "sub-a", SHELL2);
        assert_eq!(ok["ok"], json!(true), "{ok}");
        let snap = &load_list(&path)[0];
        let shared = snap.shared.as_ref().unwrap();
        assert_eq!(shared.shell, SHELL2);
        assert_eq!(shared.owner_session_id, "main", "the owner stays the main chat");
        assert_eq!(shared.layout_session_id.as_deref(), Some("sub-a"), "a re-create keeps the layout sub");
        assert_eq!(snap.session_id.as_deref(), Some("main"));
        assert_eq!(recreate(&path, &st, "main", SHELL)["ok"], json!(true), "the owner keeps its override");
    }

    #[test]
    fn only_the_main_chat_names_a_layout_sub_and_only_one_of_its_own() {
        let (_t, path) = store();
        let st = state();
        create(&path, &st, "main");
        let by_sub = run_at(&path, &st, "sub-a", &json!({"action": "layout", "slug": "page", "sub": "sub-a"}));
        assert_eq!(by_sub["ok"], json!(false), "{by_sub}");
        let foreign = set_layout(&path, &st, "other-sub");
        assert_eq!(foreign["ok"], json!(false), "{foreign}");
        assert!(foreign["error"].as_str().unwrap().contains("not one of your subs"), "{foreign}");
        assert!(load_list(&path)[0].shared.as_ref().unwrap().layout_session_id.is_none());
        assert_eq!(set_layout(&path, &st, "sub-b")["ok"], json!(true), "the session id works too");
    }

    #[test]
    fn a_sub_cannot_create_a_page_that_does_not_exist_even_with_a_layout_claim() {
        let (_t, path) = store();
        let st = state();
        let v = create(&path, &st, "sub-a");
        assert_eq!(v["ok"], json!(false));
        assert!(load_list(&path).is_empty());
    }

    #[test]
    fn shell_controls_compose_onto_the_page_root_and_a_re_create_without_controls_keeps_them() {
        let (_t, path) = store();
        let st = state();
        let made = run_at(&path, &st, "main", &json!({
            "action": "create", "slug": "page", "shell": SHELL,
            "controls": [
                {"id": "density", "label": "Density", "kind": "select", "options": ["roomy", "tight"], "default": "tight"},
                sw("sidebar", true)
            ]
        }));
        assert_eq!(made["ok"], json!(true), "{made}");
        let snap = &load_list(&path)[0];
        assert!(snap.html.starts_with("<main data-cc-root data-density=\"tight\" data-sidebar=\"on\">"), "{}", snap.html);
        assert_eq!(snap.shared.as_ref().unwrap().controls.len(), 2);
        recreate(&path, &st, "main", SHELL);
        assert_eq!(load_list(&path)[0].shared.as_ref().unwrap().controls.len(), 2, "omitted keeps the old controls");
        run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": SHELL, "controls": []}));
        let snap = &load_list(&path)[0];
        assert!(snap.shared.as_ref().unwrap().controls.is_empty() && !snap.html.contains("data-density"));
    }

    #[test]
    fn the_root_is_the_body_when_there_is_one_and_never_a_style_or_comment() {
        let c = [Control { id: "wide".into(), label: "Wide".into(), kind: "switch".into(), options: vec![], default: "off".into() }];
        let doc = compose("<html><head><style>a>b{}</style></head><body class=\"x\"><div data-part=\"a\"></div></body></html>", &[], &c);
        assert!(doc.contains("<body class=\"x\" data-cc-root data-wide=\"off\">"), "{doc}");
        let doc = compose("<!-- c --><style>a{}</style><section><div data-part=\"a\"></div></section>", &[], &c);
        assert!(doc.contains("<section data-cc-root data-wide=\"off\">"), "{doc}");
        assert!(doc.contains("d.part===\"shell\""), "the listener also sets shell controls");
    }

    #[test]
    fn a_region_named_shell_is_refused() {
        let (_t, path) = store();
        let v = run_at(&path, &state(), "main", &json!({"action": "create", "slug": "p", "shell": "<div data-part=\"shell\"></div>"}));
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn a_saved_shell_control_value_survives_a_save_until_its_control_goes() {
        let (_t, path) = store();
        let st = state();
        run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": SHELL, "controls": [sw("sidebar", true)]}));
        let id = load_list(&path)[0].id.clone();
        assert_eq!(crate::daemon::preview::set_state_at(&path, &id, "ctl|shell|sidebar", &json!("off")), Ok(true));
        recreate(&path, &st, "main", SHELL);
        assert_eq!(load_list(&path)[0].view_state.get("ctl|shell|sidebar"), Some(&json!("off")));
        run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": SHELL, "controls": []}));
        assert!(load_list(&path)[0].view_state.get("ctl|shell|sidebar").is_none());
    }
}
