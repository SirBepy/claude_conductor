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
        // A bare `pc-1407` line has no label; the id stands in until `read_plan`
        // swaps in the todo's title.
        let text = match (&id, body.is_empty()) {
            (Some(id), true) => clip(id),
            _ => clip(body),
        };
        if text.is_empty() {
            continue;
        }
        out.push(PlanItem {
            id,
            text,
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

/// Longest id token before ` - `: `mac2-10000` is 10, and a ticket-style id
/// (`sc-56160`) is shorter than the cap.
const MAX_ID_CHARS: usize = 20;

/// Splits a plan line's id off its label, keeping the id as written (never
/// re-padded or re-labelled; `todo_ids` does the matching):
/// - `1264 - handoff: ...` -> (Some("1264"), "handoff: ...")
/// - `pc-1407 - label [P]` -> (Some("pc-1407"), "label [P]")
/// - `pc-1407 [P] - label` -> (Some("pc-1407"), "label")
/// - `pc-1407` and `pc-1407 [P]` -> (Some("pc-1407"), "")
///
/// With a label, the id is the first token only when it is followed by ` - `
/// and looks like an id (short, with a digit), so a plain item that merely
/// contains a dash keeps its whole text. Without one, the line has to be the id
/// alone (plus an optional `[P]`) so "2026 plan review" is not read as todo 2026.
pub(crate) fn split_id(rest: &str) -> (Option<String>, &str) {
    if let Some((head, tail)) = rest.split_once(" - ") {
        let id = head.strip_suffix(" [P]").unwrap_or(head);
        let looks_like_id = !id.is_empty()
            && id.len() <= MAX_ID_CHARS
            && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
            && id.chars().any(|c| c.is_ascii_digit());
        return if looks_like_id { (Some(id.to_string()), tail.trim()) } else { (None, rest) };
    }
    let mut tokens = rest.split_whitespace();
    let (Some(first), second, None) = (tokens.next(), tokens.next(), tokens.next()) else { return (None, rest) };
    let marker_only = second.is_none_or(|t| t == "[P]");
    if marker_only && super::todo_ids::parse_wanted(first).is_some() {
        (Some(first.to_string()), "")
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
    let dir = super::todo_stats::todos_dir(std::path::Path::new(repo_cwd));
    let Ok(text) = std::fs::read_to_string(dir.join("PLAN.md")) else { return Vec::new() };
    let mut items = parse_plan(&text, repo_cwd);
    let device = super::todo_ids::device_label();
    for item in items.iter_mut().filter(|i| i.id.as_deref() == Some(i.text.as_str())) {
        if let Some(title) = item.id.as_deref().and_then(|id| todo_title(&dir, id, &device)) {
            item.text = clip(&title);
        }
    }
    items
}

/// The title of the todo a bare plan line names, or `None` when its file is
/// gone or ambiguous (the line then shows the id).
fn todo_title(todos_dir: &std::path::Path, id: &str, device: &str) -> Option<String> {
    let path = super::todo_ids::find_todo_file(todos_dir, id, device).ok()?;
    Some(super::todo_read::read_head(&path)?.title)
}

/// Whether `/pickup` would find anything in `todos_dir`: an open PLAN.md line
/// that is not claimed, and whose todo file still exists if it names an id
/// (`/pickup` prunes a line whose file is gone). Reads the whole plan, unlike
/// the capped "Next up" rows.
pub fn has_pickable(todos_dir: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(todos_dir.join("PLAN.md")) else { return false };
    let files = super::todo_ids::list_todo_files(todos_dir);
    let live = super::todo_stats::live_claim_keys(todos_dir);
    text.lines().filter_map(open_item).any(|rest| match split_id(rest) {
        (None, "") => false,
        (None, _) => true,
        (Some(id), _) => {
            // Only `.md` todo files count: an id-reservation marker `<id>-.reserved`
            // shares the id prefix but is not one (`list_todo_files` skips it).
            match super::todo_ids::parse_wanted(&id) {
                Some(wanted) => files.iter().any(|(key, _)| wanted.matches(key) && !live.contains(key)),
                None => false,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "C:/work/app";

    fn todos_dir(plan: &str, files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claims")).unwrap();
        std::fs::write(dir.path().join("PLAN.md"), plan).unwrap();
        for f in files {
            std::fs::write(dir.path().join(f), "x").unwrap();
        }
        dir
    }

    #[test]
    fn an_open_line_with_its_todo_file_is_pickable() {
        let dir = todos_dir("## Now\n- [ ] 7 - do it\n", &["7-do-it.md"]);
        assert!(has_pickable(dir.path()));
    }

    #[test]
    fn claimed_checked_and_vanished_lines_are_not_pickable() {
        let dir = todos_dir("## Now\n- [x] 1 - done\n- [ ] 2 - claimed\n- [ ] 3 - file gone\n", &["1-a.md", "2-b.md", ".claims/2.claim"]);
        assert!(!has_pickable(dir.path()));
    }

    #[test]
    fn a_stale_claim_does_not_hide_pickup() {
        let dir = todos_dir("## Now
- [ ] 7 - do it
", &["7-do-it.md", ".claims/7.claim"]);
        assert!(!has_pickable(dir.path()));
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(5 * 60 * 60);
        let claim = std::fs::OpenOptions::new().write(true).open(dir.path().join(".claims").join("7.claim")).unwrap();
        claim.set_modified(past).unwrap();
        drop(claim);
        assert!(has_pickable(dir.path()));
    }

    #[test]
    fn a_slug_suffixed_claim_hides_pickup() {
        let dir = todos_dir("## Now
- [ ] 7 - do it
", &["7-do-it.md", ".claims/7-do-it.claim"]);
        assert!(!has_pickable(dir.path()));
    }

    #[test]
    fn a_lone_reservation_marker_is_not_a_pickable_todo() {
        let dir = todos_dir("## Now
- [ ] 7 - do it
", &["7-.reserved"]);
        assert!(!has_pickable(dir.path()));
    }

    #[test]
    fn a_line_with_no_id_is_pickable() {
        let dir = todos_dir("- [ ] just a note to do\n", &[]);
        assert!(has_pickable(dir.path()));
    }

    #[test]
    fn no_plan_file_is_nothing_to_pick() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_pickable(dir.path()));
    }

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
    fn a_bare_device_id_line_yields_the_id() {
        assert_eq!(split_id("pc-1407"), (Some("pc-1407".to_string()), ""));
        assert_eq!(split_id("pc-1407 [P]"), (Some("pc-1407".to_string()), ""));
        assert_eq!(split_id("mac2-10000"), (Some("mac2-10000".to_string()), ""));
        assert_eq!(split_id("pc-1407 - label [P]"), (Some("pc-1407".to_string()), "label [P]"));
        assert_eq!(split_id("pc-1407 [P] - label"), (Some("pc-1407".to_string()), "label"));
        assert_eq!(split_id("mac2-10000 - label"), (Some("mac2-10000".to_string()), "label"));
    }

    #[test]
    fn plain_text_that_starts_with_a_number_is_not_an_id() {
        assert_eq!(split_id("2026 plan review"), (None, "2026 plan review"));
        assert_eq!(split_id("fix pc-1407 soon"), (None, "fix pc-1407 soon"));
        assert_eq!(split_id("just words"), (None, "just words"));
    }

    #[test]
    fn a_bare_id_line_is_a_row_whose_text_is_the_id() {
        let items = parse_plan("## A
- [ ] pc-1407
- [ ] pc-1408 [P]
", REPO);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id.as_deref(), Some("pc-1407"));
        assert_eq!(items[0].text, "pc-1407");
    }

    #[test]
    fn read_plan_swaps_a_bare_ids_text_for_the_todos_title() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(&todos).unwrap();
        std::fs::write(todos.join("PLAN.md"), "## A
- [ ] pc-0007
- [ ] pc-0008
").unwrap();
        std::fs::write(todos.join("pc-0007-the-thing.md"), "# Ship the thing
").unwrap();
        let items = read_plan(&dir.path().to_string_lossy());
        assert_eq!(items[0].text, "Ship the thing");
        assert_eq!(items[1].text, "pc-0008", "no file: the id stays");
    }

    #[test]
    fn a_bare_device_id_with_its_file_is_pickable_and_a_claim_hides_it() {
        let dir = todos_dir("## Now
- [ ] pc-0007
", &["pc-0007-do-it.md"]);
        assert!(has_pickable(dir.path()));
        let claimed = todos_dir("## Now
- [ ] pc-0007
", &["pc-0007-do-it.md", ".claims/pc-0007.claim"]);
        assert!(!has_pickable(claimed.path()));
        let legacy_claim = todos_dir("## Now
- [ ] pc-0007
", &["pc-0007-do-it.md", ".claims/7.claim"]);
        assert!(!has_pickable(legacy_claim.path()), "a legacy claim holds pc-0007");
        let gone = todos_dir("## Now
- [ ] pc-0007
", &[]);
        assert!(!has_pickable(gone.path()));
    }

    #[test]
    fn a_legacy_numeric_plan_line_finds_a_device_label_file_and_vice_versa() {
        let dir = todos_dir("## Now
- [ ] 7 - do it
", &["pc-0007-do-it.md"]);
        assert!(has_pickable(dir.path()));
        let other = todos_dir("## Now
- [ ] pc-7 - do it
", &["7-do-it.md"]);
        assert!(has_pickable(other.path()));
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
