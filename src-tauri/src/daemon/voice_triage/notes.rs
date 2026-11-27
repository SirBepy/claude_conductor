//! The vault's voice notes as the triage pass sees them: which ones are still
//! `status: unprocessed`, and the one in-place edit it ever makes to a note, the
//! front matter after a decision. The body is never touched, and a note is never
//! deleted or recreated.

use std::path::{Path, PathBuf};

/// Notes `voice_transcribe::vault` wrote (and handy_scripts' exporter before it).
const NOTE_TYPE: &str = "voice-transcript";

/// One note read from `Inbox/Voice`.
#[derive(Clone, Debug, PartialEq)]
pub struct VoiceNote {
    pub path: PathBuf,
    /// The whole file as read; `mark_processed` refuses to write when the file no
    /// longer equals it, so an edit made while the model was thinking survives.
    pub raw: String,
    /// `created:` from the front matter, `""` when absent.
    pub created: String,
    pub body: String,
}

impl VoiceNote {
    /// The file name without its folder, for logs and the todo's context.
    pub fn name(&self) -> String {
        self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

/// What the pass decided for a note, written to its front matter.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// `todo` or `left`.
    pub triage: &'static str,
    pub reason: String,
    /// `pc-0123 (project)` per todo filed.
    pub todos: Vec<String>,
}

pub fn inbox(vault: &Path) -> PathBuf {
    vault.join("Inbox").join("Voice")
}

/// Splits a note into the front matter's lines (without the delimiters) and what
/// follows, as byte offsets into `raw`: `(front_start, front_end)` where
/// `raw[front_end..]` begins with the closing `---`.
fn front_span(raw: &str) -> Option<(usize, usize)> {
    let first = raw.split_inclusive('\n').next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let start = first.len();
    let mut at = start;
    for line in raw[start..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((start, at));
        }
        at += line.len();
    }
    None
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let stripped = v
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')));
    stripped.unwrap_or(v).trim().to_string()
}

fn scalar(front: &str, key: &str) -> Option<String> {
    front.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key).then(|| unquote(v))
    })
}

/// A note's parsed form, or `None` when it is not an unprocessed voice transcript.
pub fn parse_unprocessed(path: &Path, raw: &str) -> Option<VoiceNote> {
    let (start, end) = front_span(raw)?;
    let front = &raw[start..end];
    if scalar(front, "type").as_deref() != Some(NOTE_TYPE) || scalar(front, "status").as_deref() != Some("unprocessed") {
        return None;
    }
    let closing = raw[end..].split_inclusive('\n').next().map(str::len).unwrap_or(0);
    Some(VoiceNote {
        path: path.to_path_buf(),
        raw: raw.to_string(),
        created: scalar(front, "created").unwrap_or_default(),
        body: raw[end + closing..].trim().to_string(),
    })
}

/// Every unprocessed voice note in `<vault>/Inbox/Voice`, oldest name first (the
/// exporter starts a name with the recording's date). An unreadable file is
/// skipped: a half-synced vault must not stop the pass.
pub fn list_unprocessed(vault: &Path) -> Vec<VoiceNote> {
    let Ok(rd) = std::fs::read_dir(inbox(vault)) else { return Vec::new() };
    let mut notes: Vec<VoiceNote> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .filter_map(|p| {
            let raw = std::fs::read_to_string(&p).ok()?;
            parse_unprocessed(&p, &raw)
        })
        .collect();
    notes.sort_by(|a, b| a.path.cmp(&b.path));
    notes
}

fn yaml_quote(s: &str) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    format!("\"{}\"", flat.trim().replace('\\', "\\\\").replace('"', "'"))
}

/// The note's text with `status` flipped to `processed` and the decision recorded
/// right after it. Every other byte, the whole body included, is kept as is.
pub fn processed_text(raw: &str, now: &str, outcome: &Outcome) -> Option<String> {
    let (start, end) = front_span(raw)?;
    let front = &raw[start..end];
    let eol = if front.contains("\r\n") { "\r\n" } else { "\n" };
    let mut new_front = String::with_capacity(front.len() + 160);
    let mut flipped = false;
    for line in front.split_inclusive('\n') {
        let is_status = !flipped && line.split_once(':').is_some_and(|(k, _)| k.trim() == "status");
        if is_status {
            flipped = true;
            new_front.push_str(&format!("status: processed{eol}"));
            new_front.push_str(&format!("processed: {now}{eol}"));
            new_front.push_str(&format!("triage: {}{eol}", outcome.triage));
            new_front.push_str(&format!("triage_reason: {}{eol}", yaml_quote(&outcome.reason)));
            if !outcome.todos.is_empty() {
                let items: Vec<String> = outcome.todos.iter().map(|t| yaml_quote(t)).collect();
                new_front.push_str(&format!("triage_todos: [{}]{eol}", items.join(", ")));
            }
        } else {
            new_front.push_str(line);
        }
    }
    flipped.then(|| format!("{}{}{}", &raw[..start], new_front, &raw[end..]))
}

/// Records `outcome` in the note. Reads the file again first: if it is not
/// byte-for-byte what the model saw (Joe or another pass edited it), nothing is
/// written and the note stays unprocessed for the next run.
pub fn mark_processed(note: &VoiceNote, now: &str, outcome: &Outcome) -> Result<(), String> {
    let current = std::fs::read_to_string(&note.path).map_err(|e| format!("cannot read {}: {e}", note.name()))?;
    if current != note.raw {
        return Err(format!("{} changed while it was being triaged; left as it is", note.name()));
    }
    let text = processed_text(&current, now, outcome).ok_or_else(|| format!("{} has no status line to update", note.name()))?;
    crate::daemon::voice_upload::store::write_file_atomic(&note.path, text.as_bytes())
}
