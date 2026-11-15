//! Text helpers shared across modules.

/// `text` on one line (every whitespace run becomes one space), cut to at most `max`
/// characters with a trailing `…` when it was longer.
pub fn flat_clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let head: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::flat_clip;

    #[test]
    fn whitespace_runs_collapse_and_a_long_text_ends_in_one_ellipsis_within_the_cap() {
        assert_eq!(flat_clip("a \n\t b   c", 10), "a b c");
        assert_eq!(flat_clip("abcdef", 6), "abcdef");
        assert_eq!(flat_clip("abcdefg", 6), "abcde…");
        assert_eq!(flat_clip("éééé", 3), "éé…");
        assert_eq!(flat_clip("", 5), "");
    }
}
