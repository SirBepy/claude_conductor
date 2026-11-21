use super::*;

/// Records on the sub's brief that a follow-up needs it to edit files. The
/// writer slot (`writers`) reads `SubchatBrief.writes`; this is the only place a
/// follow-up flips it. The caller then asks the slot for it (`writers::request_slot`).
///
/// Returns whether this call turned writes on for a sub that had them off. The flip is
/// marked on the brief (`writes_on_since_finish`) until the sub finishes: the sub still
/// believes the read-only line of its brief and its refused Write, so every delivery
/// while the mark stands carries [`WRITES_ON_NOTE`] ([`writes_note_due`]), which also
/// covers a send that failed after the flip and is retried, and `finish_subchat` reads
/// the mark.
pub(crate) fn record_writes(sub_id: &str) -> bool {
    let Some(mut brief) = brief_of(sub_id) else { return false };
    if brief.writes {
        return false;
    }
    brief.writes = true;
    brief.writes_on_since_finish = true;
    crate::sessions::chat_config::set_subchat(sub_id, Some(brief));
    true
}

/// Whether the sub's writes were turned on since it last finished, so the next text
/// delivered to it must say so.
pub(crate) fn writes_note_due(sub_id: &str) -> bool {
    brief_of(sub_id).is_some_and(|b| b.writes_on_since_finish)
}

/// What a sub is told when its writes were off and a follow-up turned them on. It rides
/// with whatever else is delivered, even when that is only Joe's own message: the
/// daemon cannot rely on the main chat's text to say it.
pub(crate) const WRITES_ON_NOTE: &str = "Daemon: your writes are now ON (Edit and Write allowed); your earlier read-only line no longer applies. If your last finish said the job needed writes, do the job now, or name the exact error.";

