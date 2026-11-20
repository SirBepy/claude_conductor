//! A sub's finish card and the "all finished" card, drawn once the last running sub is done.

use super::*;

/// The hook `subchats::on_finished` calls. The card needs git and a transcript
/// read, and `on_finished` runs inside the pump's result handler, so the work
/// goes to its own thread rather than blocking a turn end.
pub fn on_finished(state: &Arc<DaemonState>, sub_id: &str) {
    #[cfg(test)]
    {
        // Tests that finish a sub do not own the real data dir; only one that
        // registered a scratch root draws.
        if let Some((root, transcript)) = seam::get(sub_id) {
            draw_finish_at(&root, state, sub_id, transcript);
        }
    }
    #[cfg(not(test))]
    {
        let (state, id) = (state.clone(), sub_id.to_string());
        let spawned = std::thread::Builder::new().name("subchat-card".into()).spawn(move || {
            let Ok(root) = crate::settings::paths::data_dir() else { return };
            let transcript = crate::context_status::resolve_transcript(&state.registry, &id);
            draw_finish_at(&root, &state, &id, transcript);
        });
        if let Err(e) = spawned {
            log::warn!("subchats: could not start the card thread for {sub_id}: {e}");
        }
    }
}

/// Draws the finish card for `sub_id`'s latest report, then the "all finished"
/// card when that was the last running sub. Blocking. Returns what was drawn.
pub(crate) fn draw_finish_at(
    root: &Path,
    state: &Arc<DaemonState>,
    sub_id: &str,
    transcript: Option<PathBuf>,
) -> Vec<CardEntry> {
    let Some(inst) = state.registry.get(sub_id) else { return Vec::new() };
    let Some(parent) = inst.subchat_of.clone() else { return Vec::new() };
    let Some(record) = finish::read_record_in(root, sub_id) else { return Vec::new() };
    let log = read_in(root, &parent);
    let check = crate::daemon::subchats::project::check_mode(state, &inst.cwd);
    let facts = sub_facts(&inst, check, record.reviewer_tool_use_id.as_deref(), &log, transcript.as_deref());
    draw_finish_and_all(root, state, &parent, &sub_name(&inst), &inst.model, &inst.effort, &record, facts, None)
}

/// The finish card of a sub that runs on another machine, from the facts its host
/// computed (this machine can read neither its git nor its transcript), then the
/// "all finished" card if that was the last one. `merged` is what this machine
/// knows of the landing in its own checkout: the host cannot say.
pub(crate) fn draw_remote_finish_at(
    root: &Path,
    state: &Arc<DaemonState>,
    rec: &crate::daemon::subchats::remote::records::RemoteSub,
    mut facts: Facts,
    model: &str,
    effort: &str,
    merged: Option<bool>,
) -> Vec<CardEntry> {
    let Some(record) = finish::read_record_in(root, &rec.sub_id) else { return Vec::new() };
    if !rec.target.is_empty() {
        facts.merged_into = Some(rec.target.clone());
        facts.merged = merged;
    }
    let machine = crate::daemon::subchats::remote::machine_label(state, &rec.machine_id);
    draw_finish_and_all(root, state, &rec.main_id, &remote_sub_name(rec), model, effort, &record, facts, machine)
}

/// Whether the finish card of the round the stored finish record is for is in the main chat's
/// card log: stored by this draw or by an earlier one.
fn finish_card_stored(root: &Path, rec: &crate::daemon::subchats::remote::records::RemoteSub) -> bool {
    let Some(record) = finish::read_record_in(root, &rec.sub_id) else { return false };
    let id = format!("finish-{}-{}", rec.sub_id, record.round);
    read_in(root, &rec.main_id).iter().any(|c| c.id == id)
}

