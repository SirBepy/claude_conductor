//! The limits `send_message` and `update_message` enforce on a body: detail
//! blocks, per-kind caps, which kinds take which fields. The route in
//! `messages/mod.rs` turns an `Err` into an `ok:false` reply.

use super::{Detail, SendMessageBody};

const MAX_DETAILS: usize = 6;
const MAX_DETAIL_BODY: usize = 4096;

fn valid_detail_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Mirrors the limits in the tool schema; the model may not honour a schema, so
/// the route enforces them too.
pub(super) fn validate_details(details: &[Detail]) -> Result<(), String> {
    if details.len() > MAX_DETAILS {
        return Err(format!("details has more than {MAX_DETAILS} items"));
    }
    let mut seen = std::collections::HashSet::new();
    for d in details {
        if !valid_detail_id(&d.id) {
            return Err(format!("detail id \"{}\" must match ^[a-z0-9-]{{1,32}}$", d.id));
        }
        if !seen.insert(d.id.as_str()) {
            return Err(format!("detail id \"{}\" is used twice", d.id));
        }
        if d.body_md.chars().count() > MAX_DETAIL_BODY {
            return Err(format!("detail \"{}\" body_md exceeds {MAX_DETAIL_BODY} chars", d.id));
        }
    }
    Ok(())
}

pub(super) const KINDS: [&str; 12] = [
    "answer", "report", "blocker", "do_this", "plan", "rating", "correction", "call", "handoff",
    "artifact", "discovery", "ack",
];
const MAX_VERDICT: usize = 40;
const MAX_POINTS: usize = 6;
const MAX_POINT: usize = 200;
const MAX_ROWS: usize = 8;
const MAX_ROW: usize = 120;
const MAX_WAS: usize = 100;
const MAX_COPY: usize = 4000;
const MAX_QUESTION: usize = 200;

/// How long a kind's `text` may be. Past the cap the prose belongs in `details`,
/// which sits behind a click; the card shows `text` at full size.
pub(super) fn text_cap(kind: &str) -> usize {
    match kind {
        "ack" => 80,
        "report" => 200,
        "answer" => 400,
        _ => 300,
    }
}

/// `plan`, `handoff`, `artifact` and `ack` carry no verdict: their verdicts
/// tested as filler ("Plan ready"), so the card reads better without one.
fn takes_verdict(kind: &str) -> bool {
    !matches!(kind, "plan" | "handoff" | "artifact" | "ack")
}

fn kind_rejection(got: Option<&str>) -> String {
    let list = KINDS.join(", ");
    match got {
        None => format!(
            "kind is required: send_message declares what each message is. Resend with kind set to one of: {list}. Most kinds also need a verdict (at most {MAX_VERDICT} chars, the conclusion as a person would say it)."
        ),
        Some(k) => format!("kind \"{k}\" is not a kind. Resend with kind set to one of: {list}."),
    }
}

fn check_rows(name: &str, rows: &Option<Vec<String>>, max_items: usize, max_len: usize) -> Result<(), String> {
    let Some(rows) = rows else { return Ok(()) };
    if rows.len() > max_items {
        return Err(format!("{name} has {} items, over {max_items}: keep the most important", rows.len()));
    }
    for r in rows {
        let n = r.chars().count();
        if n > max_len {
            return Err(format!("a {name} item is {n} chars, over {max_len}: shorten it"));
        }
    }
    Ok(())
}

/// Verbs a status line opens with ("Committing the removal"). A word list rather
/// than "ends in -ing", which would refuse "Nothing to commit" and "Missing
/// field". Verbs that also start a noun phrase in a finished result (running,
/// building, checking, reading, testing, working, looking, updating: "Working
/// tree clean", "Building on Windows fails") are left out, so a real result is
/// never refused for its first word.
const PROGRESS_VERBS: &[&str] = &[
    "committing", "writing", "editing", "fixing", "starting", "adding", "removing", "pushing",
    "searching", "researching", "installing", "applying", "creating", "deleting", "fetching",
    "implementing", "pulling", "merging", "rebasing", "refactoring", "verifying", "investigating",
    "rebuilding", "compiling", "restarting", "deploying", "wiring", "renaming",
];

