//! The Backlog panel's write actions on `.claude/todos/`: archive a todo into
//! `done/` (and undo it), move it between PLAN.md groups, reorder the groups.
//! Desktop-local by construction: these are only registered as Tauri commands,
//! never as daemon RPC methods, so no phone or peer transport can reach them.

use super::md_scan::checkbox;
use super::plan_edit::{edit_plan, reopened, LineDoc, PREAMBLE_GROUP};
use super::todo_ids::{find_todo_file, list_todo_files, parse_file_name, TodoKey, Wanted};
use super::todo_stats::live_claim_keys;
use crate::ipc::ai_todos::AiTodoArchived;
use std::path::{Path, PathBuf};

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn key_of(path: &Path) -> Result<TodoKey, String> {
    parse_file_name(&file_name(path))
        .map(|p| p.key)
        .ok_or_else(|| format!("{} is not a todo file", path.display()))
}

/// The canonical id (`pc-1407`) of the todo `id` names, or why none does.
pub fn canonical_id_of(todos_dir: &Path, id: &str, device: &str) -> Result<String, String> {
    Ok(key_of(&find_todo_file(todos_dir, id, device)?)?.canonical())
}

/// Appends `- note` under the todo's `## Notes` section, creating the section
/// at the end of the file when it has none. Later lines of a multi-line note
/// are indented so they stay inside the bullet.
fn append_note(content: &str, note: &str) -> String {
    let mut doc = LineDoc::parse(content);
    let mut lines = note.lines().map(str::trim_end).filter(|l| !l.trim().is_empty());
    let mut bullets: Vec<String> = lines.next().map(|first| vec![format!("- {}", first.trim_start())]).unwrap_or_default();
    bullets.extend(lines.map(|l| format!("  {l}")));
    let headings = doc.headings();
    let notes = headings.iter().position(|(_, t)| t.eq_ignore_ascii_case("notes"));
    let mut at = match notes {
        Some(h) => {
            let end = headings.get(h + 1).map_or(doc.len(), |(i, _)| *i);
            match doc.last_nonblank(headings[h].0 + 1, end) {
                Some(last) => last + 1,
                None => {
                    doc.insert(headings[h].0 + 1, "");
                    headings[h].0 + 2
                }
            }
        }
        None => {
            doc.terminate();
            let end = doc.len();
            if doc.last_nonblank(0, end).is_some() {
                doc.insert(end, "");
            }
            let heading_at = doc.len();
            doc.insert(heading_at, "## Notes");
            doc.insert(heading_at + 1, "");
            heading_at + 2
        }
    };
    for b in bullets {
        doc.insert(at, &b);
        at += 1;
    }
    doc.to_text()
}

/// Moves a todo into `done/`, appending `note` under `## Notes` when it is not
/// blank, and prunes its PLAN.md line. Refuses a todo with a live claim: a
/// chat is working on it. Returns what `unarchive` needs to put it all back.
pub fn archive(todos_dir: &Path, id: &str, note: Option<&str>, device: &str) -> Result<AiTodoArchived, String> {
    let path = find_todo_file(todos_dir, id, device)?;
    let key = key_of(&path)?;
    if live_claim_keys(todos_dir).contains(&key) {
        return Err(format!(
            "{} has a live claim: a chat is working on it. Archive it once that chat is done.",
            key.canonical()
        ));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let original = raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_string();
    let name = file_name(&path);
    let done_dir = todos_dir.join("done");
    let done_path = done_dir.join(&name);
    if done_path.exists() {
        return Err(format!("done/{name} already exists; refusing to overwrite it"));
    }
    let content = match note.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => append_note(&original, n),
        None => original.clone(),
    };
    std::fs::create_dir_all(&done_dir).map_err(|e| format!("could not create {}: {e}", done_dir.display()))?;
    std::fs::write(&done_path, content).map_err(|e| format!("could not write {}: {e}", done_path.display()))?;

    let wanted = Wanted::Key(key.clone());
    let pruned = edit_plan(todos_dir, false, |doc| {
        let before = doc.clone();
        let removed = doc.remove_item(&wanted);
        Ok(PlanRestore { lines: describe_removed(&before, &removed) })
    })
    .inspect_err(|_| {
        let _ = std::fs::remove_file(&done_path);
    })?;
    if let Err(e) = std::fs::remove_file(&path) {
        let _ = std::fs::remove_file(&done_path);
        let _ = reinsert_plan_lines(todos_dir, &key, &pruned);
        return Err(format!("could not move {name} out of the backlog: {e}"));
    }
    Ok(AiTodoArchived {
        id: key.canonical(),
        done_path: done_path.to_string_lossy().into_owned(),
        original_path: path.to_string_lossy().into_owned(),
        original_content: original,
        plan_line: pruned.encode(),
        plan_line_index: pruned.lines.first().map(|l| l.index as u32),
    })
}