/// [`draw_remote_finish_at`] for the finish hook: off the caller's thread, like
/// [`on_finished`], because a card is drawn under the log lock.
///
/// `done` runs once the finish card is in the log (on the card thread outside a test), so the
/// caller can tell a finish whose card never got drawn from one that did. It does not run when
/// the card is missing from the log after the draw, nor when the thread cannot start.
pub fn on_remote_finished(state: &Arc<DaemonState>, sub_id: &str, facts: Facts, model: String, effort: String, merged: Option<bool>, done: impl FnOnce() + Send + 'static) {
    let Some(rec) = crate::daemon::subchats::remote::records::get(sub_id) else {
        done();
        return;
    };
    #[cfg(test)]
    {
        if let Some(root) = crate::daemon::subchats::decisions::data_root() {
            draw_remote_finish_at(&root, state, &rec, facts, &model, &effort, merged);
            if finish_card_stored(&root, &rec) {
                done();
            }
        }
    }
    #[cfg(not(test))]
    {
        let state = state.clone();
        let spawned = std::thread::Builder::new().name("subchat-card".into()).spawn(move || {
            let Ok(root) = crate::settings::paths::data_dir() else { return };
            draw_remote_finish_at(&root, &state, &rec, facts, &model, &effort, merged);
            if finish_card_stored(&root, &rec) {
                done();
            }
        });
        if let Err(e) = spawned {
            log::warn!("subchats: could not start the card thread for remote sub {sub_id}: {e}");
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_finish_and_all(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    name: &str,
    model: &str,
    effort: &str,
    record: &finish::FinishRecord,
    facts: Facts,
    machine: Option<String>,
) -> Vec<CardEntry> {
    let mut drawn = Vec::new();
    let sub_id = record.sub_id.as_str();
    let finish_entry = CardEntry {
        id: format!("finish-{sub_id}-{}", record.round),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_FINISH.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(name.to_string()),
        round: Some(record.round),
        model: Some(model.to_string()).filter(|m| !m.is_empty()),
        effort: Some(effort.to_string()).filter(|e| !e.is_empty()),
        verdict: if record.verdict.is_empty() { "Finished".into() } else { record.verdict.clone() },
        tone: record.tone.clone(),
        text: record.text.clone(),
        points: record.points.clone(),
        done: record.done.clone(),
        not_done: record.not_done.clone(),
        waiting_on: record.waiting_on.clone(),
        your_move: record.your_move.clone(),
        facts: Some(facts),
        question: record.question.clone(),
        machine,
        ..CardEntry::default()
    };
    if store_and_announce(state, root, &finish_entry) {
        drawn.push(finish_entry);
    }
    // After this sub's own card is stored, and under the log lock from the read to
    // the write: a sibling's thread that stored its card first is then in the sum,
    // and two threads cannot both find the set undrawn and each draw it.
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(all) = all_finished_entry(state, root, parent) {
        if store_locked(state, root, &all) {
            drawn.push(all);
        }
    }
    drawn
}

/// "A, B and C" style count line for the all-finished card. Only what could be
/// summed is stated, with the unknown named beside it.
pub(super) fn sum_text(s: &SumFacts) -> String {
    let mut parts = vec![format!("{} commit{}, {} file{} changed", s.commits, plural(s.commits), s.files_changed, plural(s.files_changed))];
    let mut tests = Vec::new();
    if s.tests_passed > 0 {
        tests.push(format!("{} passed", s.tests_passed));
    }
    if s.tests_failed > 0 {
        tests.push(format!("{} failed", s.tests_failed));
    }
    if s.tests_unknown > 0 {
        tests.push(format!("{} unknown", s.tests_unknown));
    }
    if !tests.is_empty() {
        parts.push(format!("tests {}", tests.join(", ")));
    }
    if s.uncommitted > 0 {
        parts.push(format!("{} uncommitted", s.uncommitted));
    }
    if s.unpushed > 0 {
        parts.push(format!("{} not pushed", s.unpushed));
    }
    if s.not_merged > 0 {
        parts.push(format!("{} not merged", s.not_merged));
    }
    if s.unknown_subs > 0 {
        parts.push(format!("{} sub{} unknown", s.unknown_subs, plural(s.unknown_subs)));
    }
    parts.join(", ")
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The "all finished" card: drawn once, when the last running sub of `parent`
/// finishes, for the batch of reports since the previous such card. Only that
/// batch is summed, so a long-lived main chat does not report its whole history
/// each time, and a continued sub that finishes again starts a batch of its own.
///
/// A report counts once its finish card is in the log, so the card waits for the
/// sub whose card thread has not landed yet: that thread calls this again right
/// after storing its card and draws it, which is also why no set is ever drawn
/// twice. A sub whose merge was refused is named in the totals as not merged and
/// its commits are left out of them, and the card's tone says so.
pub(super) fn all_finished_entry(state: &DaemonState, root: &Path, parent: &str) -> Option<CardEntry> {
    // Local rows and subs recorded on other machines: the card is about the whole family.
    let subs = crate::daemon::subchats::family::live_subs(state, parent);
    if subs.is_empty() || subs.iter().any(|m| !m.finished) {
        return None;
    }
    let log = read_in(root, parent);
    let waiting_for_a_card = subs.iter().any(|m| {
        let round = finish::read_record_in(root, &m.sub_id).map_or(0, |r| r.round);
        round > 0 && !log.iter().any(|e| e.id == format!("finish-{}-{round}", m.sub_id))
    });
    if waiting_for_a_card {
        return None;
    }
    let since = log.iter().rposition(|e| e.kind == KIND_ALL_FINISHED).map_or(0, |i| i + 1);
    // Each live sub's latest report in the batch, in the order the subs finished.
    let mut batch: Vec<&CardEntry> = Vec::new();
    for e in log[since..].iter().filter(|e| e.kind == KIND_FINISH) {
        let Some(id) = e.sub_id.as_deref() else { continue };
        if !subs.iter().any(|m| m.sub_id == id) {
            continue;
        }
        batch.retain(|b| b.sub_id.as_deref() != Some(id));
        batch.push(e);
    }
    if batch.is_empty() {
        return None;
    }
    let key = batch.iter().map(|e| e.id.as_str()).collect::<Vec<_>>().join(",");
    let latest: Vec<Option<&Facts>> = batch.iter().map(|e| e.facts.as_ref()).collect();
    let sum = facts::sum(&latest);
    let n = sum.subs;
    Some(CardEntry {
        id: format!("all-{parent}-{}", now_ms()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_ALL_FINISHED.into(),
        verdict: if n == 1 { "1 sub finished".into() } else { format!("All {n} subs finished") },
        // Code can say what failed or is left over, never that the work is right.
        tone: (sum.tests_failed > 0 || sum.uncommitted > 0 || sum.not_merged > 0).then(|| "bad".to_string()),
        text: sum_text(&sum),
        sum: Some(sum),
        set_key: Some(key),
        ..CardEntry::default()
    })
}
