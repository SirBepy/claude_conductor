//! Line-scoped reads and edits of a repo's `.claude/todos/PLAN.md`, the ordered
//! pull-next lane over the backlog. Other sessions and skills edit the same
//! file (`/pickup`, `/plan-todos`, `/close`), so every write re-reads the file
//! first, changes only the lines it means to, keeps the file's own line
//! endings, and writes BOM-less UTF-8.
//!
//! A group is a `## ` heading; lines before the first heading belong to the
//! pseudo-group `Plan`. `###` and deeper are notes inside a group, as in
//! `plan::parse_plan`.

use super::plan::split_id;
use super::todo_ids::{parse_wanted, Wanted};
use std::path::{Path, PathBuf};

/// The group name for item lines that sit before any `## ` heading.
pub const PREAMBLE_GROUP: &str = "Plan";

/// A text file as lines that keep their own terminators, so an edit touches
/// only the lines it names and a CRLF file stays CRLF.
#[derive(Clone, Debug, PartialEq)]
pub struct LineDoc {
    lines: Vec<String>,
    eol: &'static str,
}

fn body(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

impl LineDoc {
    pub fn parse(text: &str) -> LineDoc {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        LineDoc { lines: text.split_inclusive('\n').map(str::to_string).collect(), eol }
    }

    pub fn to_text(&self) -> String {
        self.lines.concat()
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn line(&self, i: usize) -> &str {
        body(&self.lines[i])
    }

    /// Inserts `text` as its own line at `idx` (clamped to the end), giving a
    /// previous last line that lacked a terminator one first.
    pub fn insert(&mut self, idx: usize, text: &str) {
        let idx = idx.min(self.lines.len());
        if idx > 0 && !self.lines[idx - 1].ends_with('\n') {
            self.lines[idx - 1].push_str(self.eol);
        }
        self.lines.insert(idx, format!("{text}{}", self.eol));
    }

    pub fn remove(&mut self, idx: usize) -> String {
        body(&self.lines.remove(idx)).to_string()
    }

    /// Ensures the last line is terminated, so appended lines start on their own.
    pub(crate) fn terminate(&mut self) {
        if let Some(last) = self.lines.last_mut() {
            if !last.ends_with('\n') {
                last.push_str(self.eol);
            }
        }
    }

    /// The title of a `## ` heading line; `###` and deeper are not groups.
    pub fn heading_title(line: &str) -> Option<&str> {
        let rest = line.strip_prefix("##")?;
        if rest.starts_with('#') {
            return None;
        }
        if rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t') {
            Some(rest.trim())
        } else {
            None
        }
    }

    /// Whether line `i` opens or closes a fenced code block, so a `## ` inside
    /// a fence is not mistaken for a heading.
    fn fence_toggles(line: &str) -> bool {
        line.trim_start().starts_with("```")
    }

    /// `(line index, title)` of every `## ` heading outside code fences.
    pub fn headings(&self) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        let mut in_fence = false;
        for i in 0..self.lines.len() {
            let l = body(&self.lines[i]);
            if Self::fence_toggles(l) {
                in_fence = !in_fence;
            } else if !in_fence {
                if let Some(t) = Self::heading_title(l) {
                    out.push((i, t.to_string()));
                }
            }
        }
        out
    }

    /// Index of the last non-blank line in `lo..hi`, if any.
    pub(crate) fn last_nonblank(&self, lo: usize, hi: usize) -> Option<usize> {
        (lo..hi).rev().find(|&i| !body(&self.lines[i]).trim().is_empty())
    }
}

/// The `rest` of a top-level checkbox item (`- [ ] rest`, `- [x] rest`,
/// `* [ ] rest`); `None` for any other line. Checked items count here, unlike
/// `plan::open_item`, because an archived todo's line must be pruned whatever
/// its state.
fn item_rest(line: &str) -> Option<&str> {
    let after = line.strip_prefix("- [").or_else(|| line.strip_prefix("* ["))?;
    let mut chars = after.chars();
    let mark = chars.next()?;
    if !matches!(mark, ' ' | 'x' | 'X') {
        return None;
    }
    let rest = chars.as_str().strip_prefix(']')?;
    rest.starts_with(' ').then(|| rest.trim())
}

