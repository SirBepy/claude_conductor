//! Reads of the todo files under `.claude/todos/` for the Backlog panel: the
//! cheap head parse the list needs, the full section split the reader needs,
//! and the listing that joins both with PLAN.md placement and live claims.

use super::md_scan::{fenced_lines, is_fence};
use super::plan_edit::{read_plan_doc, Placement};
use super::todo_ids::{find_todo_file, parse_file_name, TodoKey};
use super::todo_stats::{live_claim_keys, todos_dir};
use crate::ipc::ai_todos::{AiBacklog, AiTodoDoc, AiTodoEntry, AiTodoSection};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

/// How much of a todo file the list reads. The title, `**Type:**`/`**Origin:**`/
/// `**Summary:**` lines, the cleanup comment and `## Goal` all sit in the first
/// screen of a todo; the long Context/Approach tail is the reader's business.
const HEAD_BYTES: u64 = 16 * 1024;

/// What the list needs from a todo's head.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Head {
    pub title: String,
    pub summary: Option<String>,
    pub origin: Option<String>,
    pub todo_type: Option<String>,
    pub worth: Option<u8>,
    pub complexity: Option<String>,
}

/// `android-loopback-tunnel` -> `Android loopback tunnel`.
fn prettify_slug(slug: &str) -> String {
    let words = slug.replace('-', " ");
    let mut chars = words.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The first sentence of a paragraph: up to and including the first `.`, `!`
/// or `?` that is followed by whitespace or the end.
fn first_sentence(paragraph: &str) -> String {
    let flat = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = flat.trim_start_matches(['-', '*']).trim_start().to_string();
    let bytes: Vec<char> = flat.chars().collect();
    for (i, c) in bytes.iter().enumerate() {
        if matches!(c, '.' | '!' | '?') && bytes.get(i + 1).is_none_or(|n| n.is_whitespace()) {
            return bytes[..=i].iter().collect();
        }
    }
    flat
}

/// `value` of `key=value` inside a cleanup comment, up to a comma or space.
fn comment_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let at = line.find(&format!("{key}="))? + key.len() + 1;
    let rest = &line[at..];
    let end = rest.find([',', ' ', '-']).unwrap_or(rest.len());
    Some(&rest[..end]).filter(|v| !v.is_empty())
}

/// The head fields of a todo's text. `fallback_title` stands in when there is
/// no `# ` heading.
pub fn parse_head(text: &str, fallback_title: &str) -> Head {
    let mut head = Head::default();
    let mut title: Option<String> = None;
    let mut seen_section = false;
    let mut in_goal = false;
    let mut goal = String::new();
    let mut goal_done = false;
    for (line, in_fence) in fenced_lines(text.lines()) {
        if in_fence {
            continue;
        }
        let line = line.trim_end();
        let trimmed = line.trim();
        if trimmed.starts_with("<!--") && trimmed.contains("cleanup:") && head.complexity.is_none() && head.worth.is_none() {
            head.complexity = comment_value(trimmed, "complexity").map(str::to_string);
            head.worth = comment_value(trimmed, "worth").and_then(|w| w.parse().ok());
            continue;
        }
        if let Some(t) = line.strip_prefix("# ") {
            if title.is_none() {
                title = Some(t.trim().to_string());
            }
            continue;
        }
        if let Some(h) = line.strip_prefix("## ") {
            seen_section = true;
            if in_goal && !goal.is_empty() {
                goal_done = true;
            }
            in_goal = !goal_done && h.trim().eq_ignore_ascii_case("goal");
            continue;
        }
        if !seen_section {
            if let Some(v) = line.strip_prefix("**Type:**") {
                head.todo_type = Some(v.trim().to_string()).filter(|v| !v.is_empty());
            } else if let Some(v) = line.strip_prefix("**Origin:**") {
                head.origin = v
                    .split_whitespace()
                    .next()
                    .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphabetic()).to_lowercase())
                    .filter(|w| w == "dev" || w == "ai");
            } else if let Some(v) = line.strip_prefix("**Summary:**") {
                head.summary = Some(v.trim().to_string()).filter(|v| !v.is_empty());
            }
        } else if in_goal {
            if trimmed.is_empty() {
                if !goal.is_empty() {
                    goal_done = true;
                    in_goal = false;
                }
            } else {
                goal.push_str(trimmed);
                goal.push(' ');
            }
        }
    }
    if head.summary.is_none() && !goal.is_empty() {
        head.summary = Some(first_sentence(&goal)).filter(|s| !s.is_empty());
    }
    head.title = title.filter(|t| !t.is_empty()).unwrap_or_else(|| fallback_title.to_string());
    head
}

