//! The one reading of markdown structure that PLAN.md and todo files share:
//! which lines sit inside a fenced code block, and what a checkbox item line
//! looks like. `plan`, `plan_edit` and `todo_read` all go through here, so a
//! `## ` or `- [ ]` line inside a fence is plain text in every view instead of
//! a heading in one and prose in another.

/// Whether `line` opens or closes a fenced code block.
pub(crate) fn is_fence(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

/// Pairs each line with whether it is part of a fenced block. The opening and
/// closing fence lines count as part of it, so a caller that skips fenced lines
/// skips the delimiters too.
pub(crate) fn fenced_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> impl Iterator<Item = (&'a str, bool)> {
    let mut open = false;
    lines.into_iter().map(move |line| {
        if is_fence(line) {
            open = !open;
            (line, true)
        } else {
            (line, open)
        }
    })
}

/// `fenced_lines` for text that still holds its `<!-- ... -->` comments: a
/// fence line inside an open comment is comment text and does not toggle, the
/// same rule `todo_read::strip_html_comments` applies, so a commented-out fence
/// cannot hide the fields after it. Comment markers inside a fence are code.
/// The comment's own lines come back with the fence state they sit in.
pub(crate) fn fenced_lines_with_comments<'a>(
    lines: impl IntoIterator<Item = &'a str>,
) -> impl Iterator<Item = (&'a str, bool)> {
    let mut fence_open = false;
    let mut comment_open = false;
    lines.into_iter().map(move |line| {
        if !comment_open && is_fence(line) {
            fence_open = !fence_open;
            return (line, true);
        }
        if !fence_open {
            comment_open = comment_open_after(line, comment_open);
        }
        (line, fence_open)
    })
}

/// Whether a `<!--` comment is still open once `line` has been read, given
/// whether one was open before it.
fn comment_open_after(line: &str, mut open: bool) -> bool {
    let mut rest = line;
    loop {
        match (open, rest.find(if open { "-->" } else { "<!--" })) {
            (_, None) => return open,
            (true, Some(i)) => {
                rest = &rest[i + 3..];
                open = false;
            }
            (false, Some(i)) => {
                rest = &rest[i + 4..];
                open = true;
            }
        }
    }
}

/// A top-level checkbox list item.
pub(crate) struct Checkbox<'a> {
    /// `[ ]`; `[x]` and `[X]` are checked.
    pub open: bool,
    /// The text after the box, trimmed.
    pub rest: &'a str,
}

/// `- [ ] rest`, `- [x] rest` or `* [ ] rest`; `None` for any other line,
/// including an indented note under an item and a box with no space after it.
pub(crate) fn checkbox(line: &str) -> Option<Checkbox<'_>> {
    let after = line.strip_prefix("- [").or_else(|| line.strip_prefix("* ["))?;
    let mut chars = after.chars();
    let open = match chars.next()? {
        ' ' => true,
        'x' | 'X' => false,
        _ => return None,
    };
    let rest = chars.as_str().strip_prefix(']')?;
    rest.starts_with(' ').then(|| Checkbox { open, rest: rest.trim() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fence_lines_and_their_contents_are_marked_inside() {
        let got: Vec<bool> = fenced_lines(["a", "```", "b", "```", "c"]).map(|(_, f)| f).collect();
        assert_eq!(got, [false, true, true, true, false]);
    }

    #[test]
    fn an_unclosed_fence_runs_to_the_end() {
        let got: Vec<bool> = fenced_lines(["```rust", "x", "y"]).map(|(_, f)| f).collect();
        assert_eq!(got, [true, true, true]);
    }

    #[test]
    fn an_indented_fence_still_toggles() {
        let got: Vec<bool> = fenced_lines(["  ```", "x", "  ```", "y"]).map(|(_, f)| f).collect();
        assert_eq!(got, [true, true, true, false]);
    }

    #[test]
    fn a_fence_line_inside_an_open_comment_does_not_toggle() {
        let lines = ["a", "<!-- note", "```", "more -->", "b", "```", "c", "```", "d"];
        let got: Vec<bool> = fenced_lines_with_comments(lines).map(|(_, f)| f).collect();
        assert_eq!(got, [false, false, false, false, false, true, true, true, false]);
    }

    #[test]
    fn comment_markers_inside_a_fence_are_code() {
        let lines = ["```", "<!-- not a comment", "```", "after"];
        let got: Vec<bool> = fenced_lines_with_comments(lines).map(|(_, f)| f).collect();
        assert_eq!(got, [true, true, true, false]);
    }

    #[test]
    fn a_one_line_comment_and_a_reopened_one_track_correctly() {
        // The fence inside the second, still open comment is text; the one after
        // the comment closes opens a real block that runs to the end.
        let lines = ["<!-- x --> <!-- y", "```", "-->", "```", "z"];
        let got: Vec<bool> = fenced_lines_with_comments(lines).map(|(_, f)| f).collect();
        assert_eq!(got, [false, false, false, true, true]);
    }

    #[test]
    fn checkbox_reads_open_and_checked_items_only_at_top_level() {
        let open = checkbox("- [ ] pc-1 - go").unwrap();
        assert!(open.open);
        assert_eq!(open.rest, "pc-1 - go");
        assert!(!checkbox("* [x] done").unwrap().open);
        assert!(!checkbox("- [X] done").unwrap().open);
        assert!(checkbox("  - [ ] nested").is_none());
        assert!(checkbox("- [ ]no space").is_none());
        assert!(checkbox("- [?] odd").is_none());
        assert!(checkbox("plain").is_none());
    }
}