fn bare(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase()
}

fn is_progress_verb(word: &str) -> bool {
    PROGRESS_VERBS.contains(&bare(word).as_str())
}

/// Whether `verdict` or the opening of `text` reads as "what Claude is doing
/// right now", not a result. Shapes seen in real chats: a verdict that opens
/// with a progress verb, optionally after "Now" or "Next:" ("Committing the
/// removal"), a verdict that ends "<verb> next" or "<verb> now" ("Button
/// removed, committing next"), and a text that opens "Claude is (now) <verb>".
fn reads_as_progress(verdict: Option<&str>, text: &str) -> bool {
    if let Some(v) = verdict {
        let words: Vec<&str> = v.split_whitespace().collect();
        let lead = words.iter().position(|w| !matches!(bare(w).as_str(), "now" | "next")).unwrap_or(words.len());
        if words.get(lead).is_some_and(|w| is_progress_verb(w)) {
            return true;
        }
        if words.len() >= 2
            && matches!(bare(words[words.len() - 1]).as_str(), "next" | "now")
            && is_progress_verb(words[words.len() - 2])
        {
            return true;
        }
    }
    let mut words = text.split_whitespace();
    if words.next().is_some_and(|w| bare(w) == "claude") && words.next().is_some_and(|w| bare(w) == "is") {
        let after = match words.next() {
            Some(w) if bare(w) == "now" => words.next(),
            other => other,
        };
        return after.is_some_and(is_progress_verb);
    }
    false
}

