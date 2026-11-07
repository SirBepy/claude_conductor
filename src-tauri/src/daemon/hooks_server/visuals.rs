//! Validation of the `visuals` list on `send_message` / `update_message`: tables
//! and charts drawn inside a message card.
//!
//! The daemon stores nothing. The chat reads `visuals` off the tool_use input in
//! the transcript (`src/shared/chat/message-visuals.ts`), so this only checks the
//! shape. It takes loose `serde_json::Value`s on purpose: a typed enum would turn
//! one malformed visual into a body-decode error, and a chat spawned before the
//! field existed must learn the shape from a clean `ok:false` that names the fix.
//!
//! The caps are the ones in `mcp/tool_schemas_coordination.rs::visuals_schema`;
//! the model may not honour a schema, so the route enforces them too. A test in
//! that file reads the consts below (and `MAX_VISUALS` in
//! `src/shared/chat/message-visuals.ts`) and fails when one disagrees with the
//! schema, so change a cap in all of them together.

use serde_json::{Map, Value};

pub(super) const MAX_VISUALS: usize = 3;
const MAX_TITLE: usize = 80;
const MAX_LABEL: usize = 40;
const MAX_CELL: usize = 80;
const MAX_COLUMNS: usize = 8;
const MAX_TABLE_ROWS: usize = 40;
const MAX_BARS: usize = 12;
const MAX_LINE_LABELS: usize = 24;
const MAX_SERIES: usize = 3;
const MAX_SLICES: usize = 6;
const MAX_TIMELINE_ROWS: usize = 10;
const MAX_TIMELINE_BLOCKS: usize = 12;

/// The schema's `type` enum must list exactly these (a messages/mod.rs test pins it).
pub(super) const TYPE_NAMES: [&str; 5] = ["table", "bar", "line", "donut", "timeline"];

/// The type names as error text, built from [`TYPE_NAMES`] so the two cannot drift.
fn types() -> String {
    TYPE_NAMES.join(", ")
}

pub(super) fn validate_visuals(visuals: &[Value]) -> Result<(), String> {
    if visuals.len() > MAX_VISUALS {
        return Err(format!(
            "visuals has {} items, over {MAX_VISUALS}: keep the ones that carry the answer",
            visuals.len()
        ));
    }
    for (i, v) in visuals.iter().enumerate() {
        let at = format!("visuals[{i}]");
        let obj = v.as_object().ok_or_else(|| format!("{at} must be an object with a type: {}", types()))?;
        optional_text(obj, "title", MAX_TITLE, &at)?;
        match obj.get("type").and_then(Value::as_str) {
            Some("table") => table(obj, &at)?,
            Some("bar") => bar(obj, &at)?,
            Some("line") => line(obj, &at)?,
            Some("donut") => donut(obj, &at)?,
            Some("timeline") => timeline(obj, &at)?,
            Some(other) => return Err(format!("{at} type \"{other}\" is not a visual type: use one of {}", types())),
            None => return Err(format!("{at} needs a type: one of {}", types())),
        }
    }
    Ok(())
}

fn optional_text(obj: &Map<String, Value>, key: &str, max: usize, at: &str) -> Result<(), String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(()),
        Some(Value::String(s)) => Err(format!("{at}.{key} is {} chars, over {max}: shorten it", s.chars().count())),
        Some(_) => Err(format!("{at}.{key} must be a string")),
    }
}

fn text(v: &Value, max: usize, what: &str) -> Result<(), String> {
    match v.as_str() {
        Some(s) if !s.trim().is_empty() && s.chars().count() <= max => Ok(()),
        Some(s) if s.trim().is_empty() => Err(format!("{what} must not be empty")),
        Some(s) => Err(format!("{what} is {} chars, over {max}: shorten it", s.chars().count())),
        None => Err(format!("{what} must be a string")),
    }
}

fn array<'a>(obj: &'a Map<String, Value>, key: &str, at: &str) -> Result<&'a Vec<Value>, String> {
    obj.get(key).and_then(Value::as_array).ok_or_else(|| format!("{at}.{key} must be an array"))
}

fn number(v: &Value, what: &str) -> Result<f64, String> {
    v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| format!("{what} must be a finite number, not text"))
}

fn table(obj: &Map<String, Value>, at: &str) -> Result<(), String> {
    let cols = array(obj, "columns", at)?;
    if cols.is_empty() || cols.len() > MAX_COLUMNS {
        return Err(format!("{at}.columns needs 1 to {MAX_COLUMNS} headers, has {}", cols.len()));
    }
    for c in cols {
        text(c, MAX_LABEL, &format!("a {at} column header"))?;
    }
    let rows = array(obj, "rows", at)?;
    if rows.is_empty() || rows.len() > MAX_TABLE_ROWS {
        return Err(format!(
            "{at}.rows needs 1 to {MAX_TABLE_ROWS} rows, has {}: split it or show the top rows",
            rows.len()
        ));
    }
    for (r, row) in rows.iter().enumerate() {
        let cells = row.as_array().ok_or_else(|| format!("{at}.rows[{r}] must be an array of cells"))?;
        if cells.len() != cols.len() {
            return Err(format!("{at}.rows[{r}] has {} cells but there are {} columns", cells.len(), cols.len()));
        }
        for cell in cells {
            match cell {
                Value::Number(_) | Value::Null => {}
                Value::String(s) if s.chars().count() <= MAX_CELL => {}
                Value::String(_) => return Err(format!("a {at} cell is over {MAX_CELL} chars: shorten it")),
                _ => return Err(format!("{at}.rows[{r}] cells must be text or numbers")),
            }
        }
    }
    Ok(())
}

