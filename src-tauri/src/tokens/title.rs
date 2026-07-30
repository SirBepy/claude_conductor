use std::io::{BufRead, BufReader};
use std::path::Path;

/// Extracts the inner text of `<tag>…</tag>` from `s`, if present.
fn tag_inner<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let end = s[start..].find(&close)? + start;
    Some(s[start..end].trim())
}

/// If `s` is a slash-command invocation (`<command-name>…</command-name>`),
/// renders it as the user typed it: the command name followed by its args
/// (e.g. `/rate-it 2 the new skill`). Returns None for a plain message.
fn command_label(s: &str) -> Option<String> {
    let name = tag_inner(s, "command-name")?;
    match tag_inner(s, "command-args") {
        Some(args) if !args.is_empty() => Some(format!("{name} {args}")),
        _ => Some(name.to_string()),
    }
}

/// Collapses control chars + whitespace runs to single spaces, trims, and
/// truncates to `max_chars` with a trailing `…`. Returns None if the result
/// is empty. Shared by `first_user_prompt` and `last_override_title` so titles
/// from either source look identical.
fn normalise_and_truncate(s: &str, max_chars: usize) -> Option<String> {
    let normalised: String = s
        .chars()
        .map(|c| if c.is_control() || c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let collapsed = normalised.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { return None; }
    if collapsed.chars().count() <= max_chars {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(max_chars).collect();
    Some(format!("{cut}…"))
}

/// Reads up to the last 64KB of a transcript and returns the most recent
/// non-blank `custom-title` / `agent-name` override (written by /close's
/// rename-session script, which appends them at EOF). Scans backward so the
/// latest rename wins, discarding a partial first line from the tail window
/// and skipping any line that doesn't parse. Returns None when no override
/// has been written — callers then fall back to the first user prompt.
pub fn last_override_title(path: &Path, max_chars: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 64 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    let mut lines: Vec<&str> = buf.lines().collect();
    if start > 0 && lines.len() > 1 {
        lines.remove(0);
    }
    for line in lines.into_iter().rev() {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let value = match v.get("type").and_then(|t| t.as_str()) {
            Some("custom-title") => v.get("customTitle").and_then(|s| s.as_str()),
            Some("agent-name") => v.get("agentName").and_then(|s| s.as_str()),
            _ => None,
        };
        let Some(value) = value else { continue };
        if value.trim().is_empty() { continue }
        if let Some(title) = normalise_and_truncate(value, max_chars) {
            return Some(title);
        }
    }
    None
}

/// Resolves a session's display title. Precedence, highest first:
/// 1. a curated override (a `custom-title`/`agent-name` line from /close's
///    rename or any future manual rename) — sticky, a human choice always wins;
/// 2. an AI milestone title (the `<cc-title:…>` Claude emits, snapshotted at
///    user-turn 1, 5 and 15 — see `ai_milestone_title`);
/// 3. the first user prompt.
/// This is what the sidebar / history / restore paths use.
pub fn session_title(path: &Path, max_chars: usize) -> Option<String> {
    last_override_title(path, max_chars)
        .or_else(|| ai_milestone_title(path, max_chars))
        .or_else(|| first_user_prompt(path, max_chars))
}

/// User-turn milestones at which a fresh AI title is adopted. The title from
/// the highest milestone reached (that carried a marker) wins, so the title
/// refines as the conversation grows but only ever changes a bounded number of
/// times — never every turn.
const TITLE_MILESTONES: [usize; 3] = [1, 5, 15];

/// Extracts the inner text of the LAST `<cc-title:…>` marker in `text`, if any.
/// Tolerates the XML-style `<cc-title>…</cc-title>` variant some model versions
/// emit, and the mixed `<cc-title:…</cc-title>` form (a colon open with an XML
/// close) — without the cleanup the `>` of the close tag becomes the colon
/// form's delimiter and the title keeps a trailing `</cc-title`.
/// Last wins so a response that (oddly) emits more than one keeps the final.
fn extract_cc_title(text: &str) -> Option<String> {
    const OPEN: &str = "<cc-title:";
    let mut result = None;
    let mut rest = text;
    while let Some(i) = rest.find(OPEN) {
        let after = &rest[i + OPEN.len()..];
        match after.find('>') {
            Some(end) => {
                result = Some(after[..end].to_string());
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    // XML-form fallback: <cc-title>TEXT</cc-title>, last marker wins.
    if result.is_none() {
        const XOPEN: &str = "<cc-title>";
        const XCLOSE: &str = "</cc-title>";
        let mut rest = text;
        while let Some(i) = rest.find(XOPEN) {
            let after = &rest[i + XOPEN.len()..];
            match after.find(XCLOSE) {
                Some(end) => {
                    result = Some(after[..end].to_string());
                    rest = &after[end + XCLOSE.len()..];
                }
                None => break,
            }
        }
    }
    result.map(|t| clean_title_capture(&t))
}

/// Strips a trailing XML close tag (`</cc-title>`, or the partial `</cc-title`
/// left when the colon-form `>` delimiter consumed the real `>`) from a captured
/// title, then trims.
fn clean_title_capture(t: &str) -> String {
    let t = t.trim();
    let t = t.strip_suffix("</cc-title>").unwrap_or(t);
    let t = t.strip_suffix("</cc-title").unwrap_or(t);
    t.trim().to_string()
}

/// True for a *real* user turn: a non-meta `user` message carrying actual text
/// (not a `tool_result`-only message, not the local-command-caveat preamble).
/// Mirrors `first_user_prompt`'s skip rules so turn counting matches what the
/// user perceives as a "message", and tool round-trips don't inflate the count.
pub(crate) fn is_real_user_turn(v: &serde_json::Value) -> bool {
    if v.get("type").and_then(|t| t.as_str()) != Some("user") { return false; }
    if v.get("isMeta").and_then(|b| b.as_bool()) == Some(true) { return false; }
    let Some(msg) = v.get("message") else { return false; };
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") { return false; }
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            !t.is_empty() && !t.starts_with("<local-command-caveat>")
        }
        Some(serde_json::Value::Array(items)) => items.iter().any(|it| {
            it.get("type").and_then(|t| t.as_str()) == Some("text")
                && it.get("text").and_then(|t| t.as_str())
                    .map(|s| !s.trim().is_empty()).unwrap_or(false)
        }),
        _ => false,
    }
}

/// Concatenated text of a *user* message's text blocks. Used to spot the
/// bookkeeping turns below; `is_real_user_turn` deliberately doesn't expose it.
fn user_turn_text(v: &serde_json::Value) -> String {
    match v.get("message").and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Array(items)) => {
            let mut acc = String::new();
            for it in items {
                if it.get("type").and_then(|t| t.as_str()) != Some("text") { continue; }
                if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                    if !acc.is_empty() { acc.push(' '); }
                    acc.push_str(t);
                }
            }
            acc.trim().to_string()
        }
        _ => String::new(),
    }
}