/// `- [ ] rest` for an item line of any checkbox state, keeping its id and any
/// label or `[P]` marker; `None` if `line` is not an item.
pub fn reopened(line: &str) -> Option<String> {
    item_rest(line).map(|rest| format!("- [ ] {rest}"))
}

fn item_wanted(line: &str) -> Option<Wanted> {
    let rest = item_rest(line)?;
    let id = split_id(rest).0?;
    parse_wanted(&id)
}

/// One id-bearing PLAN line: which todo it names and where it sits.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub wanted: Wanted,
    pub group: String,
    /// Order among all id-bearing lines of the file, from 0.
    pub plan_index: u32,
}

impl LineDoc {
    /// The `## ` headings in file order, with `Plan` first when item lines sit
    /// above the first heading and no heading already has that name.
    pub fn groups(&self) -> Vec<String> {
        let mut groups: Vec<String> = self.headings().into_iter().map(|(_, t)| t).collect();
        if self.preamble_has_items() && !groups.iter().any(|g| g == PREAMBLE_GROUP) {
            groups.insert(0, PREAMBLE_GROUP.to_string());
        }
        groups
    }

    fn first_heading(&self) -> usize {
        self.headings().first().map_or(self.lines.len(), |(i, _)| *i)
    }

    fn preamble_has_items(&self) -> bool {
        (0..self.first_heading()).any(|i| item_wanted(body(&self.lines[i])).is_some())
    }

    pub fn placements(&self) -> Vec<Placement> {
        let headings = self.headings();
        let mut out = Vec::new();
        let mut group = PREAMBLE_GROUP.to_string();
        let mut next_heading = headings.iter().peekable();
        for i in 0..self.lines.len() {
            if next_heading.peek().is_some_and(|(h, _)| *h == i) {
                group = next_heading.next().map(|(_, t)| t.clone()).unwrap_or_default();
                continue;
            }
            if let Some(wanted) = item_wanted(body(&self.lines[i])) {
                out.push(Placement { wanted, group: group.clone(), plan_index: out.len() as u32 });
            }
        }
        out
    }

    /// Whether any item line names `wanted`.
    pub fn has_item(&self, wanted: &Wanted) -> bool {
        self.placements().iter().any(|p| same_todo(&p.wanted, wanted))
    }

    /// Removes every item line that names `wanted`; returns each removed line
    /// with the index it had in the file before this call.
    pub fn remove_item(&mut self, wanted: &Wanted) -> Vec<(usize, String)> {
        let hits: Vec<usize> = (0..self.lines.len())
            .filter(|&i| item_wanted(body(&self.lines[i])).is_some_and(|w| same_todo(&w, wanted)))
            .collect();
        let removed: Vec<(usize, String)> = hits.iter().map(|&i| (i, body(&self.lines[i]).to_string())).collect();
        for &i in hits.iter().rev() {
            self.lines.remove(i);
        }
        removed
    }

    /// Inserts `item` (a full `- [ ] ...` line) into `group` as its
    /// `position`-th visible item, `visible` saying which item lines the caller
    /// can see (a line whose todo file is gone is not counted, so the index a
    /// UI sends matches the rows it drew). A position past the end appends to
    /// the group. A group with no heading is created at the end of the file.
    pub fn insert_into_group(&mut self, group: &str, item: &str, position: usize, visible: &dyn Fn(&Wanted) -> bool) {
        let headings = self.headings();
        let span = match headings.iter().position(|(_, t)| t == group) {
            Some(h) => {
                let end = headings.get(h + 1).map_or(self.lines.len(), |(i, _)| *i);
                Some((headings[h].0 + 1, end, headings[h].0))
            }
            None if group == PREAMBLE_GROUP && self.preamble_has_items() => Some((0, self.first_heading(), 0)),
            None => None,
        };
        let Some((lo, hi, floor)) = span else {
            self.terminate();
            if self.lines.last().is_some_and(|l| !body(l).trim().is_empty()) {
                self.insert(self.lines.len(), "");
            }
            self.insert(self.lines.len(), &format!("## {group}"));
            self.insert(self.lines.len(), item);
            return;
        };
        let visible_items: Vec<usize> = (lo..hi)
            .filter(|&i| item_wanted(body(&self.lines[i])).is_some_and(|w| visible(&w)))
            .collect();
        let at = match visible_items.get(position) {
            Some(&i) => i,
            None => self.last_nonblank(lo, hi).map_or(floor + 1, |i| i + 1),
        };
        self.insert(at, item);
    }

