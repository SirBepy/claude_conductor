use super::*;

// ---- writing --------------------------------------------------------------

pub(super) fn clean(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let kept: String = unified.chars().filter(|c| *c == '\n' || *c == '\t' || !c.is_control()).collect();
    let trimmed = kept.trim();
    if trimmed.chars().count() <= STORED_CAP {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(STORED_CAP).collect();
    format!("{cut} [cut: longer than {STORED_CAP} characters]")
}

pub(crate) fn one_line(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A finish row that says there is nothing to record.
pub(crate) fn is_nothing(row: &str) -> bool {
    let t = row.trim().trim_end_matches(['.', '!']).trim().to_ascii_lowercase();
    t.is_empty() || t == "nothing" || t == "none"
}

/// Reads the `replaces D3:` convention at the start of a finish row. Returns the
/// ids named and the row without the prefix. Anything that is not exactly that
/// shape is left as plain text, so a row that merely starts with the word
/// "Replaces" is not misread.
pub fn split_replaces(row: &str) -> (Vec<u32>, String) {
    let t = row.trim();
    let plain = || (Vec::new(), t.to_string());
    if !t.get(..8).is_some_and(|h| h.eq_ignore_ascii_case("replaces")) {
        return plain();
    }
    let rest = &t[8..];
    if !rest.starts_with(char::is_whitespace) {
        return plain();
    }
    let Some(colon) = rest.find(':') else { return plain() };
    let (ids_part, tail) = (&rest[..colon], rest[colon + 1..].trim());
    let tokens: Vec<&str> =
        ids_part.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let ids: Vec<u32> =
        tokens.iter().filter_map(|t| t.strip_prefix(['D', 'd']).and_then(|n| n.parse().ok())).collect();
    if tokens.is_empty() || ids.len() != tokens.len() || tail.is_empty() {
        return plain();
    }
    (ids, tail.to_string())
}

/// Appends `items` and closes whatever they replace, as one write. Returns the
/// new entries' ids. Finish rows that repeat a live entry are skipped, because a
/// continued sub that finishes again often restates what it said before.
pub(crate) fn append_in(root: &Path, parent_id: &str, date: &str, items: Vec<NewEntry>) -> std::io::Result<Vec<u32>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let _g = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut entries = load_in(root, parent_id);
    let mut ids = Vec::new();
    for item in items {
        let body = clean(&item.body);
        if body.is_empty() {
            continue;
        }
        // Joe's words are never read for the convention: only a sub writes it.
        let (wanted, body) = if item.kind == Kind::Card { (Vec::new(), body) } else { split_replaces(&body) };
        if item.kind != Kind::Card && entries.iter().any(|e| e.is_live() && e.kind == item.kind && e.body == body) {
            continue;
        }
        let id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
        let mut replaces = Vec::new();
        for w in wanted {
            // A missing or already closed id is not an error: the row is just
            // recorded as a plain entry.
            // A sub never closes Joe's own answer: only he changes those.
            if let Some(old) = entries.iter_mut().find(|e| e.id == w && e.is_live() && e.kind != Kind::Card) {
                old.closed_by = Some(id);
                replaces.push(w);
            }
        }
        entries.push(Entry {
            id,
            kind: item.kind,
            date: date.to_string(),
            who: one_line(&item.who),
            sub: item.sub.map(|s| one_line(&s)).filter(|s| !s.is_empty()),
            question: item.question.map(|q| clean(&q)).filter(|q| !q.is_empty()),
            body,
            replaces,
            closed_by: None,
        });
        ids.push(id);
    }
    if ids.is_empty() {
        return Ok(ids);
    }
    save_in(root, parent_id, &entries)?;
    // Every change to a log funnels through here, so the main chat's digest
    // cannot fall behind it.
    write_main_digest_in(root, parent_id, &entries);
    Ok(ids)
}

pub(super) fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Appends a finished sub's `decided` and `ruled_out` rows. "nothing" adds
/// nothing.
pub(crate) fn record_finish_in(root: &Path, parent_id: &str, who: &str, record: &FinishRecord, date: &str) -> Vec<u32> {
    let rows = |kind: Kind, rows: &[String]| -> Vec<NewEntry> {
        rows.iter()
            .filter(|r| !is_nothing(r))
            .map(|r| NewEntry { sub: Some(record.sub_id.clone()), kind, who: who.to_string(), question: None, body: r.clone() })
            .collect()
    };
    let mut items = rows(Kind::Decided, &record.decided);
    items.extend(rows(Kind::RuledOut, &record.ruled_out));
    append_in(root, parent_id, date, items).unwrap_or_else(|e| {
        log::warn!("subchats: could not write the decisions log for {parent_id}: {e}");
        Vec::new()
    })
}

// ---- card answers ---------------------------------------------------------

/// Who a card asked by `asker` is logged for: the sub's main chat, or the chat
/// itself when it is a main chat with the mode on. `None` for every other chat,
/// so a mode-off chat writes no log at all. Returns (log owner, name shown, the
/// asking sub's id).
pub(super) fn log_owner(state: &DaemonState, asker: &str) -> Option<(String, String, Option<String>)> {
    let inst = state.registry.get(asker)?;
    if let Some(parent) = inst.subchat_of.clone() {
        return Some((parent, sub_name(state, asker), Some(asker.to_string())));
    }
    let on = crate::sessions::chat_config::get(asker).is_some_and(|c| c.subchats_on);
    on.then(|| (asker.to_string(), "main chat".to_string(), None))
}

pub(crate) fn sub_name(state: &DaemonState, sub_id: &str) -> String {
    state
        .registry
        .get(sub_id)
        .and_then(|i| i.name)
        // A sub that runs on another machine has no row here: its name is the one
        // the main chat gave it at spawn, kept in the record.
        .or_else(|| super::super::remote::records::get(sub_id).map(|s| s.name))
        .map(|n| one_line(&n))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "sub".to_string())
}

