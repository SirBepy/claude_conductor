//! The tiny path language that turns an API/command response into card values.
//!
//! Grammar: dot-separated keys, `[n]` index (negative counts from the end),
//! `[]` map-over-array (yields an array of what the rest of the path finds,
//! skipping elements where it finds nothing), and `sum(<path>)` which adds up
//! numbers and ISO-8601 durations. A sum of durations is in SECONDS, so pair it
//! with the `duration_s` format. An empty path (or `$`) is the root value.
//! A path that finds nothing is never an error: it renders as `-`.

use super::types::{CardDisplay, LabelValue, RowValue, StatSpec};
use serde_json::Value;

/// Shown wherever a path finds nothing or a value cannot be formatted.
pub const PLACEHOLDER: &str = "-";

/// Rows shown when a list card sets no `limit`.
const DEFAULT_LIST_LIMIT: usize = 10;

#[derive(Debug, PartialEq)]
enum Seg {
    Key(String),
    Index(i64),
    Each,
}

fn parse_segments(path: &str) -> Option<Vec<Seg>> {
    let path = path.trim();
    let path = path.strip_prefix('$').unwrap_or(path);
    let path = path.strip_prefix('.').unwrap_or(path);
    let mut segs = Vec::new();
    let mut key = String::new();
    let mut chars = path.chars().peekable();
    let flush = |key: &mut String, segs: &mut Vec<Seg>| {
        if !key.is_empty() {
            segs.push(Seg::Key(std::mem::take(key)));
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '.' => flush(&mut key, &mut segs),
            '[' => {
                flush(&mut key, &mut segs);
                let mut inner = String::new();
                loop {
                    match chars.next()? {
                        ']' => break,
                        ch => inner.push(ch),
                    }
                }
                let inner = inner.trim();
                if inner.is_empty() {
                    segs.push(Seg::Each);
                } else {
                    segs.push(Seg::Index(inner.parse().ok()?));
                }
            }
            ']' => return None,
            ch => key.push(ch),
        }
    }
    flush(&mut key, &mut segs);
    Some(segs)
}

fn resolve(v: &Value, segs: &[Seg]) -> Option<Value> {
    let Some((head, rest)) = segs.split_first() else { return Some(v.clone()) };
    match head {
        Seg::Key(k) => resolve(v.get(k.as_str())?, rest),
        Seg::Index(n) => {
            let arr = v.as_array()?;
            let i = if *n < 0 { arr.len().checked_sub(n.unsigned_abs() as usize)? } else { *n as usize };
            resolve(arr.get(i)?, rest)
        }
        Seg::Each => {
            let arr = v.as_array()?;
            let nested = rest.iter().any(|s| *s == Seg::Each);
            let mut out = Vec::new();
            for item in arr {
                match resolve(item, rest) {
                    // A further `[]` yields arrays; flatten so `a[].b[].c` is one flat list.
                    Some(Value::Array(inner)) if nested => out.extend(inner),
                    Some(found) => out.push(found),
                    None => {}
                }
            }
            Some(Value::Array(out))
        }
    }
}

/// Evaluates a path (including `sum(...)`) against `root`. `None` when the
/// path is malformed or finds nothing.
pub fn eval_path(root: &Value, path: &str) -> Option<Value> {
    let path = path.trim();
    if let Some(inner) = path.strip_prefix("sum(").and_then(|p| p.strip_suffix(')')) {
        let found = resolve(root, &parse_segments(inner)?)?;
        return Some(sum_value(&found));
    }
    resolve(root, &parse_segments(path)?)
}

fn sum_value(v: &Value) -> Value {
    let total: f64 = match v {
        Value::Array(items) => items.iter().filter_map(summable).sum(),
        other => summable(other).unwrap_or(0.0),
    };
    number_value(total)
}

fn summable(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_iso_duration(s).or_else(|| s.trim().parse().ok()),
        _ => None,
    }
}