    /// Reorders the `## ` sections (heading plus its lines) to follow `order`.
    /// Text above the first heading stays first; a section `order` does not
    /// name keeps its relative place after the named ones.
    pub fn reorder_groups(&mut self, order: &[String]) {
        let headings = self.headings();
        if headings.len() < 2 {
            return;
        }
        self.terminate();
        let first = headings[0].0;
        let mut sections: Vec<(String, Vec<String>)> = Vec::new();
        for (n, (start, title)) in headings.iter().enumerate() {
            let end = headings.get(n + 1).map_or(self.lines.len(), |(i, _)| *i);
            sections.push((title.clone(), self.lines[*start..end].to_vec()));
        }
        let mut taken: Vec<(String, Vec<String>)> = Vec::new();
        for name in order {
            if let Some(i) = sections.iter().position(|(t, _)| t == name) {
                taken.push(sections.remove(i));
            }
        }
        taken.extend(sections);
        self.lines.truncate(first);
        for (_, lines) in taken {
            self.lines.extend(lines);
        }
    }
}

/// Whether two spellings name the same todo: equal keys, or a bare number on
/// one side that is the other's `pc` number.
fn same_todo(a: &Wanted, b: &Wanted) -> bool {
    match (a, b) {
        (Wanted::Key(x), Wanted::Key(y)) => x == y,
        (Wanted::Bare(x), Wanted::Bare(y)) => x == y,
        (Wanted::Key(k), Wanted::Bare(n)) | (Wanted::Bare(n), Wanted::Key(k)) => {
            k.label == super::todo_ids::LEGACY_LABEL && k.number == *n
        }
    }
}

pub fn plan_path(todos_dir: &Path) -> PathBuf {
    todos_dir.join("PLAN.md")
}

/// The plan as it is on disk now; a missing or unreadable file reads as empty.
pub fn read_plan_doc(todos_dir: &Path) -> LineDoc {
    LineDoc::parse(&std::fs::read_to_string(plan_path(todos_dir)).unwrap_or_default())
}

