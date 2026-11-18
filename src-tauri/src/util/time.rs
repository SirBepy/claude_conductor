/// Now as UTC RFC 3339 with a fixed three-digit fraction and a `Z` suffix. The fixed
/// width makes a plain `String` comparison sort chronologically, which the preview
/// list and the settings-sync stamps both rely on.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::now_rfc3339;

    #[test]
    fn the_stamp_has_a_fixed_width_so_strings_sort_by_time() {
        let a = now_rfc3339();
        // `2026-11-18T10:20:30.123Z`
        assert_eq!(a.len(), 24, "{a}");
        assert!(a.ends_with('Z'), "{a}");
        assert_eq!(a.as_bytes()[19], b'.', "{a}");
        let later = chrono::DateTime::parse_from_rfc3339(&a).unwrap() + chrono::Duration::seconds(1);
        assert!(later.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true) > a);
    }
}
