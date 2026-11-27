//! One triage run: every unprocessed voice note, one lean model call each, the
//! daemon validating the reply, filing todos, then recording the decision in the
//! note's front matter. Each note leaves one line in the app log and one in
//! `triage-log.jsonl`, so what the pass did is never a guess.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;

use super::lean::{TriageError, Triager};
use super::notes::{self, Outcome, VoiceNote};
use super::projects::Candidate;
use super::prompt::{self, Decision, MAX_NOTE_CHARS};
use super::todos::{self, Filed};

/// Notes one run takes unless asked for more: each is a billed call, and the run
/// is something Joe starts, so a backlog is worked down over a few runs.
pub const DEFAULT_LIMIT: usize = 10;

pub struct Deps {
    pub vault: Option<PathBuf>,
    pub projects: Vec<Candidate>,
    pub triager: Arc<dyn Triager>,
    /// This machine's todo label (`pc`).
    pub device: String,
    /// The JSONL log; `None` skips it (the app log line is written regardless).
    pub log_file: Option<PathBuf>,
    /// Local `YYYY-MM-DD HH:MM`, injected so a test sees a fixed time.
    pub now: Arc<dyn Fn() -> String + Send + Sync>,
}

#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub limit: usize,
    /// Ask the model and report, but write no todo and touch no note.
    pub dry_run: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { limit: DEFAULT_LIMIT, dry_run: false }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NoteReport {
    pub note: String,
    /// `todo`, `left`, `skipped` (not looked at, still unprocessed) or `error`.
    pub result: &'static str,
    pub reason: String,
    pub todos: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Report {
    pub notes: Vec<NoteReport>,
    /// Unprocessed notes this run did not reach (past the limit, or after an abort).
    pub remaining: usize,
    /// Set when the run stopped early because no call can work.
    pub aborted: Option<String>,
    pub dry_run: bool,
}

/// One run at a time: two would triage the same notes twice.
static RUNNING: AtomicBool = AtomicBool::new(false);

pub struct RunGuard;

impl RunGuard {
    pub fn take() -> Option<Self> {
        RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| RunGuard)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn log_note(deps: &Deps, r: &NoteReport) {
    // The reason is the model's own sentence about a private note, so it goes to the
    // file Joe reads and not to the app log (which release reports aggregate).
    log::info!("voice triage: {} -> {} {}", r.note, r.result, r.todos.join(", "));
    let Some(path) = &deps.log_file else { return };
    let line = json!({"at": (deps.now)(), "note": r.note, "result": r.result, "reason": r.reason, "todos": r.todos});
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut f| writeln!(f, "{line}")) {
        log::warn!("voice triage: cannot append to {}: {e}", path.display());
    }
}

fn report(note: &VoiceNote, result: &'static str, reason: impl Into<String>, todos: Vec<String>) -> NoteReport {
    NoteReport { note: note.name(), result, reason: reason.into(), todos }
}

pub async fn run(deps: &Deps, opts: Options) -> Report {
    let mut out = Report { dry_run: opts.dry_run, ..Report::default() };
    let Some(vault) = deps.vault.as_deref() else {
        out.aborted = Some("no vault found (open it in Obsidian, or set CC_VOICE_VAULT_DIR)".into());
        return out;
    };
    let pending = notes::list_unprocessed(vault);
    let total = pending.len();
    let system = prompt::system_prompt(&deps.projects);
    let mut tracked: HashMap<PathBuf, bool> = HashMap::new();
    for note in pending.into_iter().take(opts.limit.max(1)) {
        let (r, abort) = triage_note(deps, opts, &system, &note, &mut tracked).await;
        log_note(deps, &r);
        out.notes.push(r);
        if abort.is_some() {
            out.aborted = abort;
            break;
        }
    }
    // Skipped and errored notes stay unprocessed, and so does everything on a dry run.
    let marked = if opts.dry_run { 0 } else { out.notes.iter().filter(|n| matches!(n.result, "todo" | "left")).count() };
    out.remaining = total.saturating_sub(marked);
    out
}

/// The report row, plus a reason to stop the whole run when no call can work.
type Step = (NoteReport, Option<String>);

async fn triage_note(deps: &Deps, opts: Options, system: &str, note: &VoiceNote, tracked: &mut HashMap<PathBuf, bool>) -> Step {
    let now = (deps.now)();
    if note.body.trim().is_empty() {
        return (settle(opts, note, &now, Outcome { triage: "left", reason: "the note has no text".into(), todos: vec![] }), None);
    }
    if note.body.chars().count() > MAX_NOTE_CHARS {
        return (report(note, "skipped", format!("longer than {MAX_NOTE_CHARS} characters; left unprocessed"), vec![]), None);
    }
    let reply = match deps.triager.decide(system, &prompt::frame_note(&note.created, &note.body)).await {
        Ok(r) => r,
        Err(TriageError::Unavailable(e)) => return (report(note, "error", format!("cannot run: {e}"), vec![]), Some(e)),
        Err(TriageError::Failed(e)) => return (report(note, "error", e, vec![]), None),
    };
    let Some(decision) = prompt::decide(&reply, &note.body, &deps.projects) else {
        return (report(note, "error", "the model's reply broke the output contract; left unprocessed", vec![]), None);
    };
    let mut filed = Vec::new();
    if !opts.dry_run {
        for spec in &decision.todos {
            let Some(project) = deps.projects.iter().find(|c| c.key == spec.project) else { continue };
            let is_tracked = match tracked.get(&project.path) {
                Some(t) => *t,
                None => {
                    let t = todos::backlog_is_tracked(&project.path).await;
                    tracked.insert(project.path.clone(), t);
                    t
                }
            };
            let today = now.split(' ').next().unwrap_or(&now);
            let result = todos::heal_excludes(&project.path, is_tracked)
                .and_then(|_| todos::file_todo(&project.path, &deps.device, spec, &note.name(), &note.created, today));
            match result {
                Ok(Filed::Written { id, .. }) => filed.push(format!("{id} ({})", project.key)),
                Ok(Filed::Duplicate { id }) => filed.push(format!("{id} ({}, already filed)", project.key)),
                // Todos written before this one stay (a retry finds them as duplicates);
                // the note stays unprocessed so the retry happens.
                Err(e) => return (report(note, "error", format!("cannot file a todo in {}: {e}", project.key), filed), None),
            }
        }
    } else {
        filed = decision.todos.iter().map(|t| format!("(dry run) {} ({})", t.title, t.project)).collect();
    }
    let outcome = Outcome { triage: if decision.todos.is_empty() { "left" } else { "todo" }, reason: reason_of(&decision), todos: filed };
    (settle(opts, note, &now, outcome), None)
}

fn reason_of(d: &Decision) -> String {
    let mut parts = Vec::new();
    if !d.reason.is_empty() {
        parts.push(d.reason.clone());
    }
    if !d.refused.is_empty() {
        parts.push(format!("refused: {}", d.refused.join("; ")));
    }
    if parts.is_empty() {
        "nothing in the note asks for work in a named project".to_string()
    } else {
        parts.join(" | ")
    }
}

/// Records the outcome in the note (not on a dry run) and turns it into the report row.
fn settle(opts: Options, note: &VoiceNote, now: &str, outcome: Outcome) -> NoteReport {
    if !opts.dry_run {
        if let Err(e) = notes::mark_processed(note, now, &outcome) {
            // The todos (if any) are filed; the note stays unprocessed and a retry
            // finds them as duplicates instead of filing them twice.
            return report(note, "error", e, outcome.todos);
        }
    }
    report(note, outcome.triage, outcome.reason, outcome.todos)
}