/// Reads PLAN.md, applies `edit`, and writes it back only if it changed. The
/// file is read again right before the write; if another writer got in
/// between, the edit is redone against the newer text rather than clobbering
/// it. `create` starts a missing file as `# Plan`; without it a missing file
/// is left missing.
pub fn edit_plan<T>(
    todos_dir: &Path,
    create: bool,
    mut edit: impl FnMut(&mut LineDoc) -> Result<T, String>,
) -> Result<T, String> {
    let path = plan_path(todos_dir);
    for _ in 0..5 {
        let before = std::fs::read_to_string(&path).ok();
        if before.is_none() && !create {
            let mut empty = LineDoc::parse("");
            return edit(&mut empty);
        }
        let start = before.clone().unwrap_or_else(|| "# Plan\n".to_string());
        let mut doc = LineDoc::parse(&start);
        let out = edit(&mut doc)?;
        let text = doc.to_text();
        if before.as_deref().map(|b| b.strip_prefix('\u{feff}').unwrap_or(b)) == Some(text.as_str()) {
            return Ok(out);
        }
        if std::fs::read_to_string(&path).ok() != before {
            continue;
        }
        std::fs::create_dir_all(todos_dir).map_err(|e| format!("could not create {}: {e}", todos_dir.display()))?;
        std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        return Ok(out);
    }
    Err("PLAN.md kept changing while it was being edited; try again".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dashboard::todo_ids::TodoKey;

    fn pc(n: u64) -> Wanted {
        Wanted::Key(TodoKey { label: "pc".into(), number: n })
    }

    fn all(_: &Wanted) -> bool {
        true
    }

    const PLAN: &str = "# Plan\n\n## Release 1\n\n- [ ] pc-0001\n- [ ] pc-0002 - second [P]\n\n## Empty\n\n## Later\n- [x] pc-0003\n";

    #[test]
    fn groups_come_in_file_order_and_include_empty_ones() {
        assert_eq!(LineDoc::parse(PLAN).groups(), ["Release 1", "Empty", "Later"]);
    }

    #[test]
    fn a_line_before_any_heading_is_in_the_plan_group() {
        let doc = LineDoc::parse("- [ ] pc-0009\n\n## A\n- [ ] pc-0001\n");
        assert_eq!(doc.groups(), ["Plan", "A"]);
        let p = doc.placements();
        assert_eq!((p[0].group.as_str(), p[0].plan_index), ("Plan", 0));
        assert_eq!((p[1].group.as_str(), p[1].plan_index), ("A", 1));
    }

    #[test]
    fn placements_follow_the_headings_and_count_across_the_file() {
        let p = LineDoc::parse(PLAN).placements();
        let got: Vec<(&str, u32)> = p.iter().map(|x| (x.group.as_str(), x.plan_index)).collect();
        assert_eq!(got, [("Release 1", 0), ("Release 1", 1), ("Later", 2)]);
        assert_eq!(p[2].wanted, pc(3), "checked lines are placed too");
    }

    #[test]
    fn a_heading_inside_a_code_fence_is_not_a_group() {
        let doc = LineDoc::parse("## A\n```\n## not a group\n```\n- [ ] pc-0001\n");
        assert_eq!(doc.groups(), ["A"]);
    }

    #[test]
    fn a_sub_heading_is_not_a_group() {
        assert_eq!(LineDoc::parse("## A\n### note\n- [ ] pc-0001\n").groups(), ["A"]);
    }

    #[test]
    fn remove_item_drops_every_spelling_of_the_id_and_reports_the_lines() {
        let mut doc = LineDoc::parse("## A\n- [ ] pc-0001\n- [ ] 2 - legacy\n- [ ] pc-0001 - dup\n- [ ] pc-0003\n");
        let removed = doc.remove_item(&pc(1));
        assert_eq!(removed, [(1, "- [ ] pc-0001".to_string()), (3, "- [ ] pc-0001 - dup".to_string())]);
        let removed = doc.remove_item(&pc(2));
        assert_eq!(removed[0].1, "- [ ] 2 - legacy", "a bare number is the pc todo");
        assert_eq!(doc.to_text(), "## A\n- [ ] pc-0003\n");
    }

    #[test]
    fn insert_goes_before_the_nth_visible_item() {
        let mut doc = LineDoc::parse(PLAN);
        doc.insert_into_group("Release 1", "- [ ] pc-0009", 1, &all);
        assert_eq!(doc.placements().iter().map(|p| p.wanted.clone()).collect::<Vec<_>>(), [pc(1), pc(9), pc(2), pc(3)]);
    }

    #[test]
    fn insert_past_the_end_appends_after_the_groups_last_line() {
        let mut doc = LineDoc::parse(PLAN);
        doc.insert_into_group("Release 1", "- [ ] pc-0009", 99, &all);
        assert!(doc.to_text().contains("- [ ] pc-0002 - second [P]\n- [ ] pc-0009\n\n## Empty"), "{}", doc.to_text());
    }

    #[test]
    fn insert_into_an_empty_group_lands_under_its_heading() {
        let mut doc = LineDoc::parse(PLAN);
        doc.insert_into_group("Empty", "- [ ] pc-0009", 0, &all);
        assert!(doc.to_text().contains("## Empty\n- [ ] pc-0009\n\n## Later"), "{}", doc.to_text());
    }

    #[test]
    fn invisible_items_are_not_counted_in_the_position() {
        let mut doc = LineDoc::parse("## A\n- [ ] pc-0001\n- [ ] pc-0002\n");
        let hide_first = |w: &Wanted| *w != pc(1);
        doc.insert_into_group("A", "- [ ] pc-0009", 0, &hide_first);
        assert_eq!(doc.to_text(), "## A\n- [ ] pc-0001\n- [ ] pc-0009\n- [ ] pc-0002\n");
    }

    #[test]
    fn an_unknown_group_is_created_at_the_end() {
        let mut doc = LineDoc::parse("# Plan\n\n## A\n- [ ] pc-0001\n");
        doc.insert_into_group("New", "- [ ] pc-0009", 0, &all);
        assert_eq!(doc.to_text(), "# Plan\n\n## A\n- [ ] pc-0001\n\n## New\n- [ ] pc-0009\n");
    }

    #[test]
    fn the_plan_group_inserts_above_the_first_heading() {
        let mut doc = LineDoc::parse("- [ ] pc-0001\n\n## A\n");
        doc.insert_into_group("Plan", "- [ ] pc-0009", 9, &all);
        assert_eq!(doc.to_text(), "- [ ] pc-0001\n- [ ] pc-0009\n\n## A\n");
    }

    #[test]
    fn reorder_moves_whole_sections_and_keeps_the_preamble_first() {
        let mut doc = LineDoc::parse(PLAN);
        doc.reorder_groups(&["Later".into(), "Release 1".into()]);
        assert_eq!(
            doc.to_text(),
            "# Plan\n\n## Later\n- [x] pc-0003\n## Release 1\n\n- [ ] pc-0001\n- [ ] pc-0002 - second [P]\n\n## Empty\n\n"
        );
        assert_eq!(doc.groups(), ["Later", "Release 1", "Empty"]);
    }

    #[test]
    fn reorder_terminates_a_last_section_that_had_no_newline() {
        let mut doc = LineDoc::parse("## A\n- [ ] pc-0001\n## B\n- [ ] pc-0002");
        doc.reorder_groups(&["B".into(), "A".into()]);
        assert_eq!(doc.to_text(), "## B\n- [ ] pc-0002\n## A\n- [ ] pc-0001\n");
    }

    #[test]
    fn crlf_is_kept_on_untouched_lines_and_used_for_new_ones() {
        let mut doc = LineDoc::parse("## A\r\n- [ ] pc-0001\r\n");
        doc.insert_into_group("A", "- [ ] pc-0009", 9, &all);
        assert_eq!(doc.to_text(), "## A\r\n- [ ] pc-0001\r\n- [ ] pc-0009\r\n");
    }

    #[test]
    fn a_bom_is_dropped_on_parse() {
        assert_eq!(LineDoc::parse("\u{feff}## A\n").to_text(), "## A\n");
    }

    #[test]
    fn edit_plan_writes_only_when_the_text_changed_and_keeps_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = plan_path(dir.path());
        std::fs::write(&path, "## A\r\n- [ ] pc-0001\r\n").unwrap();
        edit_plan(dir.path(), false, |d| {
            d.remove_item(&pc(7));
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "## A\r\n- [ ] pc-0001\r\n");
        edit_plan(dir.path(), false, |d| {
            d.insert_into_group("A", "- [ ] pc-0002", 9, &all);
            Ok(())
        })
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, b"## A\r\n- [ ] pc-0001\r\n- [ ] pc-0002\r\n");
    }

    #[test]
    fn edit_plan_creates_a_missing_plan_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        edit_plan(dir.path(), false, |_| Ok(())).unwrap();
        assert!(!plan_path(dir.path()).exists());
        edit_plan(dir.path(), true, |d| {
            d.insert_into_group("Now", "- [ ] pc-0001", 0, &all);
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(plan_path(dir.path())).unwrap(), "# Plan\n\n## Now\n- [ ] pc-0001\n");
    }
}
