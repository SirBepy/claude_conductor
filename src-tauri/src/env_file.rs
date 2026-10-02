//! Shared `.env` `KEY=value` line reader (todo 1049): `api_keys::is_key_set`
//! and `tickets::parse_env_value` each re-implemented the same BOM strip,
//! line split, trim and quote strip; this is the one place that logic lives
//! now, so a fix to quoting or BOM handling lands for both callers at once.
//! Writing stays with `api_keys::rewrite_env` - this module is read-only.

/// Reads one `KEY=value` line out of `text`. Tolerates a leading UTF-8 BOM (a
/// PowerShell-written copy of the file has carried one before), CRLF (via
/// `line.trim()`), and optional surrounding single/double quotes on the
/// value. The first matching line wins. A missing key and a present-but-empty
/// value both read as unset (`None`).
pub fn read_value(text: &str, key: &str) -> Option<String> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .find_map(|line| {
            let (k, v) = line.trim().split_once('=')?;
            (k.trim() == key).then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
        })
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bom_quotes_crlf_and_treats_empty_as_unset() {
        let text = "\u{feff}SHORTCUT_API_TOKEN=\"abc\"\r\nLINEAR_API_KEY=\r\n";
        assert_eq!(read_value(text, "SHORTCUT_API_TOKEN").as_deref(), Some("abc"));
        assert_eq!(read_value(text, "LINEAR_API_KEY"), None, "an empty value is unset");
        assert_eq!(read_value(text, "MISSING"), None);
    }

    #[test]
    fn single_quotes_and_plain_values_both_strip_and_pass_through() {
        let text = "FOO='bar'\nBAZ=1\n";
        assert_eq!(read_value(text, "FOO").as_deref(), Some("bar"));
        assert_eq!(read_value(text, "BAZ").as_deref(), Some("1"));
    }

    #[test]
    fn first_match_wins_on_a_duplicate_key() {
        let text = "KEY=first\nKEY=second\n";
        assert_eq!(read_value(text, "KEY").as_deref(), Some("first"));
    }
}
