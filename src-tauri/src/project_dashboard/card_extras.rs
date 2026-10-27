//! Reads the optional top-level `_card` object of a card source's JSON: the
//! way a command script (or an API wrapper) hands back values it computed
//! itself, like "3 workdays not logged", instead of the display paths having
//! to derive them from raw rows. Everything here is lenient: a malformed
//! `_card` is dropped field by field, never a card error.

use super::types::{CardProgress, CardResult, CardSegments, SegmentItem};
use serde_json::Value;

const HEADLINE_MAX_CHARS: usize = 120;
const PROGRESS_LABEL_MAX_CHARS: usize = 60;
const SEGMENT_TEXT_MAX_CHARS: usize = 24;
const NOTE_MAX_CHARS: usize = 60;
/// A month of daily slices; a bar with more is a different widget.
const SEGMENTS_MAX_ITEMS: usize = 31;

fn clipped(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

fn headline(card: &Value) -> Option<String> {
    let text = clipped(card.get("headline")?.as_str()?, HEADLINE_MAX_CHARS);
    (!text.is_empty()).then_some(text)
}

fn tone(card: &Value) -> Option<String> {
    let t = card.get("headline_tone")?.as_str()?;
    matches!(t, "warn" | "good").then(|| t.to_string())
}

/// `value` and `max` must be JSON numbers and `max` positive, else there is no
/// bar to draw. `value` is clamped into `0..=max` so a script that overshoots
/// cannot make the bar overflow its track; the overshoot belongs in `label`.
fn progress(card: &Value) -> Option<CardProgress> {
    let p = card.get("progress")?.as_object()?;
    let value = p.get("value")?.as_f64().filter(|v| v.is_finite())?;
    let max = p.get("max")?.as_f64().filter(|m| m.is_finite() && *m > 0.0)?;
    Some(CardProgress {
        value: value.clamp(0.0, max),
        max,
        label: p.get("label").and_then(Value::as_str).map(|l| clipped(l, PROGRESS_LABEL_MAX_CHARS)).unwrap_or_default(),
        behind: p.get("behind").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// One slice per entry that has a text `label` and a finite, non-negative
/// numeric `value`; an entry missing either is skipped, not an error. No bar
/// without a positive `max` or without any usable slice.
fn segments(card: &Value) -> Option<CardSegments> {
    let s = card.get("segments")?.as_object()?;
    let max = s.get("max")?.as_f64().filter(|m| m.is_finite() && *m > 0.0)?;
    let items: Vec<SegmentItem> = s
        .get("items")?
        .as_array()?
        .iter()
        .filter_map(|i| {
            let label = clipped(i.get("label")?.as_str()?, SEGMENT_TEXT_MAX_CHARS);
            let value = i.get("value")?.as_f64().filter(|v| v.is_finite() && *v >= 0.0)?;
            let text = i.get("text").and_then(Value::as_str).map(|t| clipped(t, SEGMENT_TEXT_MAX_CHARS)).unwrap_or_default();
            (!label.is_empty()).then_some(SegmentItem { label, value, text })
        })
        .take(SEGMENTS_MAX_ITEMS)
        .collect();
    if items.is_empty() {
        return None;
    }
    let note = s.get("note").and_then(Value::as_str).map(|n| clipped(n, NOTE_MAX_CHARS)).unwrap_or_default();
    // A tone with no note to colour would be dead data.
    let note_tone = (!note.is_empty())
        .then(|| s.get("note_tone").and_then(Value::as_str).filter(|t| matches!(*t, "warn" | "good")).map(str::to_string))
        .flatten();
    Some(CardSegments {
        items,
        max,
        marker: s.get("marker").and_then(Value::as_f64).filter(|m| m.is_finite() && *m >= 0.0),
        note,
        note_tone,
    })
}

/// Copies whatever valid `_card` fields `json` carries onto `result`.
pub fn apply_card_extras(json: &Value, result: &mut CardResult) {
    let Some(card) = json.get("_card").filter(|c| c.is_object()) else { return };
    result.headline = headline(card);
    // A tone with no headline to colour would be dead data.
    result.headline_tone = result.headline.as_ref().and_then(|_| tone(card));
    result.progress = progress(card);
    result.segments = segments(card);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(v: Value) -> CardResult {
        let mut r = CardResult::default();
        apply_card_extras(&v, &mut r);
        r
    }

    #[test]
    fn a_full_card_object_maps_every_field() {
        let r = run(json!({"_card": {
            "headline": "3 workdays not logged", "headline_tone": "warn",
            "progress": {"value": 12.5, "max": 40, "label": "12.5h of 40h", "behind": true}
        }}));
        assert_eq!(r.headline.as_deref(), Some("3 workdays not logged"));
        assert_eq!(r.headline_tone.as_deref(), Some("warn"));
        assert_eq!(
            r.progress,
            Some(CardProgress { value: 12.5, max: 40.0, label: "12.5h of 40h".into(), behind: true })
        );
    }

    #[test]
    fn no_card_object_leaves_the_result_alone() {
        assert_eq!(run(json!({"a": 1})), CardResult::default());
        assert_eq!(run(json!([1, 2])), CardResult::default());
        assert_eq!(run(json!({"_card": "nope"})), CardResult::default());
        assert_eq!(run(json!({"_card": null})), CardResult::default());
    }

    #[test]
    fn junk_fields_are_ignored_one_by_one() {
        let r = run(json!({"_card": {
            "headline": 7, "headline_tone": "loud",
            "progress": {"value": "5", "max": 10}
        }}));
        assert_eq!(r, CardResult::default());
        let r = run(json!({"_card": {"headline": "ok", "headline_tone": "loud", "progress": {"value": 1, "max": 0}}}));
        assert_eq!(r.headline.as_deref(), Some("ok"));
        assert_eq!(r.headline_tone, None, "an unknown tone is dropped, the headline stays");
        assert_eq!(r.progress, None, "a zero max has no bar");
    }

    #[test]
    fn a_tone_without_a_headline_is_dropped() {
        assert_eq!(run(json!({"_card": {"headline_tone": "good"}})).headline_tone, None);
        assert_eq!(run(json!({"_card": {"headline": "   ", "headline_tone": "good"}})).headline_tone, None);
    }

    #[test]
    fn progress_value_is_clamped_and_optional_fields_default() {
        let p = run(json!({"_card": {"progress": {"value": 99, "max": 10}}})).progress.unwrap();
        assert_eq!((p.value, p.max, p.label.as_str(), p.behind), (10.0, 10.0, "", false));
        let p = run(json!({"_card": {"progress": {"value": -4, "max": 10}}})).progress.unwrap();
        assert_eq!(p.value, 0.0);
    }

    #[test]
    fn long_text_is_clipped_and_flattened() {
        let r = run(json!({"_card": {
            "headline": format!("a\nb {}", "x".repeat(300)),
            "progress": {"value": 1, "max": 2, "label": "y".repeat(200)}
        }}));
        let h = r.headline.unwrap();
        assert_eq!(h.chars().count(), HEADLINE_MAX_CHARS);
        assert!(h.starts_with("a b ") && h.ends_with("..."), "{h}");
        assert_eq!(r.progress.unwrap().label.chars().count(), PROGRESS_LABEL_MAX_CHARS);
    }

    #[test]
    fn segments_map_items_marker_and_a_toned_note() {
        let s = run(json!({"_card": {"segments": {
            "items": [{"label": "Mon", "value": 3.75, "text": "3:45"}, {"label": "Tue", "value": 0, "text": "0:00"}],
            "max": 20, "marker": 4.0, "note": "4:15 behind pace", "note_tone": "warn"
        }}}))
        .segments
        .unwrap();
        assert_eq!(s.items, vec![
            SegmentItem { label: "Mon".into(), value: 3.75, text: "3:45".into() },
            SegmentItem { label: "Tue".into(), value: 0.0, text: "0:00".into() },
        ]);
        assert_eq!((s.max, s.marker, s.note.as_str(), s.note_tone.as_deref()), (20.0, Some(4.0), "4:15 behind pace", Some("warn")));
    }

    #[test]
    fn segments_drop_bad_items_and_need_a_max_and_one_usable_slice() {
        let items = json!([
            {"label": "ok", "value": 1}, {"label": "neg", "value": -1}, {"label": "str", "value": "2"},
            {"value": 3}, {"label": "  ", "value": 4}, {"label": "nan-free", "value": 2.5}
        ]);
        let s = run(json!({"_card": {"segments": {"items": items, "max": 10}}})).segments.unwrap();
        assert_eq!(s.items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), vec!["ok", "nan-free"]);
        assert_eq!(run(json!({"_card": {"segments": {"items": [{"label": "a", "value": 1}], "max": 0}}})).segments, None, "no max, no bar");
        assert_eq!(run(json!({"_card": {"segments": {"items": [{"label": "a", "value": 1}]}}})).segments, None);
        assert_eq!(run(json!({"_card": {"segments": {"items": [{"label": "a", "value": -1}], "max": 5}}})).segments, None, "no usable slice");
        assert_eq!(run(json!({"_card": {"segments": "nope"}})).segments, None);
    }

    #[test]
    fn segments_tone_needs_a_note_and_is_limited_to_warn_or_good() {
        let one = |extra: Value| {
            let mut seg = json!({"items": [{"label": "a", "value": 1}], "max": 5});
            seg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            run(json!({"_card": {"segments": seg}})).segments.unwrap()
        };
        assert_eq!(one(json!({"note_tone": "good"})).note_tone, None, "a tone with no note is dropped");
        assert_eq!(one(json!({"note": "n", "note_tone": "loud"})).note_tone, None);
        assert_eq!(one(json!({"note": "n", "note_tone": "good"})).note_tone.as_deref(), Some("good"));
        assert_eq!(one(json!({"marker": -2})).marker, None, "a negative marker is dropped");
    }

    #[test]
    fn segments_are_capped_and_their_text_clipped() {
        let many: Vec<Value> = (0..40).map(|i| json!({"label": format!("d{i}"), "value": 1})).collect();
        let s = run(json!({"_card": {"segments": {"items": many, "max": 100}}})).segments.unwrap();
        assert_eq!(s.items.len(), SEGMENTS_MAX_ITEMS);
        let long = run(json!({"_card": {"segments": {"items": [{"label": "x".repeat(80), "value": 1, "text": "y".repeat(80)}], "max": 5}}}))
            .segments
            .unwrap();
        assert_eq!(long.items[0].label.chars().count(), SEGMENT_TEXT_MAX_CHARS);
        assert_eq!(long.items[0].text.chars().count(), SEGMENT_TEXT_MAX_CHARS);
    }

    #[test]
    fn a_stats_display_with_no_items_renders_nothing_beside_the_card_object() {
        let json = json!({"_card": {"headline": "hi"}});
        let display = crate::project_dashboard::CardDisplay::Stats { items: vec![] };
        let (stats, rows) = crate::project_dashboard::extract::apply_display(&json, &display);
        assert!(stats.is_empty() && rows.is_empty());
    }
}