fn number_value(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// `PT1H30M`, `P1DT2H`, `PT45S`, `PT1.5S` -> seconds. Year/month designators
/// are refused: their length is not fixed, and no card source needs them.
pub fn parse_iso_duration(s: &str) -> Option<f64> {
    let rest = s.trim().strip_prefix('P')?;
    if rest.is_empty() {
        return None;
    }
    let (date, time) = match rest.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (rest, None),
    };
    if time == Some("") {
        return None;
    }
    let mut total = 0.0;
    for (part, units) in [(date, &[('W', 604_800.0), ('D', 86_400.0)][..]), (time.unwrap_or(""), &[('H', 3600.0), ('M', 60.0), ('S', 1.0)][..])] {
        let mut num = String::new();
        for c in part.chars() {
            if c.is_ascii_digit() || c == '.' {
                num.push(c);
            } else {
                let mult = units.iter().find(|(u, _)| *u == c)?.1;
                total += num.parse::<f64>().ok()? * mult;
                num.clear();
            }
        }
        if !num.is_empty() {
            return None;
        }
    }
    Some(total)
}

fn fmt_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        return format!("{}", f as i64);
    }
    let s = format!("{f:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// `14h 30m`, `2h`, `45m`, `30s`. Rounds to the nearest minute once past a
/// minute, so a sum of many entries does not show a stray seconds tail.
fn fmt_duration(secs: f64) -> String {
    let secs = secs.max(0.0);
    if secs < 60.0 {
        return format!("{}s", secs.round() as i64);
    }
    let mins = (secs / 60.0).round() as i64;
    let (h, m) = (mins / 60, mins % 60);
    match (h, m) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

fn parse_timestamp_ms(v: &Value) -> Option<i64> {
    let epoch = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if !s.trim().is_empty() && s.trim().chars().all(|c| c.is_ascii_digit()) => s.trim().parse().ok(),
        _ => None,
    };
    if let Some(n) = epoch {
        // Epoch seconds vs milliseconds: anything past year 5138 in seconds is really ms.
        return Some(if n.abs() >= 1e11 { n as i64 } else { (n * 1000.0) as i64 });
    }
    let s = v.as_str()?.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.and_utc().timestamp_millis());
    }
    let date = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

fn fmt_relative(then_ms: i64, now_ms: i64) -> String {
    let diff = now_ms - then_ms;
    let (secs, future) = (diff.abs() / 1000, diff < 0);
    let span = match secs {
        0..=59 => return "just now".to_string(),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => format!("{}h", secs / 3600),
        86_400..=2_591_999 => format!("{}d", secs / 86_400),
        2_592_000..=31_535_999 => format!("{}mo", secs / 2_592_000),
        _ => format!("{}y", secs / 31_536_000),
    };
    if future { format!("in {span}") } else { format!("{span} ago") }
}

/// Short human string for `v` in `format`. Unknown formats behave as `text`;
/// a value the format cannot read is the placeholder.
pub fn format_value(v: &Value, format: &str) -> String {
    format_value_at(v, format, chrono::Utc::now().timestamp_millis())
}

/// `format_value` with an injected clock, so `relative_time` is testable.
pub fn format_value_at(v: &Value, format: &str, now_ms: i64) -> String {
    let ph = || PLACEHOLDER.to_string();
    match format.trim() {
        "number" => as_f64(v).map(fmt_number).unwrap_or_else(ph),
        "count" => match v {
            Value::Array(a) => a.len().to_string(),
            Value::Object(o) => o.len().to_string(),
            _ => ph(),
        },
        "duration_s" => as_f64(v).map(fmt_duration).unwrap_or_else(ph),
        "duration_ms" => as_f64(v).map(|ms| fmt_duration(ms / 1000.0)).unwrap_or_else(ph),
        "duration_iso" => v.as_str().and_then(parse_iso_duration).map(fmt_duration).unwrap_or_else(ph),
        "relative_time" => parse_timestamp_ms(v).map(|t| fmt_relative(t, now_ms)).unwrap_or_else(ph),
        _ => text_of(v),
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::Null => PLACEHOLDER.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map(fmt_number).unwrap_or_else(|| n.to_string()),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items.iter().map(text_of).collect::<Vec<_>>().join(", "),
        Value::Object(_) => v.to_string(),
    }
}