/// A real user turn that also represents the user actually *saying* something,
/// for the purpose of numbering title milestones. Excludes two bookkeeping
/// turns the harness writes as user messages:
///  - `[Request interrupted by user]`, which can never carry an assistant reply
///    (that's what got interrupted), so counting it guarantees a missed milestone;
///  - `<auq-answer/>` blocks, which are the answer to a question the assistant
///    asked, not a new instruction.
/// Both inflate the count and shift every milestone past the turns that do have
/// a marker. Separate from `is_real_user_turn` because that one is also the
/// token walker's "messages sent by me" predicate (see walker.rs) and must keep
/// counting these.
fn is_titleable_user_turn(v: &serde_json::Value) -> bool {
    if !is_real_user_turn(v) { return false; }
    let t = user_turn_text(v);
    !t.starts_with("[Request interrupted by user]") && !t.starts_with("<auq-answer/>")
}

/// Concatenated text of an `assistant` message's text blocks, or None if the
/// line isn't an assistant message with text (e.g. a pure tool_use turn).
fn assistant_text(v: &serde_json::Value) -> Option<String> {
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") { return None; }
    let msg = v.get("message")?;
    if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") { return None; }
    match msg.get("content")? {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        serde_json::Value::Array(items) => {
            let mut acc = String::new();
            for it in items {
                if it.get("type").and_then(|t| t.as_str()) != Some("text") { continue; }
                if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                    if !acc.is_empty() { acc.push(' '); }
                    acc.push_str(t);
                }
            }
            if acc.is_empty() { None } else { Some(acc) }
        }
        _ => None,
    }
}