/// `data: [{label, value}]`, shared by bar and donut.
fn labelled_values(obj: &Map<String, Value>, at: &str, min: usize, max: usize, positive: bool) -> Result<(), String> {
    let data = array(obj, "data", at)?;
    if data.len() < min || data.len() > max {
        return Err(format!("{at}.data needs {min} to {max} items, has {}", data.len()));
    }
    for (i, d) in data.iter().enumerate() {
        let o = d.as_object().ok_or_else(|| format!("{at}.data[{i}] must be {{label, value}}"))?;
        text(o.get("label").unwrap_or(&Value::Null), MAX_LABEL, &format!("{at}.data[{i}].label"))?;
        let n = number(o.get("value").unwrap_or(&Value::Null), &format!("{at}.data[{i}].value"))?;
        if n < 0.0 || (positive && n == 0.0) {
            return Err(format!(
                "{at}.data[{i}].value must be {}",
                if positive { "above 0: leave a zero slice out" } else { "0 or more" }
            ));
        }
    }
    Ok(())
}

fn bar(obj: &Map<String, Value>, at: &str) -> Result<(), String> {
    optional_text(obj, "unit", 8, at)?;
    labelled_values(obj, at, 1, MAX_BARS, false)
}

fn donut(obj: &Map<String, Value>, at: &str) -> Result<(), String> {
    labelled_values(obj, at, 2, MAX_SLICES, true)
}

fn line(obj: &Map<String, Value>, at: &str) -> Result<(), String> {
    let labels = array(obj, "labels", at)?;
    if labels.len() < 2 || labels.len() > MAX_LINE_LABELS {
        return Err(format!("{at}.labels needs 2 to {MAX_LINE_LABELS} x-axis labels, has {}", labels.len()));
    }
    for l in labels {
        text(l, MAX_LABEL, &format!("a {at} x-axis label"))?;
    }
    let series = array(obj, "series", at)?;
    if series.is_empty() || series.len() > MAX_SERIES {
        return Err(format!("{at}.series needs 1 to {MAX_SERIES} lines, has {}", series.len()));
    }
    for (i, s) in series.iter().enumerate() {
        let o = s.as_object().ok_or_else(|| format!("{at}.series[{i}] must be {{name, values}}"))?;
        text(o.get("name").unwrap_or(&Value::Null), MAX_LABEL, &format!("{at}.series[{i}].name"))?;
        let values = o.get("values").and_then(Value::as_array).ok_or_else(|| format!("{at}.series[{i}].values must be an array"))?;
        if values.len() != labels.len() {
            return Err(format!(
                "{at}.series[{i}].values has {} numbers but there are {} labels: one value per label",
                values.len(),
                labels.len()
            ));
        }
        for v in values {
            let what = format!("a {at}.series[{i}] value");
            // The renderer fixes the y axis at 0, so a negative point would draw outside the plot.
            if number(v, &what)? < 0.0 {
                return Err(format!("{what} must be 0 or more: a line chart cannot draw below zero, so use a table for negative figures"));
            }
        }
    }
    Ok(())
}

/// "HH:MM", 24-hour, `24:00` allowed as an end. Minutes since midnight.
fn clock(v: &Value) -> Option<u32> {
    let s = v.as_str()?;
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (m < 60 && (h < 24 || (h == 24 && m == 0))).then_some(h * 60 + m)
}