/// Evaluates every stat / list row the card's display asks for. Never fails:
/// a missing path yields the placeholder (stats) or no row (list).
pub fn apply_display(json: &Value, display: &CardDisplay) -> (Vec<LabelValue>, Vec<RowValue>) {
    match display {
        CardDisplay::Stats { items } => (items.iter().map(|s| stat(json, s)).collect(), Vec::new()),
        CardDisplay::List { items_path, label_path, value_path, link_path, limit } => {
            let items = match eval_path(json, items_path) {
                Some(Value::Array(a)) => a,
                _ => Vec::new(),
            };
            let limit = limit.map(|l| l as usize).unwrap_or(DEFAULT_LIST_LIMIT);
            let rows = items
                .iter()
                .take(limit)
                .map(|item| RowValue {
                    label: text_at(item, label_path),
                    value: if value_path.trim().is_empty() { String::new() } else { text_at(item, value_path) },
                    link: link_path
                        .as_deref()
                        .filter(|p| !p.trim().is_empty())
                        .and_then(|p| eval_path(item, p))
                        .and_then(|v| v.as_str().map(str::to_string))
                        .filter(|s| !s.is_empty()),
                })
                .collect();
            (Vec::new(), rows)
        }
    }
}

fn text_at(item: &Value, path: &str) -> String {
    eval_path(item, path).map(|v| format_value(&v, "text")).unwrap_or_else(|| PLACEHOLDER.to_string())
}