/// Reads the transcript and returns the AI-generated title, snapshotting the
/// most recent `<cc-title:…>` marker seen each time a milestone turn (1/5/15)
/// completes. Stops once past the last milestone so it never scans an entire
/// long chat. Returns None when the chat carries no marker at all.
///
/// Two rules here are deliberate, and both exist because the previous version
/// required a marker to land on *exactly* turn 1, 5 or 15:
///  - milestones snapshot the latest marker so far rather than demanding an
///    exact-turn hit. An assistant turn that ends on a tool call (asking a
///    question, say) emits no marker, which used to silently forfeit that
///    milestone;
///  - before the first milestone completes, the newest marker is used directly,
///    so a chat gets a real title from its first finished turn instead of
///    sitting on the first-user-prompt fallback.
/// Together with `is_titleable_user_turn` this is what stops an interrupted or
/// question-heavy chat from being stuck on "I've been meaning to do this for a
/// while now lets actually d…" forever.
pub fn ai_milestone_title(path: &Path, max_chars: usize) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let last_milestone = *TITLE_MILESTONES.last().unwrap();
    let mut turn = 0usize;
    let mut latest: Option<String> = None;
    let mut best: Option<String> = None;
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue; }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if is_titleable_user_turn(&v) {
            // The turn that just ended is complete; snapshot if it was a milestone.
            if TITLE_MILESTONES.contains(&turn) { best = latest.clone(); }
            turn += 1;
            if turn > last_milestone { break; }
            continue;
        }
        if turn == 0 { continue; }
        if let Some(text) = assistant_text(&v) {
            if let Some(t) = extract_cc_title(&text) {
                if !t.trim().is_empty() { latest = Some(t); }
            }
        }
    }
    if TITLE_MILESTONES.contains(&turn) { best = latest.clone(); }
    best.or(latest).and_then(|t| normalise_and_truncate(&t, max_chars))
}

