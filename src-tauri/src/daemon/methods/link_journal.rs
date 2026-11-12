//! `report_link_journal`: the phone hands over its connection journal (what its
//! link to this PC did, and when) so a drop can be read in the daemon log next to
//! the PC's own side of it. Phone transport only (`remote_transport_table.rs`).

use crate::daemon::rpc::{Router, RpcError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Lines kept per call.
const MAX_LINES: usize = 50;
/// Characters kept per line.
const MAX_LINE_CHARS: usize = 300;
/// A device may land one journal per this long; a faster caller is accepted and
/// ignored so a looping page cannot flood the log.
const MIN_INTERVAL: Duration = Duration::from_secs(5);
/// Bound on the per-device clock map. A handful of phones are ever paired; the
/// cap only keeps a pathological id stream from growing it without limit.
const MAX_DEVICES: usize = 64;

/// One cleaned log line, or `None` when nothing is left worth writing.
fn clean_line(raw: &str) -> Option<String> {
    // Every control character and the U+2028/2029 line separators (not
    // `is_control`, but some viewers break lines on them) become a space, so a phone can never start a second log line. The daemon prefixes
    // each line itself with `[phone-link] dev=...`, so a phone line that begins
    // with `[` cannot pose as another module's prefix and needs no filtering.
    let line: String = raw.chars().map(|c| if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') { ' ' } else { c }).take(MAX_LINE_CHARS).collect();
    if line.trim().is_empty() {
        return None;
    }
    Some(line)
}

/// The lines of a `{"lines": [...]}` payload that may be logged.
fn accepted_lines(params: &Value) -> Result<Vec<String>, RpcError> {
    let arr = params
        .get("lines")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::invalid_params("report_link_journal needs {\"lines\": [string, ...]}"))?;
    Ok(arr.iter().filter_map(Value::as_str).filter_map(clean_line).take(MAX_LINES).collect())
}

/// Last accepted call per device.
#[derive(Default)]
struct Intake {
    last: Mutex<HashMap<String, Instant>>,
}

impl Intake {
    /// Records `now` as the device's last accepted call and returns true, unless
    /// the previous one is under `MIN_INTERVAL` old. A refused call does not move
    /// the clock, so a device that keeps calling is still served every 5s.
    fn rate_allows(&self, device: &str, now: Instant) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = last.get(device) {
            if now.saturating_duration_since(*prev) < MIN_INTERVAL {
                return false;
            }
        }
        if last.len() >= MAX_DEVICES && !last.contains_key(device) {
            last.retain(|_, t| now.saturating_duration_since(*t) < MIN_INTERVAL);
            if last.len() >= MAX_DEVICES {
                last.clear();
            }
        }
        last.insert(device.to_string(), now);
        true
    }

    /// The result to send back and the finished log lines to write.
    fn take(
        &self,
        device: Option<&str>,
        params: Option<&Value>,
        now: Instant,
    ) -> Result<(Value, Vec<String>), RpcError> {
        let device = device.ok_or_else(|| RpcError {
            code: -32600,
            message: "report_link_journal needs a paired phone connection".into(),
            data: None,
        })?;
        let lines = accepted_lines(params.unwrap_or(&Value::Null))?;
        if !self.rate_allows(device, now) {
            return Ok((json!({"ok": true, "kept": 0}), Vec::new()));
        }
        let out: Vec<String> = lines.into_iter().map(|l| format!("[phone-link] dev={device} {l}")).collect();
        Ok((json!({"ok": true, "kept": out.len()}), out))
    }
}

static INTAKE: LazyLock<Intake> = LazyLock::new(Intake::default);