fn stat(json: &Value, spec: &StatSpec) -> LabelValue {
    let value = eval_path(json, &spec.path)
        .map(|v| format_value(&v, &spec.format))
        .unwrap_or_else(|| PLACEHOLDER.to_string());
    LabelValue { label: spec.label.clone(), value }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn clockify() -> Value {
        json!([
            {"description": "a", "timeInterval": {"start": "2026-10-19T08:00:00Z", "duration": "PT1H30M"}},
            {"description": "b", "timeInterval": {"start": "2026-10-20T08:00:00Z", "duration": "PT8H"}},
            {"description": "c", "timeInterval": {"start": "2026-10-21T08:00:00Z", "duration": "PT5H"}},
            {"description": "running", "timeInterval": {"start": "2026-10-22T08:00:00Z", "duration": null}}
        ])
    }

    fn shortcut() -> Value {
        json!({"data": [
            {"name": "Fix login", "workflow_state_id": 500001, "app_url": "https://app.shortcut.com/x/story/1"},
            {"name": "Add export", "workflow_state_id": 500002, "app_url": "https://app.shortcut.com/x/story/2"}
        ], "total": 2})
    }

    #[test]
    fn dot_keys_and_indexes() {
        let v = json!({"a": {"b": [10, 20, {"c": "deep"}]}});
        assert_eq!(eval_path(&v, "a.b[1]"), Some(json!(20)));
        assert_eq!(eval_path(&v, "a.b[2].c"), Some(json!("deep")));
        assert_eq!(eval_path(&v, "a.b[-1].c"), Some(json!("deep")));
        assert_eq!(eval_path(&v, "$.a.b[0]"), Some(json!(10)));
        assert_eq!(eval_path(&json!([[1, 2], [3]]), "[0][1]"), Some(json!(2)));
    }

    #[test]
    fn empty_path_and_dollar_are_the_root() {
        let v = json!({"x": 1});
        assert_eq!(eval_path(&v, ""), Some(v.clone()));
        assert_eq!(eval_path(&v, "$"), Some(v));
    }

    #[test]
    fn map_over_array_skips_misses_and_flattens_nested() {
        let v = shortcut();
        assert_eq!(eval_path(&v, "data[].name"), Some(json!(["Fix login", "Add export"])));
        let ragged = json!({"a": [{"b": 1}, {"z": 0}, {"b": 3}]});
        assert_eq!(eval_path(&ragged, "a[].b"), Some(json!([1, 3])));
        let nested = json!({"a": [{"b": [{"c": 1}, {"c": 2}]}, {"b": [{"c": 3}]}]});
        assert_eq!(eval_path(&nested, "a[].b[].c"), Some(json!([1, 2, 3])));
        assert_eq!(eval_path(&json!([1, 2]), "[]"), Some(json!([1, 2])));
    }

    #[test]
    fn bad_paths_find_nothing_instead_of_panicking() {
        let v = json!({"a": [1]});
        for p in ["a[5]", "a[-9]", "a[x]", "a[", "a]", "nope.deeper", "a.b", "a[0].b", "sum(", "sum(nope)", "a[]]"] {
            assert_eq!(eval_path(&v, p), None, "path {p:?}");
        }
        assert_eq!(eval_path(&json!(5), "x"), None);
        assert_eq!(eval_path(&json!(null), "x[0]"), None);
    }

    #[test]
    fn sum_adds_iso_durations_in_seconds_and_skips_non_summable() {
        let v = clockify();
        assert_eq!(eval_path(&v, "sum([].timeInterval.duration)"), Some(json!(52_200)));
        assert_eq!(format_value(&eval_path(&v, "sum([].timeInterval.duration)").unwrap(), "duration_s"), "14h 30m");
        let nums = json!({"xs": [1, 2.5, "3", "n/a", null, true]});
        assert_eq!(eval_path(&nums, "sum(xs)"), Some(json!(6.5)));
        assert_eq!(eval_path(&json!({"xs": []}), "sum(xs)"), Some(json!(0)));
        assert_eq!(eval_path(&json!({"n": 4}), "sum(n)"), Some(json!(4)));
    }

    #[test]
    fn iso_duration_parsing() {
        assert_eq!(parse_iso_duration("PT1H30M"), Some(5400.0));
        assert_eq!(parse_iso_duration("PT45S"), Some(45.0));
        assert_eq!(parse_iso_duration("PT1.5S"), Some(1.5));
        assert_eq!(parse_iso_duration("P1DT2H"), Some(93_600.0));
        assert_eq!(parse_iso_duration("P1W"), Some(604_800.0));
        for bad in ["", "P", "PT", "1H", "PT1", "PT1X", "P1Y", "P1M", "abc"] {
            assert_eq!(parse_iso_duration(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn format_numbers_have_no_trailing_zero() {
        assert_eq!(format_value(&json!(3.0), "number"), "3");
        assert_eq!(format_value(&json!(3), "number"), "3");
        assert_eq!(format_value(&json!(2.5), "number"), "2.5");
        assert_eq!(format_value(&json!(0.1 + 0.2), "number"), "0.3");
        assert_eq!(format_value(&json!("42"), "number"), "42");
        assert_eq!(format_value(&json!("abc"), "number"), "-");
        assert_eq!(format_value(&json!(null), "number"), "-");
    }

    #[test]
    fn format_text_and_count() {
        assert_eq!(format_value(&json!("hi"), "text"), "hi");
        assert_eq!(format_value(&json!(7.0), "text"), "7");
        assert_eq!(format_value(&json!(true), "text"), "true");
        assert_eq!(format_value(&json!(null), "text"), "-");
        assert_eq!(format_value(&json!(["a", 1]), "text"), "a, 1");
        assert_eq!(format_value(&json!("x"), ""), "x", "unknown format reads as text");
        assert_eq!(format_value(&json!([1, 2, 3]), "count"), "3");
        assert_eq!(format_value(&json!({"a": 1}), "count"), "1");
        assert_eq!(format_value(&json!("str"), "count"), "-");
    }

    #[test]
    fn format_durations() {
        assert_eq!(format_value(&json!(52_200), "duration_s"), "14h 30m");
        assert_eq!(format_value(&json!(7800), "duration_s"), "2h 10m");
        assert_eq!(format_value(&json!(2700), "duration_s"), "45m");
        assert_eq!(format_value(&json!(7200), "duration_s"), "2h");
        assert_eq!(format_value(&json!(30), "duration_s"), "30s");
        assert_eq!(format_value(&json!(0), "duration_s"), "0s");
        assert_eq!(format_value(&json!(3_599), "duration_s"), "1h", "rounds to the nearest minute");
        assert_eq!(format_value(&json!(9_000_000), "duration_ms"), "2h 30m");
        assert_eq!(format_value(&json!("PT1H30M"), "duration_iso"), "1h 30m");
        assert_eq!(format_value(&json!("garbage"), "duration_iso"), "-");
        assert_eq!(format_value(&json!(5400), "duration_iso"), "-");
        assert_eq!(format_value(&json!("x"), "duration_s"), "-");
    }

    #[test]
    fn relative_time_buckets() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-22T12:00:00Z").unwrap().timestamp_millis();
        let f = |s: &str| format_value_at(&json!(s), "relative_time", now);
        assert_eq!(f("2026-10-22T11:59:30Z"), "just now");
        assert_eq!(f("2026-10-22T11:15:00Z"), "45m ago");
        assert_eq!(f("2026-10-21T22:00:00Z"), "14h ago");
        assert_eq!(f("2026-10-19T12:00:00Z"), "3d ago");
        assert_eq!(f("2026-10-19"), "3d ago", "date-only reads as midnight UTC");
        assert_eq!(f("2026-10-23T12:00:00Z"), "in 1d");
        assert_eq!(f("2026-04-22T12:00:00Z"), "6mo ago");
        assert_eq!(f("2024-10-22T12:00:00Z"), "2y ago");
        assert_eq!(f("2026-10-22T10:00:00"), "2h ago", "naive timestamps are UTC");
        assert_eq!(f("yesterday"), "-");
        assert_eq!(format_value_at(&json!(now - 5 * 60_000), "relative_time", now), "5m ago", "epoch ms");
        assert_eq!(format_value_at(&json!((now - 2 * 3_600_000) / 1000), "relative_time", now), "2h ago", "epoch s");
    }

    #[test]
    fn stats_display_with_clockify_like_entries() {
        let display = CardDisplay::Stats {
            items: vec![
                StatSpec { label: "This week".into(), path: "sum([].timeInterval.duration)".into(), format: "duration_s".into() },
                StatSpec { label: "Entries".into(), path: "[]".into(), format: "count".into() },
                StatSpec { label: "First".into(), path: "[0].timeInterval.duration".into(), format: "duration_iso".into() },
            ],
        };
        let (stats, rows) = apply_display(&clockify(), &display);
        assert!(rows.is_empty());
        let got: Vec<_> = stats.iter().map(|s| (s.label.as_str(), s.value.as_str())).collect();
        assert_eq!(got, vec![("This week", "14h 30m"), ("Entries", "4"), ("First", "1h 30m")]);
    }

    #[test]
    fn stats_missing_path_is_the_placeholder() {
        let display = CardDisplay::Stats {
            items: vec![StatSpec { label: "x".into(), path: "no.such".into(), format: "number".into() }],
        };
        let (stats, _) = apply_display(&json!({}), &display);
        assert_eq!(stats, vec![LabelValue { label: "x".into(), value: "-".into() }]);
    }

    #[test]
    fn list_display_with_shortcut_like_stories() {
        let display = CardDisplay::List {
            items_path: "data".into(),
            label_path: "name".into(),
            value_path: "workflow_state_id".into(),
            link_path: Some("app_url".into()),
            limit: Some(1),
        };
        let (stats, rows) = apply_display(&shortcut(), &display);
        assert!(stats.is_empty());
        assert_eq!(
            rows,
            vec![RowValue { label: "Fix login".into(), value: "500001".into(), link: Some("https://app.shortcut.com/x/story/1".into()) }]
        );
    }

    #[test]
    fn list_display_over_gh_run_list_root_array() {
        let runs = json!([
            {"name": "CI", "status": "completed", "conclusion": "success"},
            {"name": "Release", "status": "in_progress"},
            {"status": "queued"}
        ]);
        let display = CardDisplay::List {
            items_path: "".into(),
            label_path: "name".into(),
            value_path: "conclusion".into(),
            link_path: None,
            limit: None,
        };
        let (_, rows) = apply_display(&runs, &display);
        let got: Vec<_> = rows.iter().map(|r| (r.label.as_str(), r.value.as_str(), r.link.is_none())).collect();
        assert_eq!(got, vec![("CI", "success", true), ("Release", "-", true), ("-", "-", true)]);
    }

    #[test]
    fn list_default_limit_and_non_array_items() {
        let many = json!({"xs": (0..30).map(|i| json!({"n": i})).collect::<Vec<_>>()});
        let display = CardDisplay::List {
            items_path: "xs".into(),
            label_path: "n".into(),
            value_path: "".into(),
            link_path: Some("".into()),
            limit: None,
        };
        let (_, rows) = apply_display(&many, &display);
        assert_eq!(rows.len(), DEFAULT_LIST_LIMIT);
        assert_eq!(rows[0].value, "");
        let (_, none) = apply_display(&json!({"xs": "not an array"}), &display);
        assert!(none.is_empty());
    }

    #[test]
    fn non_json_text_fallback_shape_is_addressable() {
        let v = json!({"text": "a\nb", "lines": ["a", "b"]});
        let display = CardDisplay::Stats {
            items: vec![StatSpec { label: "n".into(), path: "lines".into(), format: "count".into() }],
        };
        assert_eq!(apply_display(&v, &display).0[0].value, "2");
    }
}