/// Scans a transcript for the first real user prompt and returns it
/// as a short label suitable for showing as the instance "name" in
/// the dashboard. Skips meta entries (`isMeta:true`), the
/// local-command-caveat preamble Claude injects, and slash-command
/// markup. Returns up to `max_chars` of the prompt with trailing
/// whitespace collapsed and "…" appended if it was truncated.
///
/// Returns None if the file is missing/malformed or no real user
/// prompt has been written yet (fresh session).
pub fn first_user_prompt(path: &Path, max_chars: usize) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue }
        if v.get("isMeta").and_then(|b| b.as_bool()) == Some(true) { continue }
        let Some(msg) = v.get("message") else { continue };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") { continue }
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(items)) => {
                let mut acc = String::new();
                for it in items {
                    if it.get("type").and_then(|t| t.as_str()) != Some("text") { continue }
                    if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                        if !acc.is_empty() { acc.push(' '); }
                        acc.push_str(t);
                    }
                }
                acc
            }
            _ => continue,
        };
        let trimmed = text.trim();
        if trimmed.is_empty() { continue }
        if trimmed.starts_with("<local-command-caveat>") { continue }
        let label = command_label(trimmed).map(std::borrow::Cow::Owned)
            .unwrap_or(std::borrow::Cow::Borrowed(trimmed));
        if let Some(title) = normalise_and_truncate(&label, max_chars) {
            return Some(title);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn first_user_prompt_uses_plain_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"build me a thing"}}"#).unwrap();
        assert_eq!(first_user_prompt(&path, 60).as_deref(), Some("build me a thing"));
    }

    #[test]
    fn first_user_prompt_renders_slash_command_as_name_plus_args() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"<command-message>rate-it</command-message>\n<command-name>/rate-it</command-name>\n<command-args>2 the new skill we made</command-args>"}}"#).unwrap();
        assert_eq!(
            first_user_prompt(&path, 60).as_deref(),
            Some("/rate-it 2 the new skill we made"),
        );
    }

    #[test]
    fn first_user_prompt_slash_command_without_args() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"<command-message>close</command-message>\n<command-name>/close</command-name>\n<command-args></command-args>"}}"#).unwrap();
        assert_eq!(first_user_prompt(&path, 60).as_deref(), Some("/close"));
    }

    fn user_line(text: &str) -> String {
        serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string()
    }
    fn override_line(kind: &str, value: &str) -> String {
        let field = if kind == "custom-title" { "customTitle" } else { "agentName" };
        serde_json::json!({"type":kind, field:value, "sessionId":"s1"}).to_string()
    }

    #[test]
    fn session_title_override_wins_over_first_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [user_line("first prompt text"), override_line("custom-title", "Curated Name")].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path, 60).as_deref(), Some("Curated Name"));
    }

    #[test]
    fn session_title_last_override_wins() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [
            user_line("first prompt text"),
            override_line("custom-title", "Old Name"),
            override_line("agent-name", "New Name"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path, 60).as_deref(), Some("New Name"));
    }

    #[test]
    fn session_title_blank_override_falls_through_to_first_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [user_line("first prompt text"), override_line("custom-title", "   ")].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path, 60).as_deref(), Some("first prompt text"));
    }

    #[test]
    fn session_title_no_override_equals_first_user_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, user_line("just a plain prompt")).unwrap();
        assert_eq!(session_title(&path, 60), first_user_prompt(&path, 60));
        assert_eq!(session_title(&path, 60).as_deref(), Some("just a plain prompt"));
    }

    #[test]
    fn last_override_title_reads_tail_past_large_filler() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut lines = vec![user_line("first prompt text")];
        for i in 0..4000 {
            lines.push(format!("not even json line {i} ############################"));
        }
        lines.push(override_line("custom-title", "Tail Name"));
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(last_override_title(&path, 60).as_deref(), Some("Tail Name"));
        assert_eq!(session_title(&path, 60).as_deref(), Some("Tail Name"));
    }

    #[test]
    fn last_override_title_none_when_absent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, user_line("hi")).unwrap();
        assert_eq!(last_override_title(&path, 60), None);
    }

    fn assistant_line(text: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}
        }).to_string()
    }
    /// A `tool_result` user message (a turn-internal round-trip, NOT a real user
    /// turn) — must not advance the turn counter.
    fn tool_result_line() -> String {
        serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}
        }).to_string()
    }

    #[test]
    fn extract_cc_title_takes_last_marker() {
        assert_eq!(extract_cc_title("body <cc-title:First> more").as_deref(), Some("First"));
        assert_eq!(extract_cc_title("a <cc-title:One> b <cc-title:Two>").as_deref(), Some("Two"));
        assert_eq!(extract_cc_title("no marker here"), None);
        assert_eq!(extract_cc_title("<cc-title:unterminated"), None);
    }

    #[test]
    fn extract_cc_title_strips_xml_close_variants() {
        // Mixed colon-open + XML-close — the bug that leaked `</cc-title`.
        assert_eq!(
            extract_cc_title("body <cc-title:My Title</cc-title>").as_deref(),
            Some("My Title"),
        );
        // Pure XML form.
        assert_eq!(
            extract_cc_title("x <cc-title>Pure XML</cc-title> y").as_deref(),
            Some("Pure XML"),
        );
        // Last XML marker wins.
        assert_eq!(
            extract_cc_title("<cc-title>One</cc-title> <cc-title>Two</cc-title>").as_deref(),
            Some("Two"),
        );
    }

    #[test]
    fn milestone_title_from_first_turn() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [
            user_line("help me with auth"),
            assistant_line("Sure.\n<cc-title:Auth Setup Help>\n<cc-status:done>"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("Auth Setup Help"));
        // session_title surfaces it when there's no human override.
        assert_eq!(session_title(&path, 60).as_deref(), Some("Auth Setup Help"));
    }

    #[test]
    fn milestone_title_advances_to_fifth_turn() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut lines = vec![
            user_line("turn one"),
            assistant_line("<cc-title:Early Topic>"),
        ];
        // turns 2,3,4 carry markers too, but only milestones count.
        for n in 2..=5 {
            lines.push(user_line(&format!("turn {n}")));
            lines.push(assistant_line(&format!("<cc-title:Turn {n} Title>")));
        }
        std::fs::write(&path, lines.join("\n")).unwrap();
        // Turn 5 is a milestone; its title wins over turn 1's, turns 2-4 ignored.
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("Turn 5 Title"));
    }

    // The two failure modes seen in a real chat that stayed on its first-prompt
    // title for 13 turns while emitting six good markers.
    #[test]
    fn interrupted_first_turn_still_gets_an_ai_title() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // Turn 1 is interrupted before any assistant reply, so the old
        // exact-turn-1 rule found nothing and fell back to the first prompt.
        let body = [
            user_line("I've been meaning to do this for a while now"),
            user_line("[Request interrupted by user]"),
            user_line("actually also do this other thing"),
            assistant_line("Done.\n<cc-title:Session Card Redesign>\n<cc-status:done>"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("Session Card Redesign"));
        assert_eq!(session_title(&path, 60).as_deref(), Some("Session Card Redesign"));
    }

    #[test]
    fn auq_answers_and_interrupts_do_not_shift_milestones() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // Five genuine instructions, padded with the bookkeeping turns the
        // harness writes. Milestone 5 must land on the fifth REAL instruction.
        let body = [
            user_line("one"), assistant_line("<cc-title:T1>"),
            user_line("[Request interrupted by user]"),
            user_line("two"), assistant_line("<cc-title:T2>"),
            user_line("<auq-answer/>User answered the question(s):\nQ: pick one"),
            assistant_line("<cc-title:T3-not-a-turn>"),
            user_line("three"), assistant_line("<cc-title:T3>"),
            user_line("four"), assistant_line("<cc-title:T4>"),
            user_line("five"), assistant_line("<cc-title:T5 Final>"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("T5 Final"));
    }

    #[test]
    fn milestone_survives_a_turn_that_ends_on_a_tool_call() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // Turn 5 ends on a question (no marker). The snapshot takes the most
        // recent marker instead of forfeiting the milestone entirely.
        let mut lines = vec![user_line("one"), assistant_line("<cc-title:First>")];
        for n in 2..=4 {
            lines.push(user_line(&format!("turn {n}")));
            lines.push(assistant_line(&format!("<cc-title:Turn {n}>")));
        }
        lines.push(user_line("turn 5"));
        lines.push(assistant_line("no marker on this one, it ended on a question"));
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("Turn 4"));
    }

    #[test]
    fn tool_round_trips_do_not_inflate_turn_count() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // One real user turn whose response includes several tool round-trips.
        // None of the tool_result lines should count as turns, so this stays
        // turn 1 and the milestone title is the turn-1 title.
        let body = [
            user_line("do a big task"),
            assistant_line("working <cc-title:Wrong Early>"),
            tool_result_line(),
            assistant_line("still working"),
            tool_result_line(),
            assistant_line("done\n<cc-title:Big Task Done>\n<cc-status:done>"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        // Turn 1, last marker within the turn wins.
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("Big Task Done"));
    }

    #[test]
    fn human_override_beats_ai_milestone_title() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [
            user_line("first prompt"),
            assistant_line("<cc-title:AI Picked This>"),
            override_line("custom-title", "Human Named It"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("AI Picked This"));
        // Sticky human override wins in the resolved title.
        assert_eq!(session_title(&path, 60).as_deref(), Some("Human Named It"));
    }

    #[test]
    fn no_marker_falls_back_to_first_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [user_line("just chatting"), assistant_line("hi there, no marker")].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(ai_milestone_title(&path, 60), None);
        assert_eq!(session_title(&path, 60).as_deref(), Some("just chatting"));
    }

    #[test]
    fn title_after_fifteenth_turn_holds_at_turn_fifteen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut lines = Vec::new();
        for n in 1..=20 {
            lines.push(user_line(&format!("turn {n}")));
            lines.push(assistant_line(&format!("<cc-title:Title At {n}>")));
        }
        std::fs::write(&path, lines.join("\n")).unwrap();
        // 15 is the last milestone; turns 16-20 are ignored even though present.
        assert_eq!(ai_milestone_title(&path, 60).as_deref(), Some("Title At 15"));
    }
}