/// What a recorded question card is, once it passed every exclusion.
pub(super) struct CardCtx {
    pub(super) owner: String,
    pub(super) who: String,
    pub(super) sub: Option<String>,
    pub(super) questions: Vec<String>,
}

/// The question card `request_id` names, if its answer belongs in a log. Not a
/// permission prompt (`permission-requested`), not a secret (`secret-requested`)
/// and not a daemon-raised card (operational: stuck sub, close approval), so only a model's `ask_user_question` from a sub or a mode-on main
/// chat qualifies.
pub(super) async fn card_ctx(state: &Arc<DaemonState>, request_id: &str) -> Option<CardCtx> {
    if state.prompt_event(request_id).await.as_deref() != Some("question-requested") {
        return None;
    }
    let payload = state.prompt_payload(request_id).await?;
    if payload["daemon_card"].as_bool() == Some(true) {
        return None;
    }
    let asker = payload["session_id"].as_str()?;
    // A visiting sub's decisions log is its home's: Joe's answer is recorded there when the home
    // forwards it (`record_remote_card_answer`), never in a file on this machine.
    if super::super::is_visiting(asker) {
        return None;
    }
    let (owner, who, sub) = log_owner(state, asker)?;
    Some(CardCtx { owner, who, sub, questions: question_texts(&payload) })
}

/// The question texts of a question card's payload.
pub(super) fn question_texts(payload: &Value) -> Vec<String> {
    match &payload["questions"] {
        Value::Array(qs) => qs.iter().filter_map(|q| q["question"].as_str().map(str::to_string)).collect(),
        q => q["question"].as_str().map(str::to_string).into_iter().collect(),
    }
}

/// Records Joe's answer to a question card a remote sub's host holds, on this (the home)
/// machine, where its main chat's decisions log lives. `prompt` is the mirrored card as the
/// host listed it (`{id, event, payload}`); it counts only when it is a model's question
/// card from a sub this machine recorded as hosted by `machine_id`, so a peer cannot make
/// this machine write a decision under any other chat.
pub(crate) fn record_remote_card_answer(machine_id: &str, prompt: &Value, answers: &Value) {
    if prompt["event"].as_str() != Some("question-requested") || prompt["payload"]["daemon_card"].as_bool() == Some(true) {
        return;
    }
    let Some(sub) = prompt["payload"]["session_id"].as_str() else { return };
    let Some(rec) = super::super::remote::records::get(sub).filter(|r| r.machine_id == machine_id && !r.main_id.is_empty()) else { return };
    let who = one_line(&rec.name);
    let ctx = CardCtx {
        owner: rec.main_id,
        who: if who.is_empty() { "sub".to_string() } else { who },
        sub: Some(sub.to_string()),
        questions: question_texts(&prompt["payload"]),
    };
    let pairs = answer_pairs(&ctx.questions, answers);
    append_cards(&ctx, pairs);
}

