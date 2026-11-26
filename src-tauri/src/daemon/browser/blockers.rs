//! "Blocked on Joe" detector and gate for the `browser_*` tools.
//!
//! A sign-in window, a CAPTCHA, an authenticator code box: a page that only
//! Joe can get past. Before this module the only guard was a paragraph in two
//! tool descriptions, so a chat could keep retrying against a page that was
//! asking Joe for a code. `detect` reads Playwright's own result text (Page
//! URL, open-tabs list, snapshot YAML) and says whether the page waits on Joe;
//! `Gate` turns a strong hit into a `BLOCKED ON JOE` text part on the result
//! and refuses the chat's next calls until the page changes or the chat's
//! question card is answered.
//!
//! Only strong signals gate: a known sign-in URL, a CAPTCHA frame, a code box
//! beside two-step wording, a password box on a sign-in form, a tab held by
//! the password manager's frame. A word alone ("captcha", "sign in to
//! continue") rides along as a note and never blocks, because a text-only
//! gate would refuse a blog post about passwords.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

/// Read-only calls that still run after a block, so the chat can look at the
/// page (and the gate can see that Joe finished) before further calls are refused.
const FREE_READS: u8 = 2;
/// A block nobody lifted: the chat's card was never raised or the page never
/// re-read. Calls run again so a chat cannot stay refused forever.
const STALE_AFTER: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    SignIn,
    TwoStep,
    Captcha,
    PasswordManager,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Blocker {
    pub kind: Kind,
    /// Site name for the message ("Roblox"), empty when unknown.
    pub site: String,
    /// Host and path only: a query string can carry a token.
    pub url: String,
    /// Host the block is keyed on, so "handled" covers that site only.
    pub origin: String,
}

impl Blocker {
    pub fn message(&self) -> String {
        let site = if self.site.is_empty() { "This page" } else { &self.site };
        let what = match self.kind {
            Kind::SignIn => format!("{site} is waiting for Joe to sign in"),
            Kind::TwoStep => format!("{site} is asking Joe for a verification code"),
            Kind::Captcha => format!("{site} shows a CAPTCHA only Joe can solve"),
            Kind::PasswordManager => "Joe's password manager menu is open on this page".to_string(),
        };
        let at = if self.url.is_empty() { String::new() } else { format!(" ({})", self.url) };
        format!(
            "BLOCKED ON JOE: {what}{at}. Stop browser calls on this page. Ask Joe with ask_user_question, then continue in this same tab."
        )
    }
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Clear,
    /// Words only: shown to the chat, never gates.
    Note(String),
    Block(Blocker),
}

/// The parts of one Playwright result the detector reads.
#[derive(Debug, Default)]
struct Page {
    /// `- Page URL:` line, when the result has one.
    url: Option<String>,
    /// Every URL of the open-tabs list.
    tabs: Vec<String>,
    /// The whole result text, lowercased.
    lower: String,
    text: String,
}

impl Page {
    fn parse(result: &Value) -> Page {
        let text = result_text(result);
        static URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*-?\s*Page URL:\s*(\S+)").unwrap());
        static TAB: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*- \d+: (?:\(current\) )?\[.*\]\((\S+?)\)\s*$").unwrap());
        Page {
            url: URL.captures(&text).map(|c| c[1].to_string()),
            tabs: TAB.captures_iter(&text).map(|c| c[1].to_string()).collect(),
            lower: text.to_lowercase(),
            text,
        }
    }

    /// Whether the result says anything about which page the chat is on, so a
    /// result without it (a console read) cannot be taken as "the page changed".
    fn describes_a_page(&self) -> bool {
        self.url.is_some() || !self.tabs.is_empty()
    }
}

