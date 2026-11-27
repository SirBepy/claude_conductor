//! Voice-note transcripts into the Obsidian vault: one Markdown note per
//! recording in `Inbox/Voice`, ported from `handy_scripts`' `vault_export.rs` so
//! both writers feed the same later pass. That pass looks for `status:
//! unprocessed` and splits each transcript per topic, so this module only lands
//! the raw text and the pointer to the audio, and never touches a note that
//! already exists.

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, TimeZone};

/// Terms from the vault's `Glossary.md`: one bullet per term; anything after the
/// first spaced hyphen is a note for humans and Claude, not for the engine.
pub fn parse_glossary(markdown: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for line in markdown.lines() {
        let Some(item) = line.trim_start().strip_prefix("- ") else { continue };
        let term = item.split(" - ").next().unwrap_or("").trim();
        if !term.is_empty() && !terms.iter().any(|t| t == term) {
            terms.push(term.to_string());
        }
    }
    terms
}

/// Glossary terms for the vault; empty with no vault or no file. Read for every
/// job, so an edit to `Glossary.md` reaches the next recording.
pub fn read_glossary(vault: &Path) -> Vec<String> {
    std::fs::read_to_string(vault.join("Glossary.md"))
        .map(|text| parse_glossary(&text))
        .unwrap_or_default()
}

/// A file stem safe on Windows: reserved characters become spaces, and the
/// result is trimmed and capped so the full path stays short.
pub fn sanitize_stem(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(80).collect();
    let trimmed = capped.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "voice note".to_string()
    } else {
        trimmed.to_string()
    }
}

/// What one note says about its recording.
pub struct Note<'a> {
    /// Free text naming where the audio came from, shown as `source:`.
    pub source: &'a str,
    pub created: DateTime<Local>,
    pub language: Option<&'a str>,
    /// The published `.opus` on this PC; the note links to it so a person (or the
    /// later pass) can listen to what the transcript got wrong.
    pub audio: &'a Path,
    pub device_id: &'a str,
    pub recording_id: &'a str,
    pub text: &'a str,
}

pub fn local_time(ms: u64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Local::now)
}

/// `file:///C:/a%20b/x.opus` for a Windows or Unix path.
pub fn file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !raw.starts_with('/') {
        out.push('/');
    }
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Frontmatter plus the transcript. The keys up to `status` are handy_scripts'
/// own; `audio`, `device` and `recording` are this app's addition. `audio` is
/// single-quoted YAML so a Windows path's backslashes stay literal.
pub fn build_markdown(note: &Note) -> String {
    let mut out = String::from("---\ntype: voice-transcript\n");
    out.push_str(&format!("source: \"{}\"\n", note.source.replace('"', "'")));
    out.push_str(&format!("created: {}\n", note.created.format("%Y-%m-%d %H:%M")));
    if let Some(language) = note.language {
        out.push_str(&format!("language: {language}\n"));
    }
    out.push_str("status: unprocessed\n");
    out.push_str(&format!("audio: '{}'\n", note.audio.to_string_lossy().replace('\'', "''")));
    out.push_str(&format!("device: {}\nrecording: {}\n---\n\n", note.device_id, note.recording_id));
    let name = note.audio.file_name().and_then(|n| n.to_str()).unwrap_or("audio");
    out.push_str(&format!("Audio: [{name}]({})\n\n", file_url(note.audio)));
    out.push_str(note.text.trim());
    out.push('\n');
    out
}

/// Writes `<stem>.md`, or `<stem> (2).md` and up when that name is taken. The
/// file is created with `create_new`, so even a racing writer cannot overwrite a
/// note Claude may already have processed.
fn write_new(dir: &Path, stem: &str, content: &str) -> Result<PathBuf, String> {
    for n in 1u32.. {
        let name = if n == 1 { format!("{stem}.md") } else { format!("{stem} ({n}).md") };
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let written = f.write_all(content.as_bytes()).and_then(|_| f.sync_all());
                if let Err(e) = written {
                    // This call created the file, so removing it is not touching
                    // anyone's note; a half note left behind would be read as a real
                    // unprocessed one while the retry writes the whole one as "(2)".
                    drop(f);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("cannot write {}: {e}", path.display()));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
        }
    }
    unreachable!("an unbounded counter always finds a free name")
}

/// The note lands in `<vault>/Inbox/Voice`.
pub fn export(vault: &Path, note: &Note) -> Result<PathBuf, String> {
    let dir = vault.join("Inbox").join("Voice");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let stem = format!("{} {}", note.created.format("%Y-%m-%d %H-%M"), sanitize_stem(note.source));
    write_new(&dir, &stem, &build_markdown(note))
}

/// `CC_VOICE_VAULT_DIR`, then `CC_VAULT_DIR` and the vault Obsidian last had
/// open (`people::vault_dir`). `None` means transcripts wait on the PC.
pub fn vault_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CC_VOICE_VAULT_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir.trim()));
        }
    }
    crate::people::vault_dir()
}
