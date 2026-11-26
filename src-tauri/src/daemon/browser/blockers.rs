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
    /// Came from a URL rule (the page or a tab), so a tab list alone can show it gone.
    pub via_url: bool,
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
    /// The tool reported an error (`isError`): its text is a message, not a page.
    is_error: bool,
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
            is_error: result["isError"] == json!(true),
        }
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
    Blocker { kind, site: site_name(host), url: shown, origin: host.to_string(), via_url: false }
}

/// URL rules: the pages whose whole purpose is a sign-in or a second step.
fn url_rule(url: &str) -> Option<Blocker> {
    let (host, path) = host_and_path(url)?;
    let lower = path.to_ascii_lowercase();
    let on = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    let kind = if host == "accounts.google.com" {
        if lower.starts_with("/challenge") || lower.starts_with("/v3/signin/challenge") {
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
    } else if host == "login.microsoftonline.com" {
        if lower.contains("logout") {
            return None;
        }
        Kind::SignIn
    } else if host == "appleid.apple.com" {
        // The signed-in account pages live on the same host.
        if lower == "/" || lower.is_empty() || lower.starts_with("/sign-in") || lower.starts_with("/auth") {
            Kind::SignIn
        } else {
            return None;
        }
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
    Some(Blocker { via_url: true, ..blocker(kind, &host, &path) })
}

/// Frames that only show up while a challenge is live: a frame from one of
/// these hosts is enough.
const LIVE_CHALLENGE_HOSTS: [&str; 2] = ["arkoselabs", "funcaptcha"];
/// Frames that also sit invisibly on ordinary pages (reCAPTCHA v3 badge, passive
/// Turnstile): a frame from one of these counts only beside a visible challenge.
/// "cloudflare" alone because Playwright prints a frame's title, not its src.
const PASSIVE_CAPTCHA_HOSTS: [&str; 3] = ["recaptcha", "hcaptcha", "cloudflare"];
/// A checkbox or prompt the visitor has to act on.
const VISIBLE_CHALLENGE: [&str; 6] = ["not a robot", "verify you are human", "verify you are a human", "select all images", "press and hold", "i am human"];

/// Wording that sits beside a code box on a second-step page.
const TWO_STEP_PHRASES: [&str; 9] = [
    "2-step verification",
    "2 step verification",
    "two-step",
    "two-factor",
    "authenticator",
    "enter the code",
    "verification code",
    "verify it's you",
    "verify it’s you",
];
/// Narrower wording: enough on its own to read an unnamed text box as a code box.
const TWO_STEP_STRONG: [&str; 7] = [
    "2-step verification",
    "2 step verification",
    "two-step",
    "two-factor",
    "authenticator app",
    "6-digit",
    "verify it's you",
];
/// A card form's or a coupon box's "code" is not a second step.
const NOT_A_CODE: [&str; 9] = ["security code", "cvv", "cvc", "promo", "coupon", "discount", "gift", "zip", "postal"];
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

/// Words that make a "code" box something other than a second step.
const NOT_A_CODE_WORDS: [&str; 6] = ["country", "area", "source", "referral", "invite", "dial"];
/// Wording that asks the visitor to type a code, beside which an unnamed box is the code box.
const ENTER_PROMPTS: [&str; 5] = ["6-digit", "enter the code", "enter code", "enter your code", "verification code"];

/// `strong_wording`: the page has narrow two-step wording and asks for a code, so
/// a box with no accessible name (Roblox's) may be the code box too.
fn is_code_field(f: &Field, strong_wording: bool) -> bool {
    let words: Vec<&str> = f.name.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    if f.role == "searchbox" || NOT_A_CODE.iter().any(|w| f.name.contains(w)) || words.iter().any(|w| NOT_A_CODE_WORDS.contains(w)) {
        return false;
    }
    if f.name.is_empty() {
        return strong_wording;
    }
    // Whole words: "otp" inside "footprint" or "digit" inside "digital" is not a code box.
    words.iter().any(|w| ["code", "otp", "verification", "authenticator"].contains(w))
}

fn is_login_password_field(f: &Field) -> bool {
    f.role == "textbox"
        && (f.name.contains("password") || f.name.contains("passcode"))
        && !["new", "confirm", "current", "repeat", "old", "retype"].iter().any(|w| f.name.contains(w))
}

/// Whether an `- iframe` line, or a line nested under one, names one of `hosts`.
/// A link elsewhere on the page to arkoselabs.com is not a frame.
fn frame_names(lower: &str, hosts: &[&str]) -> bool {
    // Indents of the frames the current line sits inside: a nested frame must not
    // end its parent.
    let mut open: Vec<usize> = Vec::new();
    for l in lower.lines() {
        let trimmed = l.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let indent = l.len() - trimmed.len();
        while open.last().is_some_and(|&fi| indent <= fi) {
            open.pop();
        }
        if trimmed.starts_with("- iframe") {
            open.push(indent);
        }
        if !open.is_empty() && hosts.iter().any(|h| trimmed.contains(h)) {
            return true;
        }
    }
    false
}

fn captcha_frame(lower: &str) -> bool {
    if frame_names(lower, &LIVE_CHALLENGE_HOSTS) {
        return true;
    }
    // The prompt must be an element of the page, not a sentence in a paragraph.
    let prompt_element = lower.lines().any(|l| {
        let l = l.trim_start();
        (l.starts_with("- checkbox") || l.starts_with("- button")) && VISIBLE_CHALLENGE.iter().any(|w| l.contains(w))
    });
    // A page's own "I am human" button beside a "protected by reCAPTCHA" footer is
    // not a challenge: the passive host has to be a frame.
    prompt_element && frame_names(lower, &PASSIVE_CAPTCHA_HOSTS)
}

/// Decides whether the page in `result` waits on Joe.
pub fn detect(result: &Value) -> Verdict {
    detect_page(&Page::parse(result))
}

fn detect_page(page: &Page) -> Verdict {
    let host = page.url.as_deref().and_then(host_and_path);
    let here = host.as_ref().map(|(h, p)| (h.as_str(), p.as_str()));

    // Only from an error or a short message: the same sentence sits in console
    // output, docs and issue threads a normal page can show.
    let message_like = page.is_error || page.text.len() < 600;
    if message_like && (page.lower.contains("chrome-extension:// url of different extension") || page.lower.contains("held_by_extension")) {
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
    let strong_wording = TWO_STEP_STRONG.iter().any(|w| page.lower.contains(w)) && ENTER_PROMPTS.iter().any(|w| page.lower.contains(w));
    if inputs.iter().any(|f| is_code_field(f, strong_wording)) && TWO_STEP_PHRASES.iter().any(|w| page.lower.contains(w)) {
        return Verdict::Block(blocker(Kind::TwoStep, h, p));
    }
    // A generic sign-in form is a note, not a block: a chat that holds the
    // credentials (a captured secret, Joe's say-so) signs in on it itself, and
    // the sites that always need Joe are covered by `url_rule`.
    if inputs.iter().any(is_login_password_field) && SIGN_IN_PHRASES.iter().any(|w| page.lower.contains(w)) {
        return Verdict::Note(
            "Note: this page has a sign-in form. If you do not hold the credentials for it, stop and ask Joe with ask_user_question instead of guessing.".to_string(),
        );
    }

    if let Some(word) = WEAK_WORDS.iter().find(|w| page.lower.contains(**w)) {
        return Verdict::Note(format!(
            "Note: this page mentions \"{word}\" but no sign-in field, CAPTCHA frame or code box was found. If it is waiting on Joe, stop and ask him with ask_user_question."
        ));
    }
    Verdict::Clear
}

/// How the gate treats a call while a chat is blocked.
#[derive(PartialEq)]
enum Class {
    /// Reads the page: the chat's two looks, and what notices that Joe finished.
    Look,
    /// Never refused and never counted: tab management (so a stale sign-in tab can
    /// be closed), diagnostics that say nothing about the page, and
    /// `browser_evaluate`, whose result is a script's own output that
    /// `capture_secret_from_page` parses and a text part in front would break.
    Free,
    Act,
}

fn classify(tool: &str) -> Class {
    match tool {
        "browser_snapshot" => Class::Look,
        "browser_take_screenshot" | "browser_console_messages" | "browser_network_requests" | "browser_network_request" | "browser_tabs" | "browser_evaluate" => Class::Free,
        _ => Class::Act,
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

/// Lifts `session`'s block when `page` shows it gone. A `Page URL` line says what
/// the chat is looking at now; a tab list alone says only which tabs are open, so
/// it lifts a block that came from a tab's URL and never one from the page's
/// content (a CAPTCHA, a code box), which a tab list cannot show gone.
fn lift_if_gone(held: &mut HashMap<String, Held>, session: &str, page: &Page) {
    let gone = held.get(session).is_some_and(|h| page.url.is_some() || (h.via_url && !page.tabs.is_empty()));
    if gone {
        held.remove(session);
    }
}

struct Held {
    kind: Kind,
    origin: String,
    via_url: bool,
    message: String,
    raised_at: Instant,
    reads_left: u8,
}

/// Per-chat blocks. A std mutex: nothing here awaits while it is held.
#[derive(Default)]
pub struct Gate {
    held: Mutex<HashMap<String, Held>>,
    /// (chat, origin, kind) a card answer settled, and when, so the same wall
    /// on the same site does not gate again in that chat for `HANDLED_FOR`
    /// (a session that expires later is a new wall).
    handled: Mutex<HashMap<(String, String, Kind), Instant>>,
}

const HANDLED_FOR: Duration = Duration::from_secs(30 * 60);

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
    pub fn before(&self, session: &str, tool: &str, answered_at: Option<Instant>, now: Instant) -> Option<Value> {
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
            // An empty origin (a result with no Page URL) names no site, so it settles nothing later.
            if !h.origin.is_empty() {
                self.handled.lock().unwrap_or_else(|p| p.into_inner()).insert((session.to_string(), h.origin, h.kind), now);
            }
            return None;
        }
        match classify(tool) {
            Class::Free => return None,
            Class::Look if h.reads_left > 0 => {
                h.reads_left -= 1;
                return None;
            }
            _ => {}
        }
        Some(text_result(format!("{} This call was not run.", h.message), true))
    }

    /// Reads a finished call's result: raises, keeps or lifts the chat's block
    /// and adds the `BLOCKED ON JOE` or note text part.
    pub fn after(&self, session: &str, tool: &str, result: &mut Value, now: Instant) {
        // A script's own output is not a page description, and a text part in front
        // of it would break the caller that parses it (`secret_capture`).
        if tool == "browser_evaluate" {
            return;
        }
        let page = Page::parse(result);
        let verdict = detect_page(&page);
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        match verdict {
            Verdict::Block(b) => {
                let handled = !b.origin.is_empty()
                    && self
                        .handled
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .get(&(session.to_string(), b.origin.clone(), b.kind))
                        .is_some_and(|at| now.saturating_duration_since(*at) < HANDLED_FOR);
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
                            Held {
                                kind: b.kind,
                                origin: b.origin.clone(),
                                via_url: b.via_url,
                                message: message.clone(),
                                raised_at: now,
                                reads_left: FREE_READS,
                            },
                        );
                    }
                }
                prepend_text(result, &message);
            }
            Verdict::Note(note) => {
                lift_if_gone(&mut held, session, &page);
                append_text(result, &note);
            }
            Verdict::Clear => lift_if_gone(&mut held, session, &page),
        }
    }

    /// A call that failed because the password manager holds the tab. The
    /// chat gets the blocker instead of a bare "target closed" style error.
    pub fn after_err(&self, session: &str, error: &str, now: Instant) -> Option<Value> {
        let mut result = text_result(error.to_string(), true);
        if !matches!(detect_page(&Page::parse(&result)), Verdict::Block(_)) {
            return None;
        }
        self.after(session, "", &mut result, now);
        Some(result)
    }

    /// Forgets chats that are gone, so neither map grows for the daemon's lifetime.
    pub fn prune(&self, live: &HashSet<String>) {
        self.held.lock().unwrap_or_else(|p| p.into_inner()).retain(|id, _| live.contains(id));
        self.handled.lock().unwrap_or_else(|p| p.into_inner()).retain(|(id, _, _), _| live.contains(id));
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
