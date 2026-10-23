//! Reads a repo's `.claude/todos/PLAN.md` (the ordered pull-next lane) into the
//! dashboard's "Next up" rows. Pure: the caller hands over the file text.

use super::snapshot_types::PlanItem;

/// Rows kept per repo, and again for a group's merged list. A plan is a
/// pull-next lane, so the dashboard only wants its head; the long tail would
/// bury the other cards.
pub const PLAN_CAP: usize = 12;

/// Keeps one runaway hand-edited line from stretching the card.
const MAX_TEXT_CHARS: usize = 240;

/// Open items, priority first then file order (see `rank`), each tagged with its `##` section. A section whose
/// heading contains "priorities" marks its items `priority`. Checked items and
/// sections with no open item contribute nothing.
pub fn parse_plan(text: &str, repo_cwd: &str) -> Vec<PlanItem> {
    let mut out = Vec::new();
    let mut section = String::new();
    let mut priority = false;
    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("##") {
            // `###` and deeper are sub-headings of the same lane section.
            if !heading.starts_with('#') {
                section = heading.trim().to_string();
                priority = section.to_lowercase().contains("priorities");
            }
            continue;
        }
        let Some(rest) = open_item(line) else { continue };
        let (id, body) = split_id(rest);
        if body.is_empty() {
            continue;
        }
        out.push(PlanItem {
            id,
            text: clip(body),
            section: section.clone(),
            priority,
            repo_cwd: repo_cwd.to_string(),
        });
    }
    rank(&mut out);
    out
}

/// Priority items first, then cut to `PLAN_CAP`. The cut comes after the sort
/// so a priorities section far down the file is not pushed out by earlier
/// items. `sort_by_key` is stable, so file order survives within each band.
/// Also used to merge several repos' lists.
pub fn rank(items: &mut Vec<PlanItem>) {
    items.sort_by_key(|p| !p.priority);
    items.truncate(PLAN_CAP);
}

/// The text after `- [ ] ` for an unchecked top-level item. Indented lines are
/// notes under an item, not lane entries.
fn open_item(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("- [ ]").or_else(|| line.strip_prefix("* [ ]"))?;
    if !rest.starts_with(' ') {
        return None;
    }
    Some(rest.trim())
}