fn fallback_title(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match parse_file_name(&name) {
        Some(p) if !p.slug.is_empty() => prettify_slug(&p.slug),
        Some(p) => p.key.canonical(),
        None => prettify_slug(name.strip_suffix(".md").unwrap_or(&name)),
    }
}

/// The head of the todo at `path`, reading only its first `HEAD_BYTES`.
pub fn read_head(path: &Path) -> Option<Head> {
    let mut buf = Vec::new();
    std::fs::File::open(path).ok()?.take(HEAD_BYTES).read_to_end(&mut buf).ok()?;
    Some(parse_head(&String::from_utf8_lossy(&buf), &fallback_title(path)))
}

/// Drops `<!-- ... -->` comments (single or multi-line) outside code fences.
/// A line that held only a comment is dropped whole.
pub fn strip_html_comments(text: &str) -> String {
    let mut out = String::new();
    let mut in_comment = false;
    let mut in_fence = false;
    for line in text.lines() {
        // Fence state is tracked here, not via `fenced_lines`: a fence line inside
        // an open comment is comment text, and toggling on it would leave every
        // later comment unstripped.
        if !in_comment && is_fence(line) {
            in_fence = !in_fence;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_fence {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let mut rest = line;
        let mut kept = String::new();
        let mut touched = false;
        loop {
            if in_comment {
                touched = true;
                match rest.find("-->") {
                    Some(i) => {
                        rest = &rest[i + 3..];
                        in_comment = false;
                    }
                    None => break,
                }
            } else {
                match rest.find("<!--") {
                    Some(i) => {
                        kept.push_str(&rest[..i]);
                        rest = &rest[i + 4..];
                        in_comment = true;
                    }
                    None => {
                        kept.push_str(rest);
                        break;
                    }
                }
            }
        }
        if touched && kept.trim().is_empty() {
            continue;
        }
        out.push_str(&kept);
        out.push('\n');
    }
    out
}

/// A todo's `## ` sections after its comments are stripped: the Why body (if
/// the todo has one) and every other section in file order.
pub fn parse_sections(text: &str) -> (Option<String>, Vec<AiTodoSection>) {
    let clean = strip_html_comments(text);
    let mut sections: Vec<(String, Vec<&str>)> = Vec::new();
    for (line, in_fence) in fenced_lines(clean.lines()) {
        match line.strip_prefix("## ").filter(|_| !in_fence) {
            Some(h) => sections.push((h.trim().to_string(), Vec::new())),
            None => {
                if let Some((_, body)) = sections.last_mut() {
                    body.push(line);
                }
            }
        }
    }
    let mut why = None;
    let mut out = Vec::new();
    for (heading, body) in sections {
        let markdown = body.join("\n").trim().to_string();
        if heading.eq_ignore_ascii_case("why") {
            why = Some(markdown).filter(|m| !m.is_empty());
        } else {
            out.push(AiTodoSection { heading, markdown });
        }
    }
    (why, out)
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// One list row. `placement` is where PLAN.md puts the todo, if it does.
fn entry_for(path: &Path, head: Head, key: Option<&TodoKey>, placement: Option<&Placement>, live: &HashSet<TodoKey>) -> AiTodoEntry {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let id = key
        .map(TodoKey::canonical)
        .unwrap_or_else(|| name.strip_suffix(".md").unwrap_or(&name).to_string());
    AiTodoEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        id,
        title: head.title,
        summary: head.summary,
        origin: head.origin,
        todo_type: head.todo_type,
        worth: head.worth,
        complexity: head.complexity,
        claimed: key.is_some_and(|k| live.contains(k)),
        group: placement.map(|p| p.group.clone()),
        plan_index: placement.map(|p| p.plan_index),
        mtime_ms: mtime_ms(path),
    }
}

/// The first PLAN placement naming `key`.
fn placement_for<'a>(placements: &'a [Placement], key: &TodoKey) -> Option<&'a Placement> {
    placements.iter().find(|p| p.wanted.matches(key))
}

