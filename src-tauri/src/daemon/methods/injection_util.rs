//! Shape shared by every per-turn injected list (`user_todos`, `drafts_store`,
//! `schedule_mcp`): each caps its own list of cards, truncates each card's id
//! to a short form the model can echo back, and prints an "...and N more."
//! line once the cap is hit. The short-id length is a contract between the
//! injected text and each caller's id resolver, so it lives in one place;
//! each caller's own cap stays local, since those differ on purpose.

/// Chars of a full uuid a short id keeps. Full uuids would cost ~36 chars per
/// card; every caller's own id resolver accepts either form.
pub(crate) const SHORT_ID_LEN: usize = 8;

pub(crate) fn short(id: &str) -> String {
    id.chars().take(SHORT_ID_LEN).collect()
}

/// Appends up to `cap` items, one per line via `line_for`, then - if more
/// remain - a single "...and N more.\n" line. The exact wording every caller
/// already used, written once.
pub(crate) fn append_capped<T>(
    out: &mut String,
    items: &[T],
    cap: usize,
    mut line_for: impl FnMut(&T) -> String,
) {
    for item in items.iter().take(cap) {
        out.push_str(&line_for(item));
        out.push('\n');
    }
    if items.len() > cap {
        out.push_str(&format!("...and {} more.\n", items.len() - cap));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_takes_the_first_eight_chars() {
        assert_eq!(short("0123456789abcdef"), "01234567");
    }

    #[test]
    fn append_capped_prints_the_overflow_line_only_past_the_cap() {
        let mut out = String::new();
        append_capped(&mut out, &[1, 2, 3], 2, |n| format!("- {n}"));
        assert_eq!(out, "- 1\n- 2\n...and 1 more.\n");
    }

    #[test]
    fn append_capped_omits_the_overflow_line_when_everything_fits() {
        let mut out = String::new();
        append_capped(&mut out, &[1, 2], 2, |n| format!("- {n}"));
        assert_eq!(out, "- 1\n- 2\n");
    }
}