/// One PLAN.md line `archive` pruned, with where it sat. The index alone goes
/// stale as soon as another session edits the plan, so the group and the item
/// line above it travel along and `unarchive` finds the spot again from those.
#[derive(serde::Serialize, serde::Deserialize)]
struct PlanLine {
    line: String,
    /// The `## ` group it was under, `Plan` for the lines above the first one.
    /// Empty only in a record from before groups were saved: `index` rules then.
    group: String,
    /// The nearest checkbox line above it in that group (a removed sibling
    /// counts, so adjacent duplicates restore in order); `None` when it was the
    /// group's first item.
    after: Option<String>,
    /// Its line index before the prune.
    index: usize,
}

/// Every PLAN.md line that named the todo. `AiTodoArchived` has one string
/// field for the pruned line, so the whole record rides in it as JSON.
#[derive(serde::Serialize, serde::Deserialize)]
struct PlanRestore {
    lines: Vec<PlanLine>,
}

impl PlanRestore {
    fn encode(&self) -> Option<String> {
        if self.lines.is_empty() {
            return None;
        }
        serde_json::to_string(self).ok()
    }

    /// A record from before groups were saved holds one bare line plus its index.
    fn decode(plan_line: &str, index: Option<u32>) -> PlanRestore {
        serde_json::from_str(plan_line).unwrap_or_else(|_| PlanRestore {
            lines: vec![PlanLine {
                line: plan_line.to_string(),
                group: String::new(),
                after: None,
                index: index.unwrap_or(0) as usize,
            }],
        })
    }
}

/// Records where each of `removed` (index, line) sat in `before`.
fn describe_removed(before: &LineDoc, removed: &[(usize, String)]) -> Vec<PlanLine> {
    let headings = before.headings();
    let fenced = before.fence_flags();
    removed
        .iter()
        .map(|(index, line)| {
            let heading = headings.iter().rev().find(|(h, _)| h < index);
            let (group, floor) = match heading {
                Some((h, title)) => (title.clone(), h + 1),
                None => (PREAMBLE_GROUP.to_string(), 0),
            };
            let after = (floor..*index)
                .rev()
                .find(|&i| !fenced[i] && checkbox(before.line(i)).is_some())
                .map(|i| before.line(i).to_string());
            PlanLine { line: line.clone(), group, after, index: *index }
        })
        .collect()
}

/// Puts every pruned line back (unless the todo is planned again meanwhile).
fn reinsert_plan_lines(todos_dir: &Path, key: &TodoKey, saved: &PlanRestore) -> Result<(), String> {
    let wanted = Wanted::Key(key.clone());
    edit_plan(todos_dir, true, |doc| {
        if doc.has_item(&wanted) {
            return Ok(());
        }
        // Lines come in file order, so each search for a neighbour starts where
        // the previous line landed: identical neighbour lines resolve in order.
        let mut cursor = 0;
        for line in &saved.lines {
            cursor = place(doc, line, cursor);
        }
        Ok(())
    })
}