/// Every backlog todo of `todos_dir` with its PLAN placement and claim state,
/// ordered by id (label, then number), plus the PLAN groups.
pub fn list_backlog(todos_dir: &Path) -> AiBacklog {
    let plan = read_plan_doc(todos_dir);
    let placements = plan.placements();
    let live = live_claim_keys(todos_dir);
    let mut todos: Vec<(Option<TodoKey>, AiTodoEntry)> = std::fs::read_dir(todos_dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| super::todo_stats::is_backlog_file(p))
                .map(|p| {
                    let key = p.file_name().and_then(|n| n.to_str()).and_then(parse_file_name).map(|n| n.key);
                    let head = read_head(&p).unwrap_or_else(|| Head { title: fallback_title(&p), ..Head::default() });
                    let placement = key.as_ref().and_then(|k| placement_for(&placements, k));
                    let entry = entry_for(&p, head, key.as_ref(), placement, &live);
                    (key, entry)
                })
                .collect()
        })
        .unwrap_or_default();
    todos.sort_by(|a, b| match (&a.0, &b.0) {
        (Some(x), Some(y)) => (&x.label, x.number, &a.1.name).cmp(&(&y.label, y.number, &b.1.name)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.name.cmp(&b.1.name),
    });
    AiBacklog { groups: plan.groups(), todos: todos.into_iter().map(|t| t.1).collect() }
}

/// The reader's document for the todo `id` names (any spelling `todo_ids`
/// accepts).
pub fn read_doc(todos_dir: &Path, id: &str, device: &str) -> Result<AiTodoDoc, String> {
    let path = find_todo_file(todos_dir, id, device)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let text = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let key = path.file_name().and_then(|n| n.to_str()).and_then(parse_file_name).map(|n| n.key);
    let plan = read_plan_doc(todos_dir).placements();
    let placement = key.as_ref().and_then(|k| placement_for(&plan, k));
    let head = parse_head(text, &fallback_title(&path));
    let entry = entry_for(&path, head, key.as_ref(), placement, &live_claim_keys(todos_dir));
    let (why, sections) = parse_sections(text);
    Ok(AiTodoDoc { entry, why, sections })
}