/// Mirrors the limits in the `send_message` tool schema; the model may not honour
/// a schema, so the route enforces them too. Every error names the fix, because
/// the model reads it as the tool result and retries.
pub(super) fn validate_send(body: &SendMessageBody) -> Result<(), String> {
    let kind = match body.kind.as_deref().map(str::trim) {
        Some(k) if KINDS.contains(&k) => k,
        other => return Err(kind_rejection(other)),
    };
    let text = body.text.trim();
    if text.is_empty() {
        return Err("text must not be empty".to_string());
    }
    let (n, cap) = (text.chars().count(), text_cap(kind));
    if n > cap {
        return Err(format!("text is {n} chars, over {kind}'s {cap}: move detail into details"));
    }

    let verdict = body.verdict.as_deref().map(str::trim).filter(|v| !v.is_empty());
    match (takes_verdict(kind), verdict) {
        (true, None) => {
            return Err(format!(
                "{kind} needs a verdict (at most {MAX_VERDICT} chars): the conclusion as a person would say it out loud, like \"Built, not pushed\""
            ))
        }
        (false, Some(_)) => {
            return Err(format!("{kind} takes no verdict: remove it, the text carries the message"))
        }
        (true, Some(v)) if v.chars().count() > MAX_VERDICT => {
            return Err(format!(
                "verdict is {} chars, over {MAX_VERDICT}: say the conclusion shorter",
                v.chars().count()
            ))
        }
        _ => {}
    }

    if matches!(kind, "answer" | "report" | "discovery") && reads_as_progress(verdict, text) {
        return Err(format!(
            "this {kind} reads as a progress update (it says what Claude is doing, not what came out). Progress goes in write_plan, which draws a live checklist; send no message for it. Send a message only for a result: resend when the work is done, with a verdict that states the outcome (\"Removed and committed\", not \"Committing the removal\"). If Joe asked what you are doing, answer with the state reached (\"Two of three steps done\")."
        ));
    }

    if let Some(t) = body.tone.as_deref() {
        if !matches!(t, "good" | "bad" | "neutral") {
            return Err(format!("tone \"{t}\" is not valid: use good, bad or neutral, or leave it out"));
        }
    }
    if kind == "ack" && body.points.is_some() {
        return Err("ack takes no points: it is a bare acknowledgement".to_string());
    }
    check_rows("points", &body.points, MAX_POINTS, MAX_POINT)?;

    let report_rows = [
        ("done", &body.done),
        ("not_done", &body.not_done),
        ("waiting_on", &body.waiting_on),
        ("your_move", &body.your_move),
    ];
    for (name, rows) in report_rows {
        // A blocker may also name what it waits on when that is not Joe (a sub, a
        // CI run): the dashboard then keeps it out of "Waiting on you".
        let allowed = kind == "report" || (name == "waiting_on" && kind == "blocker");
        if rows.is_some() && !allowed {
            let only = if name == "waiting_on" { "report or blocker" } else { "report" };
            return Err(format!("{name} is only for {only}, not {kind}: remove it"));
        }
        check_rows(name, rows, MAX_ROWS, MAX_ROW)?;
    }

    if let Some(was) = body.was.as_deref() {
        if kind != "correction" {
            return Err(format!("was is only for correction, not {kind}: remove it"));
        }
        let n = was.chars().count();
        if n > MAX_WAS {
            return Err(format!("was is {n} chars, over {MAX_WAS}: quote the earlier claim shorter"));
        }
    }
    if let Some(visuals) = body.visuals.as_deref() {
        if kind == "ack" {
            return Err("ack takes no visuals: it is a bare acknowledgement".to_string());
        }
        crate::daemon::hooks_server::visuals::validate_visuals(visuals)?;
    }
    if let Some(copy) = body.copy.as_deref() {
        if kind != "do_this" {
            return Err(format!("copy is only for do_this, not {kind}: remove it"));
        }
        let n = copy.chars().count();
        if n > MAX_COPY {
            return Err(format!("copy is {n} chars, over {MAX_COPY}: trim the paste-ready payload"));
        }
    }
    if let Some(q) = body.question.as_deref() {
        if kind != "answer" {
            return Err(format!("question is only for answer, not {kind}: remove it"));
        }
        let n = q.trim().chars().count();
        if n == 0 {
            return Err("question is empty: write Joe's question as one clear question, or leave it out".to_string());
        }
        if n > MAX_QUESTION {
            return Err(format!("question is {n} chars, over {MAX_QUESTION}: ask it shorter"));
        }
    }
    if let Some(read) = body.read_answers.as_deref() {
        if read.len() > MAX_ROWS {
            return Err(format!("read_answers has {} items, over {MAX_ROWS}: list only the answers his message shows he read", read.len()));
        }
        for v in read {
            let n = v.trim().chars().count();
            if n == 0 {
                return Err("read_answers has an empty item: copy each answer's verdict, or leave the field out".to_string());
            }
            if n > MAX_VERDICT {
                return Err(format!("read_answers item is {n} chars, over {MAX_VERDICT}: copy the answer's verdict exactly, not its text"));
            }
        }
    }
    Ok(())
}

/// The parts of a `report` that `finish_subchat` carries. Validated with
/// `send_message`'s own limits so the two tools cannot drift on what a report is.
#[derive(Default)]
pub(in crate::daemon::hooks_server) struct ReportFields {
    pub text: String,
    pub verdict: Option<String>,
    pub tone: Option<String>,
    pub points: Option<Vec<String>>,
    pub done: Option<Vec<String>>,
    pub not_done: Option<Vec<String>>,
    pub waiting_on: Option<Vec<String>>,
    pub your_move: Option<Vec<String>>,
}

/// `validate_send` for a message of kind `report` built from `f`.
pub(in crate::daemon::hooks_server) fn validate_report(f: ReportFields) -> Result<(), String> {
    validate_send(&SendMessageBody {
        text: f.text,
        kind: Some("report".to_string()),
        verdict: f.verdict,
        tone: f.tone,
        points: f.points,
        done: f.done,
        not_done: f.not_done,
        waiting_on: f.waiting_on,
        your_move: f.your_move,
        ..SendMessageBody::default()
    })
}