pub fn register_link_journal(router: &mut Router) {
    router.register("report_link_journal", move |params, ctx| async move {
        let (result, lines) = INTAKE.take(ctx.device_id.as_deref(), params.as_ref(), Instant::now())?;
        for line in lines {
            log::info!("{line}");
        }
        Ok(result)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(lines: Vec<Value>) -> Value {
        json!({ "lines": lines })
    }

    fn take(i: &Intake, p: &Value, now: Instant) -> (Value, Vec<String>) {
        i.take(Some("dev1"), Some(p), now).expect("accepted")
    }

    #[test]
    fn sixty_lines_in_fifty_kept() {
        let p = params((0..60).map(|n| json!(format!("line {n}"))).collect());
        let (res, out) = take(&Intake::default(), &p, Instant::now());
        assert_eq!(out.len(), 50);
        assert_eq!(res["kept"], json!(50));
        assert_eq!(out[0], "[phone-link] dev=dev1 line 0");
        assert_eq!(out[49], "[phone-link] dev=dev1 line 49");
    }

    #[test]
    fn a_long_line_is_cut_to_300_chars() {
        let p = params(vec![json!("x".repeat(400))]);
        let (_, out) = take(&Intake::default(), &p, Instant::now());
        let body = out[0].strip_prefix("[phone-link] dev=dev1 ").unwrap();
        assert_eq!(body.chars().count(), 300);
    }

    #[test]
    fn the_cut_never_splits_a_multibyte_character() {
        // 299 ASCII then a 3-byte char at index 299, then more.
        let s = format!("{}\u{20ac}tail", "a".repeat(299));
        let p = params(vec![json!(s)]);
        let (_, out) = take(&Intake::default(), &p, Instant::now());
        let body = out[0].strip_prefix("[phone-link] dev=dev1 ").unwrap();
        assert_eq!(body.chars().count(), 300);
        assert!(body.ends_with('\u{20ac}'));
    }

    #[test]
    fn control_characters_become_spaces_so_no_second_log_line_can_be_forged() {
        let p = params(vec![json!("a\nb\r[iroh tunnel] fake\t\u{2028}\u{2029}end")]);
        let (_, out) = take(&Intake::default(), &p, Instant::now());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "[phone-link] dev=dev1 a b [iroh tunnel] fake   end");
        assert!(!out[0].chars().any(char::is_control));
    }

    #[test]
    fn non_strings_and_empty_strings_are_skipped() {
        let p = params(vec![json!(7), json!(null), json!(""), json!({"a": 1}), json!("ok")]);
        let (res, out) = take(&Intake::default(), &p, Instant::now());
        assert_eq!(out, vec!["[phone-link] dev=dev1 ok".to_string()]);
        assert_eq!(res["kept"], json!(1));
    }

    #[test]
    fn a_second_call_inside_five_seconds_keeps_nothing_and_a_later_one_is_accepted() {
        let i = Intake::default();
        let p = params(vec![json!("hello")]);
        let t0 = Instant::now();
        let (_, first) = take(&i, &p, t0);
        assert_eq!(first.len(), 1);
        let (res, second) = take(&i, &p, t0 + Duration::from_secs(4));
        assert!(second.is_empty());
        assert_eq!(res, json!({"ok": true, "kept": 0}));
        let (_, third) = take(&i, &p, t0 + Duration::from_secs(5));
        assert_eq!(third.len(), 1);
    }

    #[test]
    fn the_rate_limit_is_per_device() {
        let i = Intake::default();
        let p = params(vec![json!("hello")]);
        let t0 = Instant::now();
        assert_eq!(i.take(Some("a"), Some(&p), t0).unwrap().1.len(), 1);
        assert_eq!(i.take(Some("b"), Some(&p), t0).unwrap().1.len(), 1);
    }

    #[test]
    fn the_device_map_stays_bounded() {
        let i = Intake::default();
        let p = params(vec![json!("hello")]);
        let t0 = Instant::now();
        for n in 0..(MAX_DEVICES * 3) {
            let _ = i.take(Some(&format!("d{n}")), Some(&p), t0 + Duration::from_secs(10 * n as u64));
        }
        assert!(i.last.lock().unwrap().len() <= MAX_DEVICES);
    }

    #[test]
    fn no_device_id_is_an_error() {
        let p = params(vec![json!("hello")]);
        let err = Intake::default().take(None, Some(&p), Instant::now()).unwrap_err();
        assert_eq!(err.code, -32600);
    }

    #[test]
    fn a_payload_without_a_lines_array_is_an_invalid_params_error() {
        let err = Intake::default().take(Some("d"), Some(&json!({"lines": "x"})), Instant::now()).unwrap_err();
        assert_eq!(err.code, -32602);
        let err = Intake::default().take(Some("d"), None, Instant::now()).unwrap_err();
        assert_eq!(err.code, -32602);
    }
}