/// `list_backlog` for a repo root.
pub fn list_backlog_for_repo(cwd: &str) -> AiBacklog {
    list_backlog(&todos_dir(Path::new(cwd)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW_FORMAT: &str = "<!-- Claim before executing: .claude/todos/.claims/ per close/ai-todos-format.md -->\n\
<!-- cleanup: last-checked 2026-10-27, complexity=HARD, worth=6, reconfirm-count=2, content-hash=c5bd0e4b -->\n\
# Android: the tunnel port is open\n\
\n\
**Type:** task\n\
**Origin:** dev\n\
**Summary:** Only the app's own WebView can use the tunnel.\n\
\n\
## Why\n\
\n\
Joe, 2026-10-18: \"any app can ride it\".\n\
\n\
## Goal\n\
\n\
Goal sentence one. Goal sentence two.\n\
\n\
## Context\n\
\n\
Some context.\n\
\n\
<!-- hidden note -->\n\
## Approach\n\
\n\
- step one\n";

    #[test]
    fn the_new_format_head_has_every_field() {
        let h = parse_head(NEW_FORMAT, "fallback");
        assert_eq!(h.title, "Android: the tunnel port is open");
        assert_eq!(h.todo_type.as_deref(), Some("task"));
        assert_eq!(h.origin.as_deref(), Some("dev"));
        assert_eq!(h.summary.as_deref(), Some("Only the app's own WebView can use the tunnel."));
        assert_eq!(h.complexity.as_deref(), Some("HARD"));
        assert_eq!(h.worth, Some(6));
    }

    #[test]
    fn a_legacy_todo_has_no_summary_so_the_goals_first_sentence_stands_in() {
        let legacy = "<!-- Claim -->\n# Old todo\n\n**Type:** task\n**Origin:** ai\n\n## Goal\n\nFix the parser so it keeps\nits lines. Then ship it.\n\n## Context\n\nx\n";
        let h = parse_head(legacy, "fallback");
        assert_eq!(h.summary.as_deref(), Some("Fix the parser so it keeps its lines."));
        assert_eq!(h.origin.as_deref(), Some("ai"));
        assert_eq!((h.complexity, h.worth), (None, None));
    }

    #[test]
    fn an_explicit_summary_beats_the_goal() {
        let h = parse_head("# T\n**Summary:** Plain.\n## Goal\n\nOther.\n", "f");
        assert_eq!(h.summary.as_deref(), Some("Plain."));
    }

    #[test]
    fn no_summary_and_no_goal_leaves_the_summary_empty() {
        assert_eq!(parse_head("# T\n\n## Context\n\nx\n", "f").summary, None);
    }

    #[test]
    fn a_todo_without_a_heading_uses_the_fallback_title() {
        assert_eq!(parse_head("**Type:** task\n", "Fallback title").title, "Fallback title");
    }

    #[test]
    fn crlf_text_parses_the_same() {
        let crlf = NEW_FORMAT.replace('\n', "\r\n");
        assert_eq!(parse_head(&crlf, "f"), parse_head(NEW_FORMAT, "f"));
        let (why, sections) = parse_sections(&crlf);
        assert_eq!(why.as_deref(), Some("Joe, 2026-10-18: \"any app can ride it\"."));
        assert_eq!(sections.len(), 3);
    }

    #[test]
    fn an_origin_with_a_trailing_note_still_reads() {
        assert_eq!(parse_head("# T\n**Origin:** dev (Joe said so)\n", "f").origin.as_deref(), Some("dev"));
        assert_eq!(parse_head("# T\n**Origin:** somebody\n", "f").origin, None);
    }

    #[test]
    fn fields_inside_a_code_fence_are_ignored() {
        let h = parse_head("# Real\n```\n# Fake\n**Summary:** nope\n```\n", "f");
        assert_eq!((h.title.as_str(), h.summary), ("Real", None));
    }

    #[test]
    fn sections_skip_why_strip_comments_and_keep_order() {
        let (why, sections) = parse_sections(NEW_FORMAT);
        assert_eq!(why.as_deref(), Some("Joe, 2026-10-18: \"any app can ride it\"."));
        let headings: Vec<&str> = sections.iter().map(|s| s.heading.as_str()).collect();
        assert_eq!(headings, ["Goal", "Context", "Approach"]);
        assert_eq!(sections[1].markdown, "Some context.");
        assert!(!sections.iter().any(|s| s.markdown.contains("hidden")));
        assert_eq!(sections[2].markdown, "- step one");
    }

    #[test]
    fn a_todo_with_no_why_has_none() {
        let (why, sections) = parse_sections("# T\n\n## Goal\n\nx\n");
        assert_eq!(why, None);
        assert_eq!(sections.len(), 1);
    }

    #[test]
    fn multi_line_comments_and_fenced_code_survive_stripping_correctly() {
        let text = "## A\n<!-- one\ntwo -->\nkept\n```\n<!-- not a comment -->\n```\ntail <!-- inline --> end\n";
        let out = strip_html_comments(text);
        assert_eq!(out, "## A\nkept\n```\n<!-- not a comment -->\n```\ntail  end\n");
    }

    #[test]
    fn a_hash_hash_inside_a_fence_does_not_split_a_section() {
        let (_, sections) = parse_sections("## A\n```\n## not a heading\n```\n## B\nx\n");
        assert_eq!(sections.iter().map(|s| s.heading.as_str()).collect::<Vec<_>>(), ["A", "B"]);
    }

    #[test]
    fn a_fence_line_inside_an_open_comment_does_not_flip_fence_state() {
        let text = "## A\n<!-- note\n```\nmore -->\nbody\n<!-- later -->\n## B\nx\n";
        assert_eq!(strip_html_comments(text), "## A\nbody\n## B\nx\n");
        let (_, sections) = parse_sections(text);
        assert_eq!(sections.iter().map(|s| s.heading.as_str()).collect::<Vec<_>>(), ["A", "B"]);
    }

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).unwrap();
    }

    #[test]
    fn the_listing_joins_head_plan_and_claims() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::create_dir_all(d.join(".claims")).unwrap();
        write(d, "pc-0002-second-thing.md", "# Second\n**Origin:** dev\n**Summary:** S2.\n");
        write(d, "1-first.md", NEW_FORMAT);
        write(d, "pc-0009-unplanned-item.md", "no heading here\n");
        write(d, "PLAN.md", "# Plan\n\n## Release\n- [ ] pc-0002\n- [ ] pc-0001\n\n## Empty\n");
        write(d, ".claims/pc-0002.claim", "s");
        let backlog = list_backlog(d);
        assert_eq!(backlog.groups, ["Release", "Empty"]);
        let ids: Vec<&str> = backlog.todos.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["pc-0001", "pc-0002", "pc-0009"]);
        let [first, second, third] = &backlog.todos[..] else { panic!("three todos") };
        assert_eq!((first.group.as_deref(), first.plan_index, first.claimed), (Some("Release"), Some(1), false));
        assert_eq!((second.group.as_deref(), second.plan_index, second.claimed), (Some("Release"), Some(0), true));
        assert_eq!((third.group.clone(), third.plan_index), (None, None));
        assert_eq!(third.title, "Unplanned item", "no heading falls back to the prettified slug");
        assert_eq!(first.name, "1-first.md");
        assert!(first.mtime_ms > 0);
    }

    #[test]
    fn an_empty_or_missing_todos_dir_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let none = list_backlog(&dir.path().join("nope"));
        assert!(none.todos.is_empty() && none.groups.is_empty());
    }

    #[test]
    fn read_doc_resolves_any_spelling_and_returns_the_entry_why_and_sections() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pc-0007-the-todo.md", NEW_FORMAT);
        for id in ["pc-0007", "pc-7", "7"] {
            let doc = read_doc(dir.path(), id, "pc").unwrap();
            assert_eq!(doc.entry.id, "pc-0007");
            assert_eq!(doc.entry.title, "Android: the tunnel port is open");
            assert!(doc.why.is_some());
            assert_eq!(doc.sections.len(), 3);
        }
        assert!(read_doc(dir.path(), "pc-8", "pc").is_err());
    }

    #[test]
    fn read_doc_of_a_todo_with_no_why() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pc-0001-x.md", "# X\n\n## Goal\n\nDo x.\n");
        let doc = read_doc(dir.path(), "pc-1", "pc").unwrap();
        assert_eq!(doc.why, None);
        assert_eq!(doc.entry.summary.as_deref(), Some("Do x."));
    }

    #[test]
    fn only_the_head_of_a_big_file_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let big = format!("# Big\n**Summary:** Head summary.\n\n## Context\n\n{}\n", "filler line\n".repeat(5000));
        write(dir.path(), "pc-0001-big.md", &big);
        assert!((big.len() as u64) > HEAD_BYTES);
        let h = read_head(&dir.path().join("pc-0001-big.md")).unwrap();
        assert_eq!(h.title, "Big");
        assert_eq!(h.summary.as_deref(), Some("Head summary."));
    }
}
