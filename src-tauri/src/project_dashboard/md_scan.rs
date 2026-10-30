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