/// `answers` is `{question text: label | [labels]}`, the shape the card submits.
/// Pairs follow the card's own question order, then any answer key the card did
/// not list, so nothing Joe answered is dropped.
pub(super) fn answer_pairs(questions: &[String], answers: &Value) -> Vec<(String, String)> {
    let Some(map) = answers.as_object() else { return Vec::new() };
    let text = |v: &Value| -> Option<String> {
        let s = match v {
            Value::String(s) => s.clone(),
            Value::Array(items) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
            _ => return None,
        };
        (!s.trim().is_empty()).then_some(s)
    };
    let mut out = Vec::new();
    for q in questions {
        if let Some(a) = map.get(q).and_then(text) {
            out.push((q.clone(), a));
        }
    }
    for (q, v) in map {
        if !questions.contains(q) {
            if let Some(a) = text(v) {
                out.push((q.clone(), a));
            }
        }
    }
    out
}

pub(super) fn append_cards(ctx: &CardCtx, pairs: Vec<(String, String)>) {
    let Some(root) = data_root() else { return };
    let items: Vec<NewEntry> = pairs
        .into_iter()
        .map(|(q, a)| NewEntry { sub: ctx.sub.clone(), kind: Kind::Card, who: ctx.who.clone(), question: Some(q), body: a })
        .collect();
    if let Err(e) = append_in(&root, &ctx.owner, &today(), items) {
        log::warn!("subchats: could not record a card answer for {}: {e}", ctx.owner);
    }
}

/// Records Joe's submitted answer to question card `request_id`, word for word,
/// next to the question. Called by `respond_question_inner` before the prompt
/// record is dropped, because that record is the only place the question text
/// lives once the card is answered. A Skip never reaches here.
pub(crate) async fn record_card_answer(state: &Arc<DaemonState>, request_id: &str, answers: &Value) {
    let Some(ctx) = card_ctx(state, request_id).await else { return };
    let pairs = answer_pairs(&ctx.questions, answers);
    append_cards(&ctx, pairs);
}

/// The fallback for a card whose `respond_question` call never arrived while its
/// answer message still did (`settle_answered_questions`). The answer is then
/// only text, so it is recorded as written, under the card's question(s).
pub(crate) async fn record_card_message(state: &Arc<DaemonState>, request_id: &str, message: &str) {
    let Some(ctx) = card_ctx(state, request_id).await else { return };
    let marker = format!("<auq-answer id=\"{request_id}\"/>");
    let Some(at) = message.find(&marker) else { return };
    let mut body = &message[at + marker.len()..];
    // The card's extra note rides the same message after its own sentinel and
    // is not part of the answer.
    if let Some(extra) = body.find("<auq-extra") {
        body = &body[..extra];
    }
    let body = body.trim();
    let body = body.strip_prefix("User answered the question(s):").unwrap_or(body).trim();
    if body.is_empty() {
        return;
    }
    let question = ctx.questions.join("\n");
    append_cards(&ctx, vec![(question, body.to_string())]);
}

// ---- finish ---------------------------------------------------------------

/// What `on_finished` calls: files the sub's finish rows and writes its digest.
/// Reads the record the finish path just stored. Nothing here ever raises a card
/// or runs a model: a "checkup" of the log used to, and Joe could not tell what
/// it was asking.
pub(crate) fn on_finished(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(root) = data_root() else { return };
    let Some(record) = super::super::finish::read_record_in(&root, sub_id) else { return };
    let parent = state
        .registry
        .get(sub_id)
        .and_then(|i| i.subchat_of)
        .or_else(|| record.parent_id.clone());
    let Some(parent) = parent else { return };
    let who = sub_name(state, sub_id);
    let ids = record_finish_in(&root, &parent, &who, &record, &today());
    log::info!("subchats: {sub_id} added {} decision log entries to {parent}", ids.len());
    write_digest_in(&root, &who, &record);
}