fn timeline(obj: &Map<String, Value>, at: &str) -> Result<(), String> {
    let rows = array(obj, "rows", at)?;
    if rows.is_empty() || rows.len() > MAX_TIMELINE_ROWS {
        return Err(format!("{at}.rows needs 1 to {MAX_TIMELINE_ROWS} rows (one per day or lane), has {}", rows.len()));
    }
    for (r, row) in rows.iter().enumerate() {
        let o = row.as_object().ok_or_else(|| format!("{at}.rows[{r}] must be {{label, blocks}}"))?;
        text(o.get("label").unwrap_or(&Value::Null), MAX_LABEL, &format!("{at}.rows[{r}].label"))?;
        let blocks = o.get("blocks").and_then(Value::as_array).ok_or_else(|| format!("{at}.rows[{r}].blocks must be an array"))?;
        if blocks.is_empty() || blocks.len() > MAX_TIMELINE_BLOCKS {
            return Err(format!("{at}.rows[{r}].blocks needs 1 to {MAX_TIMELINE_BLOCKS} blocks, has {}", blocks.len()));
        }
        for (b, block) in blocks.iter().enumerate() {
            let bo = block.as_object().ok_or_else(|| format!("{at}.rows[{r}].blocks[{b}] must be {{start, end, label}}"))?;
            let here = format!("{at}.rows[{r}].blocks[{b}]");
            let (Some(start), Some(end)) = (bo.get("start").and_then(clock), bo.get("end").and_then(clock)) else {
                return Err(format!("{here} start and end must be 24-hour \"HH:MM\" text like \"09:30\""));
            };
            if end <= start {
                return Err(format!("{here} ends before it starts: end must be later than start"));
            }
            optional_text(bo, "label", MAX_LABEL, &here)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(v: Value) {
        validate_visuals(&[v]).unwrap();
    }
    fn err(v: Value) -> String {
        validate_visuals(&[v]).unwrap_err()
    }

    #[test]
    fn every_type_accepts_its_documented_shape() {
        ok(json!({"type": "table", "title": "T", "columns": ["a", "b"], "rows": [["x", 1], ["y", 2.5]]}));
        ok(json!({"type": "bar", "unit": "s", "data": [{"label": "a", "value": 0}, {"label": "b", "value": 3}]}));
        ok(json!({"type": "line", "labels": ["Mon", "Tue"], "series": [{"name": "n", "values": [1, 2]}]}));
        ok(json!({"type": "donut", "data": [{"label": "a", "value": 1}, {"label": "b", "value": 2}]}));
        ok(json!({"type": "timeline", "rows": [{"label": "Mon", "blocks": [{"start": "09:00", "end": "12:30", "label": "x"}, {"start": "13:00", "end": "24:00"}]}]}));
    }

    #[test]
    fn a_missing_or_unknown_type_names_the_valid_types() {
        assert!(err(json!({"columns": []})).contains("needs a type"));
        assert!(err(json!({"type": "pie"})).contains(&TYPE_NAMES.join(", ")));
        assert!(err(json!({"columns": []})).contains(&TYPE_NAMES.join(", ")));
        assert!(validate_visuals(&[json!("table")]).unwrap_err().contains("must be an object"));
    }

    #[test]
    fn more_than_three_visuals_are_refused() {
        let v = json!({"type": "bar", "data": [{"label": "a", "value": 1}]});
        let err = validate_visuals(&[v.clone(), v.clone(), v.clone(), v]).unwrap_err();
        assert!(err.contains("over 3"), "{err}");
    }

    #[test]
    fn table_rows_must_match_the_columns_and_stay_in_size() {
        assert!(err(json!({"type": "table", "columns": ["a", "b"], "rows": [["x"]]})).contains("1 cells but there are 2 columns"));
        assert!(err(json!({"type": "table", "columns": ["a"], "rows": []})).contains("1 to 40 rows"));
        let rows: Vec<Value> = (0..41).map(|_| json!(["x"])).collect();
        assert!(err(json!({"type": "table", "columns": ["a"], "rows": rows})).contains("has 41"));
        assert!(err(json!({"type": "table", "columns": ["a"], "rows": [[true]]})).contains("text or numbers"));
        assert!(err(json!({"type": "table", "columns": ["a"], "rows": [["x".repeat(81)]]})).contains("over 80"));
    }

    #[test]
    fn chart_values_must_be_numbers_not_text() {
        assert!(err(json!({"type": "bar", "data": [{"label": "a", "value": "3"}]})).contains("finite number"));
        assert!(err(json!({"type": "bar", "data": [{"label": "a", "value": -1}]})).contains("0 or more"));
        assert!(err(json!({"type": "donut", "data": [{"label": "a", "value": 1}]})).contains("2 to 6"));
        assert!(err(json!({"type": "donut", "data": [{"label": "a", "value": 1}, {"label": "b", "value": 0}]})).contains("above 0"));
    }

    #[test]
    fn a_line_needs_one_value_per_label() {
        let e = err(json!({"type": "line", "labels": ["a", "b", "c"], "series": [{"name": "n", "values": [1, 2]}]}));
        assert!(e.contains("one value per label"), "{e}");
        assert!(err(json!({"type": "line", "labels": ["a"], "series": []})).contains("2 to 24"));
    }

    #[test]
    fn a_line_refuses_a_negative_value_because_the_chart_cannot_draw_below_zero() {
        let e = err(json!({"type": "line", "labels": ["a", "b"], "series": [{"name": "n", "values": [-50, 10]}]}));
        assert!(e.contains("0 or more") && e.contains("series[0]") && e.contains("table"), "{e}");
        ok(json!({"type": "line", "labels": ["a", "b"], "series": [{"name": "n", "values": [0, 10.5]}]}));
    }

    #[test]
    fn timeline_times_are_24_hour_text_and_run_forward() {
        let block = |s: &str, e: &str| json!({"type": "timeline", "rows": [{"label": "d", "blocks": [{"start": s, "end": e}]}]});
        assert!(err(block("9:00", "10:00")).contains("HH:MM"));
        assert!(err(block("09:00", "25:00")).contains("HH:MM"));
        assert!(err(block("10:00", "10:00")).contains("ends before it starts"));
        ok(block("00:00", "24:00"));
    }
}