/// `text` with [`WRITES_ON_NOTE`] after it.
pub(crate) fn with_writes_note(text: &str) -> String {
    format!("{text}

{WRITES_ON_NOTE}")
}

/// Records on the sub's brief the question of Joe's its next finish answers,
/// which `finish::commit_finish_at` moves onto the finish card.
pub(crate) fn record_question(sub_id: &str, question: &str) {
    if let Some(mut brief) = brief_of(sub_id) {
        brief.question = Some(question.to_string());
        crate::sessions::chat_config::set_subchat(sub_id, Some(brief));
    }
}

pub(super) fn is_live_busy(state: &DaemonState, sub_id: &str) -> bool {
    state.registry.get(sub_id).is_some_and(|i| i.busy) && state.sessions.contains_key(sub_id)
}

/// Puts `text` in the sub's held queue, where it reaches the running turn at its
/// next step (`hooks_server::nudge`). Returns the held item id.
pub(in super::super) fn hold(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> u64 {
    hold_plain(state, sub_id, text)
}

/// [`hold`] for text that has a line in the sub's held file: delivering the item
/// then settles the line.
pub(super) fn hold_linked(state: &Arc<DaemonState>, sub_id: &str, text: &str, entry: &str) -> u64 {
    let id = hold_plain(state, sub_id, text);
    followup::link(sub_id, id, entry);
    id
}

/// Puts `text` in the sub's held queue with no file behind it.
pub(in super::super) fn hold_plain(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> u64 {
    let (id, _) = state.draft_store.add_held(sub_id, vec![ContentBlock::Text { text: text.to_string() }]);
    crate::daemon::methods::drafts::sync_held_count(state, sub_id);
    id
}

/// Holds `text` for a busy sub (line `entry` of its held file) and starts the loop
/// that delivers it once the sub is idle. Without a runtime the text stays held
/// and the next boot's [`followup::restore`] picks it up.
pub(in super::super) fn hold_and_flush<F, Fut>(state: &Arc<DaemonState>, sub_id: &str, text: &str, entry: &str, resume: F)
where
    F: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<(), ContinueError>> + Send + 'static,
{
    let item = hold_linked(state, sub_id, text, entry);
    if tokio::runtime::Handle::try_current().is_ok() {
        let (state, id) = (state.clone(), sub_id.to_string());
        tokio::spawn(async move {
            flush_when_idle(&state, &id, item, HOLD_POLL, resume).await;
        });
    }
}

/// Takes a held item back out and sends it, once the sub is idle. The mid-turn
/// hook drains a text item at the sub's next tool batch, but a turn that ends
/// without another batch would strand it, and nothing flushes a hidden sub's
/// held queue the way an open chat window flushes its own. `remove_held`
/// returning `Some` is what settles who owns the item, so the hook, a window
/// and this loop can race without sending it twice. True when this loop sent it.
///
/// There is no deadline: the text was reported to Joe as passed on, so it waits
/// as long as the sub lives. If the sub ends first, the text goes to a card in the
/// main chat ([`followup::raise_undelivered`]) instead of vanishing.
pub(crate) async fn flush_when_idle<F, Fut>(
    state: &Arc<DaemonState>,
    sub_id: &str,
    mut item_id: u64,
    poll: Duration,
    resume: F,
) -> bool
where
    F: Fn(String, String) -> Fut,
    Fut: Future<Output = Result<(), ContinueError>>,
{
    loop {
        let held = state.draft_store.get(sub_id).held;
        let Some(item) = held.iter().find(|h| h.id == item_id) else {
            // The mid-turn hook delivered it, a window took it, or Joe cleared
            // it: not this loop's to send any more.
            followup::settle(sub_id, item_id);
            return false;
        };
        let blocks = item.blocks.clone();
        let text = text_of(&blocks);
        if sub_is_gone(state, sub_id) {
            if state.draft_store.remove_held(sub_id, item_id).is_some() {
                crate::daemon::methods::drafts::sync_held_count(state, sub_id);
                // Only text Joe sent has a line on disk. A daemon's own note held for
                // the same sub (the writer slot is free) is not his, and a sub that
                // ended has no use for it.
                let entry = followup::entry_of(sub_id, item_id);
                followup::forget_link(sub_id, item_id);
                if !entry.is_empty() && followup::claim_entry(sub_id, &entry) {
                    followup::raise_undelivered(state, sub_id, &[text]).await;
                }
            }
            return false;
        }
        if is_live_busy(state, sub_id) {
            tokio::time::sleep(poll).await;
            continue;
        }
        let entry = followup::entry_of(sub_id, item_id);
        if state.draft_store.remove_held(sub_id, item_id).is_none() {
            return false;
        }
        crate::daemon::methods::drafts::sync_held_count(state, sub_id);
        // Images become `<file:..>` mentions here, once: the re-held text below then keeps them.
        let text = delivery_text(sub_id, &blocks);
        state.notifier.publish(
            "held_messages_delivered",
            json!({ "session_id": sub_id, "ids": [item_id], "blocks": blocks }),
        );
        match resume(sub_id.to_string(), text.clone()).await {
            Ok(()) => {
                followup::forget_link(sub_id, item_id);
                followup::settle_entry(sub_id, &entry);
                return true;
            }
            Err(ContinueError::Busy(_)) => {
                // Went busy between the check and the send: hold it again, and
                // look again after a beat rather than straight away.
                followup::forget_link(sub_id, item_id);
                item_id = hold_linked(state, sub_id, &text, &entry);
                tokio::time::sleep(poll).await;
            }
            Err(ContinueError::Ended(_) | ContinueError::NotFound(_)) => {
                followup::forget_link(sub_id, item_id);
                if followup::claim_entry(sub_id, &entry) {
                    followup::raise_undelivered(state, sub_id, &[text]).await;
                }
                return false;
            }
            Err(ContinueError::NotASub(_)) => {
                // Moved to the sidebar: it is an ordinary chat now, and its own
                // window flushes a held message.
                followup::forget_link(sub_id, item_id);
                followup::settle_entry(sub_id, &entry);
                hold(state, sub_id, &text);
                return false;
            }
            Err(e) => {
                log::warn!("subchats: could not send a held message to {sub_id}: {e}; it is back in the queue");
                followup::forget_link(sub_id, item_id);
                hold_linked(state, sub_id, &text, &entry);
                return false;
            }
        }
    }
}

/// What is sent to the sub for held `blocks`: their text, then one `<file:PATH>`
/// mention per image. A `claude` child takes text only, so this is how a composer
/// hands it a pasted image too (the file lands where `paste_image` puts it). An image
/// that cannot be written is left out rather than failing the whole message.
pub(super) fn delivery_text(sub_id: &str, blocks: &[ContentBlock]) -> String {
    let mut parts = Vec::new();
    for b in blocks {
        match b {
            ContentBlock::Text { text } => parts.push(text.clone()),
            ContentBlock::Image { mime, data } => {
                let written = crate::settings::paths::data_dir()
                    .map_err(|e| e.to_string())
                    .and_then(|root| crate::ipc::chat::attachments::write_attachment(&root, sub_id, data, mime));
                match written {
                    Ok(path) => parts.push(format!("<file:{}>", path.to_string_lossy())),
                    Err(e) => log::warn!("subchats: an image in a held message for {sub_id} was not delivered: {e}"),
                }
            }
        }
    }
    // An image-only message whose image could not be written must not resume the sub with
    // nothing at all.
    if parts.is_empty() && !blocks.is_empty() {
        parts.push("(An attachment was sent here but could not be delivered.)".to_string());
    }
    parts.join("\n")
}

pub(super) fn text_of(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The sub's row is gone or ended: nothing will ever take the text.
pub(super) fn sub_is_gone(state: &DaemonState, sub_id: &str) -> bool {
    state.registry.get(sub_id).is_none_or(|i| i.ended_at.is_some() || i.end_reason.is_some())
}

pub(crate) enum Delivery {
    Passed,
    Held,
    /// The sub has not started: the text waits for its first turn.
    NotStarted,
    /// The sub has not started and nothing will start it (its lost hold is too old to
    /// rebuild on a send, or cannot be rebuilt): the text waits for a nudge or a drop.
    Stranded,
}

pub(crate) async fn deliver<F, Fut>(
    state: &Arc<DaemonState>,
    sub: &Instance,
    text: &str,
    resume: &F,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Delivery, String>
where
    F: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<(), ContinueError>> + Send + 'static,
{
    let id = sub.session_id.clone();
    // A sub that never started (held, or its hold was lost) has no conversation, so
    // `--resume` would fail ("No conversation found") and lose the text. It waits on
    // disk and in the held queue, which reaches the sub at the first step of its
    // first turn. A recent lost hold is rebuilt for this one sub so that turn can
    // come; an old one is the main chat's call (it may have re-run the job by hand,
    // and the watchdog already told it), and one that cannot be rebuilt is reported.
    // Either way the text still waits for whatever starts the sub.
    if super::super::lost_hold::never_started(state, sub, has_transcript) {
        let mut stranded = false;
        if !super::super::held::is_held(&id) {
            if !super::super::lost_hold::recent_enough(sub, chrono::Utc::now()) {
                stranded = true;
            } else if !super::super::lost_hold::rebuild_lost_hold(state, &id, has_transcript) {
                super::super::lost_hold::report_not_rebuilt(state, &id).await;
                stranded = true;
            }
        }
        let entry = followup::add(&id, text);
        hold_linked(state, &id, text, &entry);
        return Ok(if stranded { Delivery::Stranded } else { Delivery::NotStarted });
    }
    match resume(id.clone(), text.to_string()).await {
        Ok(()) => Ok(Delivery::Passed),
        Err(ContinueError::Busy(_)) => {
            // Written to disk before "Passed to" is shown: a restart then costs
            // nothing, the text is re-held at boot.
            let entry = followup::add(&id, text);
            hold_and_flush(state, &id, text, &entry, resume.clone());
            Ok(Delivery::Held)
        }
        Err(e) => Err(e.to_string()),
    }
}

pub(super) async fn send<F, Fut>(
    state: &Arc<DaemonState>,
    caller: &str,
    subs: &[Instance],
    remote: &[RemoteSub],
    args: &Value,
    resume: F,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
) -> Value
where
    F: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<(), ContinueError>> + Send + 'static,
{
    let all = args["all"].as_bool() == Some(true);
    let named = args["sub"].as_str().map(str::trim).filter(|s| !s.is_empty());
    if all && named.is_some() {
        return refusal("Pass either sub or all, not both.");
    }
    let explicit = args["text"].as_str().map(str::trim).filter(|s| !s.is_empty());
    let joe = joe_message::latest(caller);
    if explicit.is_none() && joe.is_none() {
        return refusal(NO_MESSAGE_REFUSAL);
    }
    let (targets, remote_targets): (Vec<Instance>, Vec<RemoteSub>) = if all {
        let running = remote.iter().filter(|r| matches!(r.state, RemoteState::Running | RemoteState::Held)).cloned().collect();
        (spawn_mod::running_subs(&state.registry, caller), running)
    } else {
        match resolve(subs, named.unwrap_or("")) {
            Ok(s) => (vec![s.clone()], Vec::new()),
            Err(e) => match resolve_remote(remote, named.unwrap_or("")) {
                Some(rec) => (Vec::new(), vec![rec.clone()]),
                None => return refusal(e),
            },
        }
    };
    if targets.is_empty() && remote_targets.is_empty() {
        return refusal(format!("No running sub to send to. This chat's subs: {}.", names(subs)));
    }
    let writes = args["writes"].as_bool() == Some(true);
    let question = match super::super::brief::question_arg(args["question"].as_str()) {
        Ok(q) => q,
        Err(e) => return refusal(e),
    };
    let (mut passed, mut held, mut failed) = (Vec::new(), Vec::new(), Vec::new());
    let mut reached: Vec<String> = Vec::new();
    let mut not_started: Vec<String> = Vec::new();
    let mut stranded: Vec<String> = Vec::new();
    let mut waiting_for_writer: Vec<(String, String)> = Vec::new();
    for sub in &targets {
        let name = label(sub);
        if status_word(sub) == "ended" {
            failed.push(json!({"sub": name, "error": "it has ended and cannot take a message"}));
            continue;
        }
        if let Some(why) = super::super::ceiling::heavy_send_refusal(
            &name,
            super::super::ceiling::context_pct(state, &sub.session_id),
            writes,
            sub.subchat_finished,
        ) {
            failed.push(json!({"sub": name, "error": why}));
            continue;
        }
        // The Opus rule holds for a follow-up too: `writes` on an Opus sub would
        // flip a planner to an implementer after the spawn check passed it.
        if writes && sub.model.to_ascii_lowercase().contains("opus") {
            failed.push(json!({"sub": name, "error": spawn_mod::OPUS_WRITER_REFUSAL}));
            continue;
        }
        // Joe's message, if he typed one this sub has not had, is what is sent, word
        // for word. The main agent's text only follows it, framed as not his.
        let joe_for_this_sub = joe.as_deref().filter(|_| !joe_message::already_passed(caller, &sub.session_id));
        let text = match (joe_for_this_sub, explicit) {
            (Some(j), Some(t)) => format!("{j}\n\n{MAIN_CHAT_FRAME}{t}"),
            (Some(j), None) => j.to_string(),
            (None, Some(t)) => format!("{MAIN_CHAT_FRAME}{t}"),
            (None, None) => {
                failed.push(json!({"sub": name, "error": "it already got this message of Joe's"}));
                continue;
            }
        };
        let from_joe = joe_for_this_sub.is_some();
        let mut text = match &question {
            Some(q) => format!("{text}

{}{q}", super::super::brief::QUESTION_JOB),
            None => text,
        };
        if writes {
            record_writes(&sub.session_id);
            if writes_note_due(&sub.session_id) {
                text = with_writes_note(&text);
            }
            // One sub changes files at a time: this one takes the slot or queues
            // for it, and the main chat is told which, so Joe hears it is waiting.
            if let super::super::writers::SlotOutcome::Queued { behind, .. } = super::super::writers::request_slot(state, &sub.session_id) {
                waiting_for_writer.push((name.clone(), behind));
            }
        }
        match deliver(state, sub, &text, &resume, has_transcript).await {
            Ok(d) => {
                if from_joe {
                    joe_message::mark_passed(caller, &sub.session_id);
                }
                if let Some(q) = &question {
                    record_question(&sub.session_id, q);
                }
                reached.push(sub.session_id.clone());
                match d {
                    Delivery::Passed => passed.push(name),
                    Delivery::Held => held.push(name),
                    Delivery::NotStarted => not_started.push(name),
                    Delivery::Stranded => stranded.push(name),
                }
            }
            Err(e) => failed.push(json!({"sub": name, "error": e})),
        }
    }
    for rec in &remote_targets {
        let name = actions::name_of(rec);
        let joe_for_this_sub = joe.as_deref().filter(|_| !joe_message::already_passed(caller, &rec.sub_id));
        let text = match (joe_for_this_sub, explicit) {
            (Some(j), Some(t)) => format!("{j}\n\n{MAIN_CHAT_FRAME}{t}"),
            (Some(j), None) => j.to_string(),
            (None, Some(t)) => format!("{MAIN_CHAT_FRAME}{t}"),
            (None, None) => {
                failed.push(json!({"sub": name, "error": "it already got this message of Joe's"}));
                continue;
            }
        };
        let text = match &question {
            Some(q) => format!("{text}\n\n{}{q}", super::super::brief::QUESTION_JOB),
            None => text,
        };
        match actions::deliver_noting_wait(state, rec, &text, writes, question.as_deref()).await {
            Ok((d, queued_behind)) => {
                if let Some(behind) = queued_behind {
                    waiting_for_writer.push((name.clone(), behind));
                }
                if joe_for_this_sub.is_some() {
                    joe_message::mark_passed(caller, &rec.sub_id);
                }
                reached.push(rec.sub_id.clone());
                match d {
                    actions::Delivery::Passed => passed.push(name),
                    actions::Delivery::Held => held.push(name),
                    actions::Delivery::NotStarted => not_started.push(name),
                    actions::Delivery::Stranded => stranded.push(name),
                }
            }
            Err(e) => failed.push(json!({"sub": name, "error": e})),
        }
    }
    if passed.is_empty() && held.is_empty() && not_started.is_empty() && stranded.is_empty() {
        return refusal(failed.iter().filter_map(|f| f["error"].as_str().map(|e| format!("{}: {e}", f["sub"].as_str().unwrap_or("sub")))).collect::<Vec<_>>().join("; "));
    }
    let message = match (joe.is_some(), explicit.is_some()) {
        (true, true) => "Joe's message word for word, then your text framed as from the main chat (a sub that already had Joe's message got only your text)",
        (true, false) => "Joe's message, word for word",
        _ => "your text, framed as from the main chat",
    };
    // `sub_ids` lets the Answers card tie a question's pending row to the sub whose finish fills it.
    let mut out = json!({"ok": true, "passed_to": passed, "message": message, "sub_ids": reached});
    if question.is_some() {
        out["question_note"] = json!("The sub's finish is drawn as the answer in Joe's Answers card: do not relay it.");
    }
    if !held.is_empty() {
        out["held_for"] = json!(held);
        out["held_note"] = json!("these subs were mid-turn: the message reaches them at their next step");
    }
    if !not_started.is_empty() {
        out["not_started"] = json!(not_started);
        out["not_started_note"] = json!("these subs are queued and have not started: the message waits and reaches them at their first step, and they start by themselves when what they wait for is done");
    }
    if !stranded.is_empty() {
        out["stranded"] = json!(stranded);
        out["stranded_note"] = json!("these subs never started and nothing will start them by itself (their start was lost and is too old to redo on a send, or cannot be redone): the message waits for their first step. Start one only if Joe's job is still wanted, from its card's nudge, or drop it with the drop action");
    }
    if !failed.is_empty() {
        out["failed"] = json!(failed);
    }
    if !waiting_for_writer.is_empty() {
        out["queued_for_writer"] = json!(waiting_for_writer.iter().map(|(sub, behind)| json!({"sub": sub, "behind": behind})).collect::<Vec<_>>());
        out["queued_note"] = json!(waiting_for_writer
            .iter()
            .map(|(sub, behind)| super::super::writers::send_note(sub, behind))
            .collect::<Vec<_>>()
            .join(" "));
    }
    out
}