fn result_text(result: &Value) -> String {
    result["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn host_and_path(url: &str) -> Option<(String, String)> {
    let u = url::Url::parse(url).ok()?;
    Some((u.host_str()?.to_ascii_lowercase(), u.path().to_string()))
}

fn site_name(host: &str) -> String {
    let labels: Vec<&str> = host.trim_start_matches("www.").split('.').collect();
    let main = if labels.len() >= 2 { labels[labels.len() - 2] } else { labels[0] };
    match main {
        "google" => "Google".into(),
        "paypal" => "PayPal".into(),
        "microsoftonline" | "live" | "microsoft" => "Microsoft".into(),
        "apple" => "Apple".into(),
        "roblox" => "Roblox".into(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

fn blocker(kind: Kind, host: &str, path: &str) -> Blocker {
    let shown: String = format!("{host}{path}").chars().take(80).collect();
    Blocker { kind, site: site_name(host), url: shown, origin: host.to_string() }
}

/// URL rules: the pages whose whole purpose is a sign-in or a second step.
fn url_rule(url: &str) -> Option<Blocker> {
    let (host, path) = host_and_path(url)?;
    let lower = path.to_ascii_lowercase();
    let on = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    let kind = if host == "accounts.google.com" {
        if lower.starts_with("/challenge") {
            Kind::TwoStep
        } else if ["/signin", "/v3/signin", "/o/oauth2", "/servicelogin"].iter().any(|p| lower.starts_with(p)) {
            Kind::SignIn
        } else {
            return None;
        }
    } else if on("paypal.com") {
        if ["/signin", "/checkoutnow", "/webapps/hermes"].iter().any(|p| lower.starts_with(p)) {
            Kind::SignIn
        } else {
            return None;
        }
    } else if host == "login.microsoftonline.com" || host == "appleid.apple.com" {
        Kind::SignIn
    } else if on("roblox.com") {
        if lower.contains("two-step") || lower.contains("2sv") {
            Kind::TwoStep
        } else if lower.starts_with("/login") {
            Kind::SignIn
        } else {
            return None;
        }
    } else {
        return None;
    };
    Some(blocker(kind, &host, &path))
}

const CAPTCHA_HOSTS: [&str; 5] = ["recaptcha", "hcaptcha", "challenges.cloudflare.com", "arkoselabs", "funcaptcha"];
const CAPTCHA_WIDGETS: [&str; 4] = ["i'm not a robot", "i’m not a robot", "verify you are human", "verify you are a human"];

/// Wording that sits beside a code box on a second-step page.
const TWO_STEP_PHRASES: [&str; 12] = [
    "2-step verification",
    "2 step verification",
    "two-step",
    "two-factor",
    "authenticator",
    "enter the code",
    "enter code",
    "verification code",
    "security code",
    "verify it's you",
    "verify it’s you",
    "6-digit",
];
const SIGN_IN_PHRASES: [&str; 5] = ["sign in", "log in", "login", "forgot password", "forgot your password"];

/// Words alone. Narrow on purpose: every page has a "Sign in" link.
const WEAK_WORDS: [&str; 10] = [
    "captcha",
    "i'm not a robot",
    "verify you are human",
    "unusual traffic",
    "verification code",
    "enter the code",
    "sign in to continue",
    "log in to continue",
    "please sign in",
    "please log in",
];

struct Field<'a> {
    role: &'a str,
    name: String,
}

/// The snapshot's input lines (`- textbox "Name" [ref=e3]`).
fn fields(text: &str) -> Vec<Field<'_>> {
    static LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?m)^\s*- (textbox|spinbutton|searchbox)\b([^\n]*)$"#).unwrap());
    static NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r#""([^"]*)""#).unwrap());
    LINE.captures_iter(text)
        .map(|c| {
            let role = c.get(1).map_or("", |m| m.as_str());
            let name = NAME.captures(c.get(2).map_or("", |m| m.as_str())).map(|n| n[1].to_lowercase()).unwrap_or_default();
            Field { role, name }
        })
        .collect()
}

fn is_code_field(f: &Field) -> bool {
    if f.role == "searchbox" {
        return false;
    }
    f.name.is_empty() || ["code", "otp", "digit", "verif", "authenticat"].iter().any(|w| f.name.contains(w))
}

fn is_login_password_field(f: &Field) -> bool {
    f.role == "textbox"
        && (f.name.contains("password") || f.name.contains("passcode"))
        && !["new", "confirm", "current", "repeat", "old", "retype"].iter().any(|w| f.name.contains(w))
}

fn captcha_frame(lower: &str) -> bool {
    CAPTCHA_WIDGETS.iter().any(|w| lower.contains(w))
        || lower.lines().any(|l| {
            let framed = l.contains("iframe") || l.contains("/url:") || l.contains("src=");
            framed && CAPTCHA_HOSTS.iter().any(|h| l.contains(h))
        })
}

/// Decides whether the page in `result` waits on Joe.
pub fn detect(result: &Value) -> Verdict {
    detect_page(&Page::parse(result))
}

fn detect_page(page: &Page) -> Verdict {
    let host = page.url.as_deref().and_then(host_and_path);
    let here = host.as_ref().map(|(h, p)| (h.as_str(), p.as_str()));

    if page.lower.contains("chrome-extension:// url of different extension") || page.lower.contains("held_by_extension") {
        let (h, p) = here.unwrap_or(("", ""));
        let mut b = blocker(Kind::PasswordManager, h, p);
        b.site = String::new();
        if h.is_empty() {
            b.url = String::new();
        }
        return Verdict::Block(b);
    }

    // The current page first, then any other open tab: a Google or PayPal
    // popup is attached as a tab the chat was never told about.
    for url in page.url.iter().chain(page.tabs.iter()) {
        if let Some(b) = url_rule(url) {
            return Verdict::Block(b);
        }
    }

    let (h, p) = here.unwrap_or(("", ""));
    if captcha_frame(&page.lower) {
        return Verdict::Block(blocker(Kind::Captcha, h, p));
    }

    let inputs = fields(&page.text);
    if inputs.iter().any(is_code_field) && TWO_STEP_PHRASES.iter().any(|w| page.lower.contains(w)) {
        return Verdict::Block(blocker(Kind::TwoStep, h, p));
    }
    if inputs.iter().any(is_login_password_field) && SIGN_IN_PHRASES.iter().any(|w| page.lower.contains(w)) {
        return Verdict::Block(blocker(Kind::SignIn, h, p));
    }

    if let Some(word) = WEAK_WORDS.iter().find(|w| page.lower.contains(**w)) {
        return Verdict::Note(format!(
            "Note: this page mentions \"{word}\" but no sign-in field, CAPTCHA frame or code box was found. If it is waiting on Joe, stop and ask him with ask_user_question."
        ));
    }
    Verdict::Clear
}

/// `browser_*` calls that only look, so a chat can re-read a blocked page.
fn is_read_only(tool: &str, args: &Value) -> bool {
    match tool {
        "browser_snapshot" | "browser_take_screenshot" | "browser_console_messages" | "browser_network_requests" | "browser_network_request" => true,
        "browser_tabs" => args["action"].as_str().is_none_or(|a| a == "list"),
        _ => false,
    }
}

fn text_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn prepend_text(result: &mut Value, text: &str) {
    if let Some(parts) = result["content"].as_array_mut() {
        parts.insert(0, json!({ "type": "text", "text": text }));
    } else {
        *result = text_result(text.to_string(), false);
    }
}

fn append_text(result: &mut Value, text: &str) {
    if let Some(parts) = result["content"].as_array_mut() {
        parts.push(json!({ "type": "text", "text": text }));
    }
}

struct Held {
    kind: Kind,
    origin: String,
    message: String,
    raised_at: Instant,
    reads_left: u8,
}

/// Per-chat blocks. A std mutex: nothing here awaits while it is held.
#[derive(Default)]
pub struct Gate {
    held: Mutex<HashMap<String, Held>>,
    /// (chat, origin, kind) a card answer or a finished page already settled,
    /// so the same wall on the same site does not gate again in that chat.
    handled: Mutex<HashSet<(String, String, Kind)>>,
}

/// When each chat last had a question card settled. Written by
/// `DaemonState::remove_prompt`, read by the gate: the browser module has no
/// handle on the daemon state.
static CARD_ANSWERS: Lazy<Mutex<HashMap<String, Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// `session_id`'s question card was answered, skipped or dropped just now.
pub fn note_card_answered(session_id: &str) {
    if let Ok(mut m) = CARD_ANSWERS.lock() {
        m.insert(session_id.to_string(), Instant::now());
    }
}

pub fn card_answered_at(session_id: &str) -> Option<Instant> {
    CARD_ANSWERS.lock().ok()?.get(session_id).copied()
}

impl Gate {
    /// Runs before a call. `Some(result)` is the refusal to return in place of
    /// running the call.
    pub fn before(&self, session: &str, tool: &str, args: &Value, answered_at: Option<Instant>, now: Instant) -> Option<Value> {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        let h = held.get_mut(session)?;
        if tool == "browser_close" {
            held.remove(session);
            return None;
        }
        if now.saturating_duration_since(h.raised_at) > STALE_AFTER {
            held.remove(session);
            return None;
        }
        if answered_at.is_some_and(|a| a > h.raised_at) {
            let h = held.remove(session)?;
            self.handled.lock().unwrap_or_else(|p| p.into_inner()).insert((session.to_string(), h.origin, h.kind));
            return None;
        }
        if is_read_only(tool, args) && h.reads_left > 0 {
            h.reads_left -= 1;
            return None;
        }
        Some(text_result(format!("{} This call was not run.", h.message), true))
    }

    /// Reads a finished call's result: raises, keeps or lifts the chat's block
    /// and adds the `BLOCKED ON JOE` or note text part.
    pub fn after(&self, session: &str, result: &mut Value, now: Instant) {
        let page = Page::parse(result);
        let verdict = detect_page(&page);
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        match verdict {
            Verdict::Block(b) => {
                let handled = self.handled.lock().unwrap_or_else(|p| p.into_inner()).contains(&(session.to_string(), b.origin.clone(), b.kind));
                if handled {
                    held.remove(session);
                    return;
                }
                let message = b.message();
                match held.get_mut(session) {
                    Some(h) if h.kind == b.kind && h.origin == b.origin => h.message = message.clone(),
                    _ => {
                        held.insert(
                            session.to_string(),
                            Held { kind: b.kind, origin: b.origin.clone(), message: message.clone(), raised_at: now, reads_left: FREE_READS },
                        );
                    }
                }
                prepend_text(result, &message);
            }
            Verdict::Note(note) => {
                if page.describes_a_page() {
                    held.remove(session);
                }
                append_text(result, &note);
            }
            Verdict::Clear => {
                if page.describes_a_page() {
                    held.remove(session);
                }
            }
        }
    }

    /// A call that failed because the password manager holds the tab. The
    /// chat gets the blocker instead of a bare "target closed" style error.
    pub fn after_err(&self, session: &str, error: &str, now: Instant) -> Option<Value> {
        let mut result = text_result(error.to_string(), true);
        if !matches!(detect_page(&Page::parse(&result)), Verdict::Block(_)) {
            return None;
        }
        self.after(session, &mut result, now);
        Some(result)
    }

    /// Forgets chats that are gone, so neither map grows for the daemon's lifetime.
    pub fn prune(&self, live: &HashSet<String>) {
        self.held.lock().unwrap_or_else(|p| p.into_inner()).retain(|id, _| live.contains(id));
        self.handled.lock().unwrap_or_else(|p| p.into_inner()).retain(|(id, _, _)| live.contains(id));
        if let Ok(mut m) = CARD_ANSWERS.lock() {
            m.retain(|id, _| live.contains(id));
        }
    }

    #[cfg(test)]
    fn is_held(&self, session: &str) -> bool {
        self.held.lock().unwrap().contains_key(session)
    }
}

#[cfg(test)]
mod tests;