/// Inserts one saved line and returns the index it landed at. Under the
/// neighbour it was below, after any indented notes of that neighbour; first
/// in its group when it was first; at the end of the group when the neighbour
/// is gone; in a new group at the end of the file when the group is gone.
fn place(doc: &mut LineDoc, saved: &PlanLine, cursor: usize) -> usize {
    if saved.group.is_empty() {
        let at = saved.index.min(doc.len());
        doc.insert(at, &saved.line);
        return at;
    }
    let headings = doc.headings();
    let span = match headings.iter().position(|(_, title)| *title == saved.group) {
        Some(h) => Some((headings[h].0 + 1, headings.get(h + 1).map_or(doc.len(), |(i, _)| *i))),
        None if saved.group == PREAMBLE_GROUP => Some((0, headings.first().map_or(doc.len(), |(i, _)| *i))),
        None => None,
    };
    let Some((lo, hi)) = span else {
        doc.insert_into_group(&saved.group, &saved.line, 0, &|_| true);
        return doc.len() - 1;
    };
    let fenced = doc.fence_flags();
    let is_item = |doc: &LineDoc, i: usize| !fenced[i] && checkbox(doc.line(i)).is_some();
    let end_of_group = |doc: &LineDoc| doc.last_nonblank(lo, hi).map_or(lo, |i| i + 1);
    let at = match &saved.after {
        None => (lo..hi).find(|&i| is_item(doc, i)).unwrap_or_else(|| end_of_group(doc)),
        Some(after) => match (lo.max(cursor)..hi).find(|&i| !fenced[i] && doc.line(i) == after.as_str()) {
            Some(i) => {
                let mut at = i + 1;
                while at < hi && doc.line(at).starts_with([' ', '\t']) && !doc.line(at).trim().is_empty() {
                    at += 1;
                }
                at
            }
            None => end_of_group(doc),
        },
    };
    doc.insert(at, &saved.line);
    at
}

/// Whether `p`'s directory is `dir`, tolerating a trailing separator.
fn is_in(p: &Path, dir: &Path) -> bool {
    p.parent().is_some_and(|parent| crate::util::same_dir(parent, dir))
}

/// Undoes `archive`: writes the original content back, deletes the `done/`
/// copy and re-inserts every PLAN.md line the archive pruned, by group and
/// neighbour (unless the id is already planned again). The paths come from the caller, so both must sit in
/// this repo's todos folder under the same file name.
pub fn unarchive(todos_dir: &Path, archived: &AiTodoArchived) -> Result<(), String> {
    let original = PathBuf::from(&archived.original_path);
    let done = PathBuf::from(&archived.done_path);
    if !is_in(&original, todos_dir) || !is_in(&done, &todos_dir.join("done")) || file_name(&original) != file_name(&done) {
        return Err("the archive record does not point into this project's todos".to_string());
    }
    if !super::todo_stats::is_backlog_file(&original) {
        return Err(format!("{} is not a todo file", original.display()));
    }
    if original.exists() {
        return Err(format!("{} already exists; nothing was restored", original.display()));
    }
    std::fs::write(&original, &archived.original_content)
        .map_err(|e| format!("could not restore {}: {e}", original.display()))?;
    match std::fs::remove_file(&done) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("restored the todo but could not remove {}: {e}", done.display())),
    }
    if let Some(plan_line) = &archived.plan_line {
        let key = key_of(&original)?;
        reinsert_plan_lines(todos_dir, &key, &PlanRestore::decode(plan_line, archived.plan_line_index))
            .map_err(|e| format!("restored the todo but not its PLAN.md line: {e}"))?;
    }
    Ok(())
}

/// Puts the todo `id` names under `## <group>` at `index` among that group's
/// visible items, or removes it from the plan when `group` is `None`. An
/// existing line keeps its label and `[P]` marker; a new one is
/// `- [ ] <canonical id>`. A missing PLAN.md is created as `# Plan` when there
/// is something to put in it.
pub fn plan_move(todos_dir: &Path, id: &str, group: Option<&str>, index: u32, device: &str) -> Result<(), String> {
    let key = key_of(&find_todo_file(todos_dir, id, device)?)?;
    let files = list_todo_files(todos_dir);
    let visible = |w: &Wanted| files.iter().any(|(k, _)| w.matches(k));
    let wanted = Wanted::Key(key.clone());
    edit_plan(todos_dir, group.is_some(), |doc| {
        let removed = doc.remove_item(&wanted);
        if let Some(group) = group {
            let item = removed
                .first()
                .and_then(|(_, line)| reopened(line))
                .unwrap_or_else(|| format!("- [ ] {}", key.canonical()));
            doc.insert_into_group(group, &item, index as usize, &visible);
        }
        Ok(())
    })
}

