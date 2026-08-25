//! `<cc-preview:SLUG>..</cc-preview>` extraction (todo 291): the in-app chat
//! AI wraps mockup HTML in this instead of pasting it raw. A self-contained
//! sentinel cluster with no shared state with `parse_line`, the same shape
//! `blocks.rs` already extracted for the daemon-meta/author sentinels.

/// Extracts a `<cc-preview:SLUG>..</cc-preview>` block. Mirrors `<cc-title:..>`'s
/// colon-open shape; last well-formed block wins.
/// `pub(crate)` (not `pub(super)`): `daemon/pump.rs` calls this via the
/// `mod.rs` re-export at `crate::chat::parser::extract_cc_preview_push`.
pub(crate) fn extract_cc_preview_push(text: &str) -> Option<(String, String)> {
    const OPEN: &str = "<cc-preview:";
    const CLOSE: &str = "</cc-preview>";
    let mut rest = text;
    let mut found = None;
    while let Some(start) = rest.find(OPEN) {
        let after_open = &rest[start + OPEN.len()..];
        let Some(gt) = after_open.find('>') else { break };
        let slug = after_open[..gt].trim();
        let after_slug = &after_open[gt + 1..];
        let Some(close) = after_slug.find(CLOSE) else { break };
        let html = after_slug[..close].trim();
        if !slug.is_empty() && !html.is_empty() {
            found = Some((slug.to_string(), html.to_string()));
        }
        rest = &after_slug[close + CLOSE.len()..];
    }
    found
}

/// Display title for a chat-pushed preview, derived from its slug since the
/// sentinel carries no separate title field (`mockup-ring` -> `Mockup Ring`).
pub(crate) fn preview_title_from_slug(slug: &str) -> String {
    slug.split(|c| c == '-' || c == '_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_cc_preview_push_slug_and_html() {
        let text = "Here you go:\n<cc-preview:mockup-ring>\n<html><body>ring</body></html>\n</cc-preview>\nDone.";
        let (slug, html) = extract_cc_preview_push(text).expect("must find sentinel");
        assert_eq!(slug, "mockup-ring");
        assert_eq!(html, "<html><body>ring</body></html>");
    }

    #[test]
    fn extract_cc_preview_push_last_wins_on_retry() {
        let text = "<cc-preview:a><p>first</p></cc-preview> then <cc-preview:b><p>second</p></cc-preview>";
        let (slug, html) = extract_cc_preview_push(text).expect("must find sentinel");
        assert_eq!(slug, "b");
        assert_eq!(html, "<p>second</p>");
    }

    #[test]
    fn extract_cc_preview_push_ignores_unterminated_block() {
        assert_eq!(extract_cc_preview_push("<cc-preview:mockup>no closing tag here"), None);
        assert_eq!(extract_cc_preview_push("no marker at all"), None);
    }

    #[test]
    fn preview_title_from_slug_title_cases_words() {
        assert_eq!(preview_title_from_slug("mockup-ring"), "Mockup Ring");
        assert_eq!(preview_title_from_slug("login_form"), "Login Form");
        assert_eq!(preview_title_from_slug("single"), "Single");
    }
}
