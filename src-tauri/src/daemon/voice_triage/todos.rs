//! Writes a todo into a project's `.claude/todos/` the way the todo contract
//! (`~/.claude/refs/ai-todos-format.md`) says a writer must: a device-labelled id
//! reserved with a no-overwrite marker, never a reused number, a duplicate of an
//! existing title refused, and the git excludes the backlog depends on healed.

use std::io::Write;
use std::path::{Path, PathBuf};

use super::prompt::TodoSpec;
use crate::project_dashboard::todo_ids::parse_stem;

#[derive(Debug, PartialEq)]
pub enum Filed {
    /// A new todo with this id.
    Written { id: String, path: PathBuf },
    /// A todo with the same title is already in the backlog or `done/`.
    Duplicate { id: String },
}

pub fn todos_dir(project: &Path) -> PathBuf {
    project.join(".claude").join("todos")
}

/// `fix-the-login-redirect`: lowercase words, hyphens, at most 60 characters.
pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let cut: String = slug.trim_matches('-').chars().take(60).collect();
    let cut = cut.trim_matches('-').to_string();
    if cut.is_empty() { "voice-note-todo".to_string() } else { cut }
}

/// Every todo number this `device` has used in `dir` (backlog, `done/`, and live
/// reservation markers), with the slug of each file for the duplicate check.
fn existing(dir: &Path, device: &str) -> (u64, Vec<(String, String)>) {
    let mut max = 0u64;
    let mut slugs = Vec::new();
    for folder in [dir.to_path_buf(), dir.join("done")] {
        let Ok(rd) = std::fs::read_dir(&folder) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".md").or_else(|| name.strip_suffix(".reserved"));
            let Some(parsed) = stem.and_then(parse_stem) else { continue };
            if parsed.key.label == device {
                max = max.max(parsed.key.number);
            }
            if name.ends_with(".md") && !parsed.slug.is_empty() {
                slugs.push((parsed.key.canonical(), parsed.slug));
            }
        }
    }
    (max, slugs)
}

/// Model text with heading marks stripped, so a line injected through the
/// transcript cannot open a section of its own in the todo.
fn plain(text: &str) -> String {
    text.lines().map(|l| l.trim_start_matches('#').trim_start()).collect::<Vec<_>>().join("\n")
}

/// The todo's file text, in the contract's shape. `note_name` is the vault note it
/// came from; the transcript stays there.
pub fn render(spec: &TodoSpec, note_name: &str, recorded: &str, today: &str) -> String {
    let mut s = String::from("<!-- Claim before executing: .claude/todos/.claims/ per refs/ai-todos-format.md -->\n");
    s.push_str(&format!("# {}\n\n**Type:** task\n**Origin:** ai\n**Summary:** {}\n\n", spec.title, spec.summary));
    if !spec.quote.is_empty() {
        s.push_str(&format!("## Why\n\nJoe, in a voice note recorded {recorded}: \"{}\"\n\n", spec.quote));
    }
    s.push_str(&format!("## Goal\n\n{}\n\n", plain(&spec.goal)));
    s.push_str(&format!(
        "## Context\n\nFiled on {today} by the voice-note triage pass from the vault note `Inbox/Voice/{note_name}` \
(the transcript, and the audio it links, stay there). The pass read the note once and judged it names this project \
and a concrete action; it did not look at the code, so check the claim against the repo before acting on it. \
The Goal, Approach and Acceptance are a model's reading of the transcript; only the quote under Why is Joe's own words.\n\n"
    ));
    s.push_str("## Approach\n\n");
    if spec.approach.is_empty() {
        s.push_str("The note gave no steps. Work out the approach from the Goal and the code.\n\n");
    } else {
        s.push_str(&format!("{}\n\n", plain(&spec.approach)));
    }
    s.push_str("## Acceptance\n\n");
    if spec.acceptance.is_empty() {
        s.push_str("- The Goal holds and the project's own checks pass.\n");
    }
    for a in &spec.acceptance {
        s.push_str(&format!("- {a}\n"));
    }
    s
}

/// Files `spec` in `project`'s backlog. Creates `.claude/todos/` when missing.
pub fn file_todo(project: &Path, device: &str, spec: &TodoSpec, note_name: &str, recorded: &str, today: &str) -> Result<Filed, String> {
    let dir = todos_dir(project);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let slug = slugify(&spec.title);
    let (max, slugs) = existing(&dir, device);
    if let Some((id, _)) = slugs.iter().find(|(_, s)| *s == slug) {
        return Ok(Filed::Duplicate { id: id.clone() });
    }
    // The marker is the reservation: creating it fails when another session got
    // the number first, and the loop moves on to the next one.
    let mut number = max + 1;
    let (id, marker) = loop {
        let id = format!("{device}-{number:04}");
        let marker = dir.join(format!("{id}-.reserved"));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&marker) {
            Ok(_) => break (id, marker),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => number += 1,
            Err(e) => return Err(format!("cannot reserve a todo id in {}: {e}", dir.display())),
        }
    };
    let path = dir.join(format!("{id}-{slug}.md"));
    let written = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).and_then(|mut f| {
        f.write_all(render(spec, note_name, recorded, today).as_bytes())?;
        f.sync_all()
    });
    // The marker is consumed here either way; a failed write leaves no stray file.
    let _ = std::fs::remove_file(&marker);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&path);
        return Err(format!("cannot write {}: {e}", path.display()));
    }
    Ok(Filed::Written { id, path })
}

/// Whether anything under `.claude/todos/` is git-tracked: the dev opted this
/// project into tracking its backlog, so the folder must not be excluded.
pub async fn backlog_is_tracked(project: &Path) -> bool {
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("-C").arg(project).args(["ls-files", ".claude/todos/"]);
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    crate::util::process::hide_console_tokio(&mut cmd);
    match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        _ => false,
    }
}

/// Adds the lines the contract keeps out of git to `.git/info/exclude`: the whole
/// backlog unless it is tracked, and always the claims and reservation markers.
/// Only for a plain checkout (`.git` a folder); a worktree's or submodule's
/// `.git` is a file and its backlog lives in the main checkout, so it is left.
pub fn heal_excludes(project: &Path, tracked: bool) -> Result<(), String> {
    let git = project.join(".git");
    if !git.is_dir() {
        return Ok(());
    }
    let file = git.join("info").join("exclude");
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    let mut wanted: Vec<&str> = Vec::new();
    if !tracked {
        wanted.push(".claude/todos/");
    }
    wanted.push(".claude/todos/.claims/");
    wanted.push(".claude/todos/*-.reserved");
    let missing: Vec<&str> = wanted.into_iter().filter(|w| !current.lines().any(|l| l.trim() == *w)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(git.join("info")).map_err(|e| e.to_string())?;
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for m in missing {
        text.push_str(m);
        text.push('\n');
    }
    std::fs::write(&file, text).map_err(|e| format!("cannot update {}: {e}", file.display()))
}