/// Reorders whole `## ` sections of PLAN.md to follow `groups`.
pub fn plan_reorder_groups(todos_dir: &Path, groups: &[String]) -> Result<(), String> {
    edit_plan(todos_dir, false, |doc| {
        doc.reorder_groups(groups);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODO: &str = "# Do the thing\n\n**Type:** task\n**Origin:** dev\n**Summary:** Does it.\n\n## Goal\n\nDone.\n";

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in files {
            let p = dir.path().join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    fn read(dir: &Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    #[test]
    fn archive_moves_the_file_prunes_the_plan_and_unarchive_restores_all_of_it() {
        let plan = "# Plan\n\n## Release\n- [ ] pc-0001\n- [ ] pc-0002 - second\n\n## Later\n- [ ] pc-0003\n";
        let dir = repo(&[("pc-0002-two.md", TODO), ("pc-0001-one.md", "# One\n"), ("PLAN.md", plan)]);
        let d = dir.path();
        let a = archive(d, "pc-2", None, "pc").unwrap();
        assert_eq!(a.id, "pc-0002");
        assert!(a.plan_line.as_deref().is_some_and(|l| l.contains("- [ ] pc-0002 - second")));
        assert_eq!(a.plan_line_index, Some(4));
        assert!(!d.join("pc-0002-two.md").exists());
        assert_eq!(read(d, "done/pc-0002-two.md"), TODO);
        assert_eq!(read(d, "PLAN.md"), "# Plan\n\n## Release\n- [ ] pc-0001\n\n## Later\n- [ ] pc-0003\n");

        unarchive(d, &a).unwrap();
        assert_eq!(read(d, "pc-0002-two.md"), TODO);
        assert!(!d.join("done/pc-0002-two.md").exists());
        assert_eq!(read(d, "PLAN.md"), plan, "the plan line is back at its old index");
    }

    #[test]
    fn a_note_goes_under_an_existing_notes_section_and_undo_drops_it() {
        let todo = format!("{TODO}\n## Notes\n\n- earlier\n\n## Tail\nx\n");
        let dir = repo(&[("pc-0005-n.md", &todo)]);
        let a = archive(dir.path(), "pc-5", Some("  shipped in abc123\nsecond line  "), "pc").unwrap();
        let done = read(dir.path(), "done/pc-0005-n.md");
        assert!(done.contains("- earlier\n- shipped in abc123\n  second line\n\n## Tail"), "{done}");
        assert_eq!(a.original_content, todo, "undo restores the pre-note text");
        unarchive(dir.path(), &a).unwrap();
        assert_eq!(read(dir.path(), "pc-0005-n.md"), todo);
    }

    #[test]
    fn a_note_creates_the_notes_section_at_the_end() {
        let dir = repo(&[("pc-0005-n.md", TODO)]);
        archive(dir.path(), "pc-5", Some("done early"), "pc").unwrap();
        assert_eq!(read(dir.path(), "done/pc-0005-n.md"), format!("{TODO}\n## Notes\n\n- done early\n"));
    }

    #[test]
    fn a_blank_note_adds_nothing_and_a_crlf_file_keeps_crlf() {
        let crlf = TODO.replace('\n', "\r\n");
        let dir = repo(&[("pc-0005-n.md", &crlf), ("pc-0006-m.md", &crlf)]);
        archive(dir.path(), "pc-5", Some("   "), "pc").unwrap();
        assert_eq!(read(dir.path(), "done/pc-0005-n.md"), crlf);
        archive(dir.path(), "pc-6", Some("x"), "pc").unwrap();
        assert!(read(dir.path(), "done/pc-0006-m.md").ends_with("## Notes\r\n\r\n- x\r\n"));
    }

    #[test]
    fn a_live_claim_refuses_the_archive_and_changes_nothing() {
        let dir = repo(&[("pc-0001-a.md", TODO), (".claims/pc-0001.claim", "s"), ("PLAN.md", "## A\n- [ ] pc-0001\n")]);
        let err = archive(dir.path(), "pc-1", Some("n"), "pc").unwrap_err();
        assert!(err.contains("live claim"), "{err}");
        assert!(dir.path().join("pc-0001-a.md").exists());
        assert!(!dir.path().join("done").exists());
        assert_eq!(read(dir.path(), "PLAN.md"), "## A\n- [ ] pc-0001\n");
    }

    #[test]
    fn a_legacy_claim_file_also_refuses() {
        let dir = repo(&[("pc-0001-a.md", TODO), (".claims/1.claim", "s")]);
        assert!(archive(dir.path(), "pc-1", None, "pc").unwrap_err().contains("live claim"));
    }

    #[test]
    fn archiving_a_todo_with_no_plan_line_and_no_plan_file_works_and_creates_no_plan() {
        let dir = repo(&[("pc-0001-a.md", TODO)]);
        let a = archive(dir.path(), "pc-1", None, "pc").unwrap();
        assert_eq!((a.plan_line.clone(), a.plan_line_index), (None, None));
        assert!(!dir.path().join("PLAN.md").exists());
        unarchive(dir.path(), &a).unwrap();
        assert!(dir.path().join("pc-0001-a.md").exists());
    }

    #[test]
    fn archive_refuses_to_overwrite_a_done_file_and_unknown_ids() {
        let dir = repo(&[("pc-0001-a.md", TODO), ("done/pc-0001-a.md", "old")]);
        assert!(archive(dir.path(), "pc-1", None, "pc").is_err());
        assert_eq!(read(dir.path(), "done/pc-0001-a.md"), "old");
        assert!(archive(dir.path(), "pc-99", None, "pc").is_err());
    }

    #[test]
    fn unarchive_refuses_paths_outside_the_todos_folder_and_an_existing_original() {
        let dir = repo(&[("pc-0001-a.md", TODO)]);
        let a = archive(dir.path(), "pc-1", None, "pc").unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let mut bad = a.clone();
        bad.original_path = elsewhere.path().join("pc-0001-a.md").to_string_lossy().into_owned();
        assert!(unarchive(dir.path(), &bad).is_err());
        std::fs::write(dir.path().join("pc-0001-a.md"), "new").unwrap();
        assert!(unarchive(dir.path(), &a).unwrap_err().contains("already exists"));
        assert_eq!(read(dir.path(), "pc-0001-a.md"), "new");
    }

    #[test]
    fn unarchive_does_not_duplicate_a_line_that_is_planned_again() {
        let dir = repo(&[("pc-0001-a.md", TODO), ("PLAN.md", "## A\n- [ ] pc-0001\n")]);
        let a = archive(dir.path(), "pc-1", None, "pc").unwrap();
        std::fs::write(dir.path().join("PLAN.md"), "## A\n- [ ] pc-0001 - again\n").unwrap();
        unarchive(dir.path(), &a).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## A\n- [ ] pc-0001 - again\n");
    }

    #[test]
    fn unarchive_reinserts_by_group_and_neighbour_after_another_session_edited_the_plan() {
        let plan = "# Plan\n\n## A\n- [ ] pc-0001\n- [ ] pc-0002\n- [ ] pc-0003\n\n## B\n- [ ] pc-0004\n";
        let dir = repo(&[("pc-0002-two.md", TODO), ("PLAN.md", plan)]);
        let a = archive(dir.path(), "pc-2", None, "pc").unwrap();
        // Another session adds a group above, so the old absolute index now points elsewhere.
        std::fs::write(
            dir.path().join("PLAN.md"),
            "# Plan\n\n## Intro\n- [ ] pc-0009\n- [ ] pc-0010\n\n## A\n- [ ] pc-0001\n- [ ] pc-0003\n\n## B\n- [ ] pc-0004\n",
        )
        .unwrap();
        unarchive(dir.path(), &a).unwrap();
        assert_eq!(
            read(dir.path(), "PLAN.md"),
            "# Plan\n\n## Intro\n- [ ] pc-0009\n- [ ] pc-0010\n\n## A\n- [ ] pc-0001\n- [ ] pc-0002\n- [ ] pc-0003\n\n## B\n- [ ] pc-0004\n"
        );
    }

    #[test]
    fn unarchive_puts_a_first_item_back_first_and_keeps_notes_under_the_neighbour_together() {
        let plan = "## A\n- [ ] pc-0001\n- [ ] pc-0002\n  note under two\n- [ ] pc-0003\n";
        let dir = repo(&[("pc-0001-one.md", TODO), ("pc-0003-three.md", TODO), ("PLAN.md", plan)]);
        let first = archive(dir.path(), "pc-1", None, "pc").unwrap();
        std::fs::write(dir.path().join("PLAN.md"), "## Z\n- [ ] pc-0008\n\n## A\n- [ ] pc-0002\n  note under two\n- [ ] pc-0003\n").unwrap();
        unarchive(dir.path(), &first).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## Z\n- [ ] pc-0008\n\n## A\n- [ ] pc-0001\n- [ ] pc-0002\n  note under two\n- [ ] pc-0003\n");

        let third = archive(dir.path(), "pc-3", None, "pc").unwrap();
        std::fs::write(dir.path().join("PLAN.md"), "## Z\n- [ ] pc-0008\n- [ ] pc-0001\n\n## A\n- [ ] pc-0002\n  note under two\n").unwrap();
        unarchive(dir.path(), &third).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## Z\n- [ ] pc-0008\n- [ ] pc-0001\n\n## A\n- [ ] pc-0002\n  note under two\n- [ ] pc-0003\n");
    }

    #[test]
    fn unarchive_restores_every_line_that_named_the_todo_in_order() {
        let plan = "## A\n- [ ] pc-0002 - first\n- [ ] pc-0002 - adjacent\n- [ ] pc-0003\n\n## B\n- [x] pc-0002 - done copy\n";
        let dir = repo(&[("pc-0002-two.md", TODO), ("PLAN.md", plan)]);
        let a = archive(dir.path(), "pc-2", None, "pc").unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## A\n- [ ] pc-0003\n\n## B\n");
        unarchive(dir.path(), &a).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), plan);
    }

    #[test]
    fn unarchive_falls_back_to_the_group_end_then_to_a_new_group() {
        let plan = "## A\n- [ ] pc-0001\n- [ ] pc-0002\n\n## B\n- [ ] pc-0003\n";
        let dir = repo(&[("pc-0002-two.md", TODO), ("PLAN.md", plan)]);
        let a = archive(dir.path(), "pc-2", None, "pc").unwrap();
        // The neighbour is gone: the line lands at the end of its group.
        std::fs::write(dir.path().join("PLAN.md"), "## A\n- [ ] pc-0005\n\n## B\n- [ ] pc-0003\n").unwrap();
        unarchive(dir.path(), &a).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## A\n- [ ] pc-0005\n- [ ] pc-0002\n\n## B\n- [ ] pc-0003\n");

        std::fs::remove_file(dir.path().join("pc-0002-two.md")).unwrap();
        std::fs::write(dir.path().join("PLAN.md"), "## B\n- [ ] pc-0003\n").unwrap();
        std::fs::write(dir.path().join("done/pc-0002-two.md"), TODO).unwrap();
        unarchive(dir.path(), &a).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## B\n- [ ] pc-0003\n\n## A\n- [ ] pc-0002\n");
    }

    #[test]
    fn unarchive_still_reads_a_record_from_before_the_group_was_saved() {
        let dir = repo(&[("done/pc-0002-two.md", TODO), ("PLAN.md", "## A\n- [ ] pc-0001\n- [ ] pc-0003\n")]);
        let old = AiTodoArchived {
            id: "pc-0002".into(),
            done_path: dir.path().join("done/pc-0002-two.md").to_string_lossy().into_owned(),
            original_path: dir.path().join("pc-0002-two.md").to_string_lossy().into_owned(),
            original_content: TODO.into(),
            plan_line: Some("- [ ] pc-0002".into()),
            plan_line_index: Some(2),
        };
        unarchive(dir.path(), &old).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## A\n- [ ] pc-0001\n- [ ] pc-0002\n- [ ] pc-0003\n");
    }

    const PLAN: &str = "# Plan\n\n## A\n- [ ] pc-0001\n- [ ] pc-0002 - two [P]\n\n## B\n- [ ] pc-0003\n";

    fn three() -> tempfile::TempDir {
        repo(&[
            ("pc-0001-a.md", "# A\n"),
            ("pc-0002-b.md", "# B\n"),
            ("pc-0003-c.md", "# C\n"),
            ("pc-0004-d.md", "# D\n"),
            ("PLAN.md", PLAN),
        ])
    }

    #[test]
    fn move_within_a_group_reorders_and_keeps_the_label_and_marker() {
        let dir = three();
        plan_move(dir.path(), "pc-2", Some("A"), 0, "pc").unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "# Plan\n\n## A\n- [ ] pc-0002 - two [P]\n- [ ] pc-0001\n\n## B\n- [ ] pc-0003\n");
    }

    #[test]
    fn move_between_groups_lands_at_the_index() {
        let dir = three();
        plan_move(dir.path(), "pc-1", Some("B"), 1, "pc").unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "# Plan\n\n## A\n- [ ] pc-0002 - two [P]\n\n## B\n- [ ] pc-0003\n- [ ] pc-0001\n");
    }

    #[test]
    fn move_an_unplanned_todo_in_adds_a_canonical_line() {
        let dir = three();
        plan_move(dir.path(), "4", Some("B"), 0, "pc").unwrap();
        assert!(read(dir.path(), "PLAN.md").contains("## B\n- [ ] pc-0004\n- [ ] pc-0003\n"));
    }

    #[test]
    fn move_out_unplans_and_leaves_an_empty_group_in_place() {
        let dir = three();
        plan_move(dir.path(), "pc-3", None, 0, "pc").unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "# Plan\n\n## A\n- [ ] pc-0001\n- [ ] pc-0002 - two [P]\n\n## B\n");
    }

    #[test]
    fn move_into_a_new_group_creates_it_and_a_missing_plan_is_created() {
        let dir = repo(&[("pc-0001-a.md", "# A\n")]);
        plan_move(dir.path(), "pc-1", Some("Release 2"), 0, "pc").unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "# Plan\n\n## Release 2\n- [ ] pc-0001\n");
        let none = repo(&[("pc-0001-a.md", "# A\n")]);
        plan_move(none.path(), "pc-1", None, 0, "pc").unwrap();
        assert!(!none.path().join("PLAN.md").exists(), "unplanning must not create a plan");
    }

    #[test]
    fn move_counts_only_todos_that_have_a_file_in_the_index() {
        let dir = repo(&[
            ("pc-0001-a.md", "# A\n"),
            ("pc-0003-c.md", "# C\n"),
            ("PLAN.md", "## A\n- [ ] pc-0009\n- [ ] pc-0001\n"),
        ]);
        plan_move(dir.path(), "pc-3", Some("A"), 0, "pc").unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "## A\n- [ ] pc-0009\n- [ ] pc-0003\n- [ ] pc-0001\n");
    }

    #[test]
    fn move_of_an_unknown_id_is_an_error_and_edits_nothing() {
        let dir = three();
        assert!(plan_move(dir.path(), "pc-99", Some("A"), 0, "pc").is_err());
        assert_eq!(read(dir.path(), "PLAN.md"), PLAN);
    }

    #[test]
    fn reorder_groups_rewrites_the_plan_section_order() {
        let dir = three();
        plan_reorder_groups(dir.path(), &["B".to_string(), "A".to_string()]).unwrap();
        assert_eq!(read(dir.path(), "PLAN.md"), "# Plan\n\n## B\n- [ ] pc-0003\n## A\n- [ ] pc-0001\n- [ ] pc-0002 - two [P]\n\n");
    }
}