/// `1264 - handoff: ...` -> (Some("1264"), "handoff: ..."). The id is the first
/// token only when it is followed by ` - ` and looks like an id (short, with a
/// digit), so a plain item that merely contains a dash keeps its whole text.
fn split_id(rest: &str) -> (Option<String>, &str) {
    let Some((head, tail)) = rest.split_once(" - ") else { return (None, rest) };
    let looks_like_id = !head.is_empty()
        && head.len() <= 12
        && head.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && head.chars().any(|c| c.is_ascii_digit());
    if looks_like_id {
        (Some(head.to_string()), tail.trim())
    } else {
        (None, rest)
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() <= MAX_TEXT_CHARS {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX_TEXT_CHARS).collect();
    format!("{}...", cut.trim_end())
}

/// Reads `<repo>/.claude/todos/PLAN.md`; a missing or unreadable file is just
/// an empty plan, never an error.
pub fn read_plan(repo_cwd: &str) -> Vec<PlanItem> {
    let path = std::path::Path::new(repo_cwd).join(".claude").join("todos").join("PLAN.md");
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_plan(&text, repo_cwd),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "C:/work/app";

    #[test]
    fn id_and_text_lines_parse_with_their_section() {
        let md = "# Plan\n\n## Phase 1\n\n- [ ] 12 - ship the thing\n- [ ] plain item with no id\n";
        let items = parse_plan(md, REPO);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id.as_deref(), Some("12"));
        assert_eq!(items[0].text, "ship the thing");
        assert_eq!(items[0].section, "Phase 1");
        assert_eq!(items[0].repo_cwd, REPO);
        assert_eq!(items[1].id, None);
        assert_eq!(items[1].text, "plain item with no id");
    }

    #[test]
    fn checked_items_are_ignored() {
        let items = parse_plan("## A\n- [x] 1 - done\n- [X] 2 - also done\n- [ ] 3 - open\n", REPO);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id.as_deref(), Some("3"));
    }

    #[test]
    fn empty_sections_contribute_nothing() {
        let items = parse_plan("## Empty\n\n## Phase 2\n- [ ] 5 - real\n## Also empty\n", REPO);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].section, "Phase 2");
    }

    #[test]
    fn a_priorities_heading_marks_only_its_own_items() {
        let md = "## Joe's own priorities\n- [ ] 1 - first\n## Phase 1\n- [ ] 2 - second\n";
        let items = parse_plan(md, REPO);
        assert!(items[0].priority);
        assert!(!items[1].priority);
    }

    #[test]
    fn the_list_is_capped_at_twelve() {
        let md: String = (1..=20).map(|n| format!("- [ ] {n} - item {n}\n")).collect();
        let items = parse_plan(&format!("## A\n{md}"), REPO);
        assert_eq!(items.len(), PLAN_CAP);
        assert_eq!(PLAN_CAP, 12);
        assert_eq!(items[11].id.as_deref(), Some("12"));
    }

    #[test]
    fn a_priorities_section_below_many_open_items_still_comes_first() {
        let phase: String = (1..=7).map(|n| format!("- [ ] {n} - phase {n}\n")).collect();
        let md = format!("## Phase 1\n{phase}## Joe's own priorities\n- [ ] 99 - urgent\n");
        let items = parse_plan(&md, REPO);
        assert_eq!(items[0].id.as_deref(), Some("99"));
        assert!(items[0].priority);
        assert_eq!(items[1].id.as_deref(), Some("1"));
    }

    #[test]
    fn priority_items_survive_the_cap_and_file_order_holds_within_a_class() {
        let phase: String = (1..=14).map(|n| format!("- [ ] {n} - phase {n}\n")).collect();
        let md = format!("## Phase 1\n{phase}## Priorities\n- [ ] 90 - a\n- [ ] 91 - b\n");
        let items = parse_plan(&md, REPO);
        assert_eq!(items.len(), PLAN_CAP);
        let ids: Vec<_> = items.iter().take(3).map(|i| i.id.as_deref().unwrap()).collect();
        assert_eq!(ids, ["90", "91", "1"]);
    }

    #[test]
    fn items_before_any_heading_have_an_empty_section() {
        let items = parse_plan("- [ ] 9 - orphan\n", REPO);
        assert_eq!(items[0].section, "");
        assert!(!items[0].priority);
    }

    #[test]
    fn indented_notes_and_non_list_lines_are_skipped() {
        let items = parse_plan("## A\n  - [ ] 1 - nested note\nplain prose\n- [ ] 2 - kept\n- [ ]no space\n", REPO);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id.as_deref(), Some("2"));
    }

    #[test]
    fn a_dash_inside_plain_text_is_not_an_id_split() {
        let items = parse_plan("## A\n- [ ] Fix the parser - it drops lines\n- [ ] sc-56160 - ticket id\n", REPO);
        assert_eq!(items[0].id, None);
        assert_eq!(items[0].text, "Fix the parser - it drops lines");
        assert_eq!(items[1].id.as_deref(), Some("sc-56160"));
    }

    #[test]
    fn a_long_line_is_clipped() {
        let long = "x".repeat(500);
        let items = parse_plan(&format!("## A\n- [ ] 1 - {long}\n"), REPO);
        assert!(items[0].text.chars().count() < 250);
        assert!(items[0].text.ends_with("..."));
    }

    #[test]
    fn a_sub_heading_does_not_reset_the_section() {
        let md = "## Priorities\n### note\n- [ ] 1 - still priority\n";
        let items = parse_plan(md, REPO);
        assert_eq!(items[0].section, "Priorities");
        assert!(items[0].priority);
    }

    #[test]
    fn a_missing_plan_file_is_an_empty_plan() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_plan(&dir.path().to_string_lossy()).is_empty());
    }

    #[test]
    fn read_plan_reads_the_repos_plan_file() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(&todos).unwrap();
        std::fs::write(todos.join("PLAN.md"), "## Now\n- [ ] 7 - from disk\n").unwrap();
        let items = read_plan(&dir.path().to_string_lossy());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "from disk");
    }
}
