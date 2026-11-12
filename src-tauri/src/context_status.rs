//! Daemon-owned "context window remaining" - the single source of truth for
//! how full a session's context window is. The frontend chip used to compute
//! this itself (`src/views/sessions/session-statusbar-helpers.ts`), which had a
//! null-model-default bug on early turns and no sticky correction. This module
//! ports the window heuristic EXACTLY, then layers a stateless sticky
//! correction on top, and exposes the result over IPC + the daemon hooks
//! server so every surface reads the same number.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use ts_rs::TS;

// `pub`, not a `pub use` shim: `generate_handler!` needs the `__cmd__*` items
// the command macro emits beside each fn, and those do not travel through a re-export.
pub mod commands;

/// How full a session's context window is, computed from its transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ContextStatus {
    /// Model id from the last usage line that carries one (e.g. "claude-opus-4-8").
    pub model: String,
    /// Effective context window in tokens.
    pub window: u64,
    /// Current occupancy = the LAST usage line's occupancy (latest turn).
    pub occupancy: u64,
    /// window - occupancy, saturating at 0.
    pub remaining: u64,
    /// round(occupancy / window * 100), clamped 0..=100.
    pub pct_used: u8,
    /// 100 - pct_used.
    pub pct_left: u8,
    /// "proven" when the >200K sticky correction fired, else "heuristic".
    pub confidence: String,
}

/// Window heuristic, kept in sync with the frontend's `modelContextWindow`
/// (session-statusbar-helpers.ts):
///   claude-3*opus -> 200K; any other opus or fable -> 1M; sonnet-5/sonnet-4-6
///   -> 1M; everything else -> 200K.
/// Opus/fable use a blocklist (new versions default to 1M without a code
/// change); sonnet uses a narrow allowlist instead, since older sonnet
/// (4.0/4.5/3.x) isn't confirmed 1M by default and the sticky correction
/// below only ever raises the window, never lowers it.
fn model_window(model: &str) -> u64 {
    // /claude-3[^0-9]*opus/i : "claude-3" then non-digits then "opus".
    let lower = model.to_ascii_lowercase();
    if is_claude_3_opus(&lower) {
        return 200_000;
    }
    if lower.contains("opus") || lower.contains("fable") {
        return 1_000_000;
    }
    if lower.contains("sonnet-5") || lower.contains("sonnet-4-6") {
        return 1_000_000;
    }
    200_000
}

/// Rust port of the regex `/claude-3[^0-9]*opus/i` (already lowercased input).
/// Matches "claude-3", then a run of non-digit chars, then "opus".
fn is_claude_3_opus(lower: &str) -> bool {
    let Some(after) = lower.find("claude-3").map(|i| i + "claude-3".len()) else {
        return false;
    };
    let rest = &lower[after..];
    // Scan the non-digit run that follows, then require "opus" at its end-ish.
    // The regex allows "opus" anywhere inside that non-digit run, so search for
    // "opus" within the leading non-digit prefix of `rest`.
    let non_digit_prefix_end = rest
        .char_indices()
        .find(|(_, c)| c.is_ascii_digit())
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    rest[..non_digit_prefix_end].contains("opus")
}

/// Pure scoring with no file IO: given the per-line occupancies (in transcript
/// order) and the resolved model string, produce a ContextStatus. This is the
/// testable heart of the module; `compute_context_status` is just the IO shell
/// that feeds it.
///
/// - current occupancy = the LAST element (latest turn, NOT cumulative).
/// - max occupancy = the MAX across all elements (drives the sticky correction).
/// - window = model heuristic, then `max(window, 1_000_000)` if any single turn
///   ever exceeded 200K (proof the real window is at least 1M).
/// - confidence = "proven" when max occupancy > 200K, else "heuristic".
///
/// Returns None when there are no usage lines at all.
pub fn score_context(occupancies: &[u64], model: &str) -> Option<ContextStatus> {
    let occupancy = *occupancies.last()?;
    let max_occupancy = occupancies.iter().copied().max().unwrap_or(occupancy);
    Some(score_parts(occupancy, max_occupancy, model))
}

/// [`score_context`] from the two numbers it actually needs, so a reader that
/// keeps a running `(last, max)` instead of every occupancy scores identically.
fn score_parts(occupancy: u64, max_occupancy: u64, model: &str) -> ContextStatus {
    let mut window = model_window(model);
    let sticky_fired = max_occupancy > 200_000;
    if sticky_fired {
        // Any single turn over 200K proves the window is at least 1M, regardless
        // of what the model-name heuristic guessed.
        window = window.max(1_000_000);
    }

    let remaining = window.saturating_sub(occupancy);
    let pct_used = if window == 0 {
        0u8
    } else {
        // round(occupancy / window * 100), clamped 0..=100.
        let raw = ((occupancy as f64) / (window as f64) * 100.0).round();
        raw.clamp(0.0, 100.0) as u8
    };
    let pct_left = 100u8.saturating_sub(pct_used);

    let confidence = if sticky_fired { "proven" } else { "heuristic" };

    ContextStatus {
        model: model.to_string(),
        window,
        occupancy,
        remaining,
        pct_used,
        pct_left,
        confidence: confidence.to_string(),
    }
}

/// One usage line's contribution, extracted from a parsed JSONL value.
/// Returns `(occupancy, model)` where occupancy = input + cache_read +
/// cache_creation, and model is the message.model field if present. Returns
/// None for lines that carry no `message.usage.input_tokens` block.
fn usage_from_line(v: &serde_json::Value) -> Option<(u64, Option<String>)> {
    // Same lookup order as walker.rs: prefer message.usage, fall back to usage.
    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    // Only count lines that actually carry input_tokens (a real usage block).
    let input = usage.get("input_tokens").and_then(|n| n.as_u64())?;
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let occupancy = input
        .saturating_add(cache_read)
        .saturating_add(cache_creation);

    // Model lives at message.model (assistant lines) with a top-level fallback.
    let model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .or_else(|| v.get("model"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    Some((occupancy, model))
}

/// Read a transcript JSONL and compute its ContextStatus. Robust to non-JSON
/// and non-usage lines; returns None when the file is missing/unreadable or has
/// no usage lines at all. Never panics.
pub fn compute_context_status(transcript_path: &Path) -> Option<ContextStatus> {
    compute_context_status_visiting(transcript_path, |_| {})
}

/// [`compute_context_status`] that also hands every raw line to `visit`, so a
/// caller needing its own scan of the same transcript gets it from this one
/// streaming pass instead of opening the file again.
pub(crate) fn compute_context_status_visiting(
    transcript_path: &Path,
    mut visit: impl FnMut(&str),
) -> Option<ContextStatus> {
    let file = std::fs::File::open(transcript_path).ok()?;
    let mut reader = BufReader::new(file);

    let mut occupancies: Vec<u64> = Vec::new();
    // model = the model from the LAST usage line that has one (avoids the
    // frontend's null-default-on-early-turns bug, where the first assistant
    // line may omit the model).
    let mut model: Option<String> = None;

    // One reused buffer and a substring prefilter instead of a String per line
    // and a serde_json::Value per line. `usage_from_line` can only match a line
    // containing "input_tokens", so skipping the rest unparsed is exact, not an
    // approximation. It matters because a tool-heavy transcript runs to tens of
    // megabytes of tool output, and this recomputes on every turn.
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        visit(&line);
        if !line.contains("input_tokens") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let Some((occ, line_model)) = usage_from_line(&v) else {
            continue;
        };
        occupancies.push(occ);
        if let Some(m) = line_model {
            model = Some(m);
        }
    }

    score_context(&occupancies, model.as_deref().unwrap_or(""))
}

/// A per-turn reader that only looks at the bytes appended to a transcript since
/// its last call. The window heuristic above infers a 1M window from the MAXIMUM
/// occupancy over the whole file, so the cursor keeps that running maximum (and
/// the model) next to the byte offset; resuming from the offset alone would
/// forget a peak that lies behind it and flip the window back to 200K. It is
/// persisted for the same reason: a daemon restart must not lose the peak.
pub(crate) mod tail {
    use super::{score_parts, usage_from_line, ContextStatus};
    use serde::{de::DeserializeOwned, Deserialize, Serialize};
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    /// How much of the file's start is fingerprinted. A transcript is
    /// append-only, so its first bytes never change; if they do, the file was
    /// replaced (a rewrite that grew past the old offset passes the length
    /// check but not this one) and the offset means nothing.
    const HEAD_BYTES: u64 = 256;

    /// Where a reader stopped: a byte offset on a line boundary plus the
    /// fingerprint of the file's head at that time.
    #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
    pub struct TailPos {
        pub offset: u64,
        head_len: u64,
        head_hash: u64,
    }

    /// FNV-1a, written out rather than `DefaultHasher` because the value is
    /// persisted and std documents that hasher's output as unstable across
    /// releases; a changed hash would read as a replaced file.
    fn fnv1a(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
    }

    fn head_hash(file: &mut std::fs::File, head_len: u64) -> Option<u64> {
        file.seek(SeekFrom::Start(0)).ok()?;
        let mut buf = vec![0u8; head_len as usize];
        file.read_exact(&mut buf).ok()?;
        Some(fnv1a(&buf))
    }

    /// Streams the complete lines after `from`. A trailing line with no newline
    /// is taken only if it is already valid JSON (a half-written line never is,
    /// since an object is unclosed until its last byte), so what a full read
    /// would see is never skipped for good and a partial line is never half-read.
    pub struct TailReader {
        reader: BufReader<std::fs::File>,
        pos: TailPos,
        bytes: Vec<u8>,
        /// True when `from` did not fit this file (shrunk or replaced) and
        /// reading restarted at byte 0: the caller must drop its running state.
        pub reset: bool,
    }

    impl TailReader {
        pub fn open(path: &Path, from: &TailPos) -> Option<Self> {
            let mut file = std::fs::File::open(path).ok()?;
            let len = file.metadata().ok()?.len();
            let mut pos = from.clone();
            let mut reset = false;
            if pos.offset > 0 {
                let same = pos.offset <= len
                    && pos.head_len <= len
                    && head_hash(&mut file, pos.head_len) == Some(pos.head_hash);
                if !same {
                    pos = TailPos::default();
                    reset = true;
                }
            }
            file.seek(SeekFrom::Start(pos.offset)).ok()?;
            Some(Self { reader: BufReader::new(file), pos, bytes: Vec::new(), reset })
        }

        /// The next line into `buf` (newline kept), with its start and end
        /// offsets; None at the end of what is complete.
        pub fn next_line(&mut self, buf: &mut String) -> Option<(u64, u64)> {
            self.bytes.clear();
            let n = self.reader.read_until(b'\n', &mut self.bytes).ok()?;
            if n == 0 {
                return None;
            }
            let complete = self.bytes.last() == Some(&b'\n');
            if !complete && serde_json::from_slice::<serde::de::IgnoredAny>(&self.bytes).is_err() {
                return None;
            }
            let start = self.pos.offset;
            self.pos.offset += n as u64;
            buf.clear();
            buf.push_str(&String::from_utf8_lossy(&self.bytes));
            Some((start, self.pos.offset))
        }

        /// The position to resume from. `offset` overrides where that is (a
        /// caller that must re-read its last lines passes an earlier boundary).
        pub fn finish(self, offset: Option<u64>) -> TailPos {
            let offset = offset.unwrap_or(self.pos.offset).min(self.pos.offset);
            let want = offset.min(HEAD_BYTES);
            let mut pos = TailPos { offset, ..self.pos };
            if pos.head_len != want {
                let mut file = self.reader.into_inner();
                match head_hash(&mut file, want) {
                    Some(h) => {
                        pos.head_len = want;
                        pos.head_hash = h;
                    }
                    // Unreadable head: restart from 0 next time, never trust a
                    // position that cannot be checked.
                    None => pos = TailPos::default(),
                }
            }
            pos
        }
    }

    /// The running state of a transcript's usage lines, advanced by the tail only.
    #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
    pub struct ContextCursor {
        pos: TailPos,
        /// Occupancy of the LAST usage line, the maximum over every usage line
        /// so far (drives the 1M-window inference) and the last model seen.
        last: Option<u64>,
        max: u64,
        model: Option<String>,
        /// Sticky: true once the caller's line test matched any line.
        #[serde(default)]
        flagged: bool,
        /// Counts every time the chat's context was rewritten under the same
        /// session id: a compaction marker, occupancy at least halving between
        /// two usage rows, or the file shrinking or being replaced (a CLI that
        /// rotates its transcript on `/compact`). It only
        /// ever grows, so a caller can tell "something I sent earlier may no
        /// longer be in the model's context" by this number changing.
        #[serde(default)]
        epoch: u64,
        /// The last usage row that was not zero: the collapse test compares
        /// against it, so a zero row (a synthetic error entry) between a peak
        /// and a compaction does not hide the collapse.
        #[serde(default)]
        last_nonzero: u64,
    }

    /// Occupancy below which a halving is too small to read as a compaction.
    const SHRINK_FLOOR: u64 = 20_000;

    /// A compaction marker. UNVERIFIED against a real compacted transcript (none
    /// exists yet, docs/forever-chat-plan.md 1.2): the plan names the CLI's
    /// `compact_boundary` system event and the summary message's
    /// `isCompactSummary`, so either counts; a count that only has to CHANGE
    /// when a compaction happens does not mind both firing for one.
    fn is_compaction_line(line: &str) -> bool {
        (line.contains("compact_boundary") || line.contains("isCompactSummary"))
            && serde_json::from_str::<serde_json::Value>(line.trim()).is_ok_and(|v| {
                v.get("subtype").and_then(|s| s.as_str()) == Some("compact_boundary")
                    || v.get("isCompactSummary").and_then(|b| b.as_bool()) == Some(true)
            })
    }

    impl ContextCursor {
        /// Folds in the lines appended since the last call. `flag_of` is the
        /// caller's per-line test whose first hit is remembered. False when the
        /// file cannot be opened (the state is left alone).
        pub fn advance(&mut self, path: &Path, mut flag_of: impl FnMut(&str) -> bool) -> bool {
            let Some(mut reader) = TailReader::open(path, &self.pos) else { return false };
            if reader.reset {
                let epoch = self.epoch + 1;
                *self = Self::default();
                self.epoch = epoch;
            }
            let mut line = String::new();
            while reader.next_line(&mut line).is_some() {
                if !self.flagged && flag_of(&line) {
                    self.flagged = true;
                }
                if is_compaction_line(&line) {
                    self.epoch += 1;
                }
                // Same exact prefilter as the full read: only a line holding
                // "input_tokens" can carry a usage block.
                if !line.contains("input_tokens") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
                let Some((occ, model)) = usage_from_line(&v) else { continue };
                // A compaction needs no marker to be noticed: the context
                // collapses between two consecutive usage rows, which normal
                // growth never does. It is seen on the first row written AFTER
                // the compaction, so after a manual `/compact` the epoch moves
                // one prompt late unless the marker test above fires. A zero
                // row (a synthetic error entry) is not a collapse. A false hit
                // costs one extra rider resend.
                if occ > 0 {
                    if self.last_nonzero >= SHRINK_FLOOR && occ < self.last_nonzero / 2 {
                        self.epoch += 1;
                    }
                    self.last_nonzero = occ;
                }
                self.last = Some(occ);
                self.max = self.max.max(occ);
                if model.is_some() {
                    self.model = model;
                }
            }
            self.pos = reader.finish(None);
            true
        }

        pub fn status(&self) -> Option<ContextStatus> {
            Some(score_parts(self.last?, self.max, self.model.as_deref().unwrap_or("")))
        }

        pub fn flagged(&self) -> bool {
            self.flagged
        }

        pub fn epoch(&self) -> u64 {
            self.epoch
        }
    }

    struct Slot<T> {
        loaded: bool,
        value: T,
    }

    /// Per-session cursors held in memory and mirrored to one small file each
    /// under `dir`, so a restarted daemon resumes instead of re-reading (and,
    /// for the skill parser, re-emitting) a whole transcript. Each session has
    /// its own lock, so one chat's first full read does not stall another's turn.
    pub struct CursorStore<T> {
        kind: &'static str,
        slots: Mutex<HashMap<String, Arc<Mutex<Slot<T>>>>>,
    }

    impl<T: Serialize + DeserializeOwned + Default + Clone + PartialEq> CursorStore<T> {
        pub fn new(kind: &'static str) -> Self {
            Self { kind, slots: Mutex::new(HashMap::new()) }
        }

        fn file(&self, dir: &Path, key: &str) -> PathBuf {
            let safe: String =
                key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            dir.join(format!("{safe}.{}.json", self.kind))
        }

        /// Runs `f` on the session's cursor (loaded from `dir` the first time
        /// this process sees it) and saves it back when it changed. `dir: None`
        /// keeps it in memory only.
        pub fn with<R>(&self, dir: Option<&Path>, key: &str, f: impl FnOnce(&mut T) -> R) -> R {
            let slot = {
                let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
                slots.entry(key.to_string()).or_insert_with(|| Arc::new(Mutex::new(Slot { loaded: false, value: T::default() }))).clone()
            };
            let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
            if !slot.loaded {
                slot.loaded = true;
                if let Some(dir) = dir {
                    if let Some(v) = std::fs::read_to_string(self.file(dir, key)).ok().and_then(|s| serde_json::from_str(&s).ok()) {
                        slot.value = v;
                    }
                }
            }
            let before = slot.value.clone();
            let out = f(&mut slot.value);
            if let Some(dir) = dir {
                if slot.value != before {
                    let path = self.file(dir, key);
                    let tmp = path.with_extension("json.tmp");
                    let saved = std::fs::create_dir_all(dir)
                        .and_then(|_| std::fs::write(&tmp, serde_json::to_vec(&slot.value).unwrap_or_default()))
                        .and_then(|_| std::fs::rename(&tmp, &path));
                    if let Err(e) = saved {
                        log::warn!("transcript cursor {key}: save failed: {e}");
                    }
                }
            }
            out
        }

        /// Forgets every in-memory cursor, as a daemon restart does.
        #[cfg(test)]
        pub fn forget_memory(&self) {
            self.slots.lock().unwrap_or_else(|e| e.into_inner()).clear();
        }
    }

    /// Where the cursors are saved, per daemon instance like the other state
    /// files. None under test without `CC_DATA_DIR`, so a test never writes to
    /// the real data folder.
    pub fn cursor_dir() -> Option<PathBuf> {
        #[cfg(test)]
        if !crate::daemon::names_own_data_dir(std::env::var("CC_DATA_DIR").ok().as_deref()) {
            return None;
        }
        crate::settings::paths::data_dir()
            .ok()
            .map(|d| d.join(format!("transcript-cursors{}", crate::daemon::instance::instance_suffix())))
    }
}

/// Resolve the transcript path for a session and compute its ContextStatus.
///
/// Resolution order:
///   1. If the session is in the daemon registry, use its cwd with
///      `transcript_for_session(cwd, session_id)`.
///   2. Otherwise scan `~/.claude/projects/*/<session_id>.jsonl` directly (the
///      session id is a unique UUID, so the filename match is sufficient).
///
/// Returns None if nothing resolves. Never panics.
pub fn context_status_for_session(
    registry: &crate::sessions::registry::Registry,
    session_id: &str,
) -> Option<ContextStatus> {
    if let Some(path) = resolve_transcript(registry, session_id) {
        return compute_context_status(&path);
    }
    None
}

/// Find the transcript file for `session_id`: registry cwd first, then a
/// filename scan of `~/.claude/projects/*/<session_id>.jsonl`.
pub(crate) fn resolve_transcript(
    registry: &crate::sessions::registry::Registry,
    session_id: &str,
) -> Option<PathBuf> {
    use crate::tokens::walker;

    // 1. Registry: an Instance for this session knows its cwd.
    if let Some(inst) = registry.get(session_id) {
        // Prefer an explicit transcript_path if the registry has one.
        if let Some(tp) = inst.transcript_path.as_ref() {
            if tp.exists() {
                return Some(tp.clone());
            }
        }
        if let Some(path) = walker::transcript_for_session(&inst.cwd, session_id) {
            return Some(path);
        }
    }

    // 2. Fallback: scan all project dirs for <session_id>.jsonl.
    commands::scan_projects_for_session(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_heuristic_claude_3_opus_is_200k() {
        let s = score_context(&[1_000], "claude-3-opus-20240229").unwrap();
        assert_eq!(s.window, 200_000);
        assert_eq!(s.confidence, "heuristic");
    }

    #[test]
    fn window_heuristic_opus_4_is_1m() {
        let s = score_context(&[1_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "heuristic");
    }

    #[test]
    fn window_heuristic_unknown_non_opus_is_200k() {
        let s = score_context(&[1_000], "claude-sonnet-4-5").unwrap();
        assert_eq!(s.window, 200_000);
        let s2 = score_context(&[1_000], "some-mystery-model").unwrap();
        assert_eq!(s2.window, 200_000);
    }

    #[test]
    fn window_heuristic_fable_5_is_1m() {
        let s = score_context(&[1_000], "claude-fable-5").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "heuristic");
    }

    #[test]
    fn window_heuristic_sonnet_5_and_sonnet_4_6_are_1m() {
        let s = score_context(&[1_000], "claude-sonnet-5").unwrap();
        assert_eq!(s.window, 1_000_000);
        let s2 = score_context(&[1_000], "claude-sonnet-4-6").unwrap();
        assert_eq!(s2.window, 1_000_000);
    }

    #[test]
    fn window_heuristic_older_sonnet_stays_200k() {
        // Sonnet 4.0/4.5's default (non-beta) window isn't confirmed 1M, so
        // only sonnet-5 and sonnet-4-6 are allowlisted.
        let s = score_context(&[1_000], "claude-sonnet-4-0").unwrap();
        assert_eq!(s.window, 200_000);
        let s2 = score_context(&[1_000], "claude-sonnet-4-5").unwrap();
        assert_eq!(s2.window, 200_000);
    }

    #[test]
    fn sticky_correction_forces_1m_even_for_unknown_model() {
        // Unknown model would heuristic to 200K, but a turn over 200K proves
        // the real window is at least 1M, and confidence becomes "proven".
        let s = score_context(&[50_000, 250_000, 120_000], "totally-unknown").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn sticky_correction_does_not_lower_an_already_1m_window() {
        let s = score_context(&[250_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn occupancy_is_latest_line_not_cumulative() {
        // Three usage lines: current = last (300K), max = 300K for sticky.
        let s = score_context(&[100_000, 200_000, 300_000], "unknown").unwrap();
        assert_eq!(s.occupancy, 300_000, "current occupancy is the LAST line");
        // max occupancy (300K > 200K) forces the 1M window via sticky.
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn max_drives_sticky_even_when_last_line_is_small() {
        // Last line is small (under 200K) but an earlier turn peaked over 200K.
        let s = score_context(&[250_000, 30_000], "unknown").unwrap();
        assert_eq!(s.occupancy, 30_000, "current = last line");
        assert_eq!(s.window, 1_000_000, "max turn over 200K still forces 1M");
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn remaining_and_pct_math() {
        // occupancy 250K, window 1M -> pct_used 25, remaining 750K.
        let s = score_context(&[250_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.occupancy, 250_000);
        assert_eq!(s.remaining, 750_000);
        assert_eq!(s.pct_used, 25);
        assert_eq!(s.pct_left, 75);
    }

    #[test]
    fn pct_used_clamps_and_remaining_saturates_when_over_window() {
        // Occupancy beyond the window: pct_used clamps to 100, remaining to 0.
        // Use a 1M window (claude-opus-4-8) with occupancy past it, since any
        // occupancy over 200K forces window to 1M via the sticky rule, so a
        // 200K window can never legitimately be exceeded.
        let s = score_context(&[1_200_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.pct_used, 100);
        assert_eq!(s.pct_left, 0);
        assert_eq!(s.remaining, 0);
    }

    #[test]
    fn empty_occupancies_returns_none() {
        assert!(score_context(&[], "claude-opus-4-8").is_none());
    }

    #[test]
    fn compute_context_status_reads_jsonl_fixture() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sess.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        // user line (no usage) + 2 assistant usage lines + a junk line.
        writeln!(f, r#"{{"type":"user","message":{{"content":"hi"}}}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":10000,"cache_read_input_tokens":40000,"cache_creation_input_tokens":50000}}}}}}"#
        )
        .unwrap();
        writeln!(f, "not json").unwrap();
        // Last usage line: occupancy = 200000 + 40000 + 10000 = 250000.
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":200000,"cache_read_input_tokens":40000,"cache_creation_input_tokens":10000}}}}}}"#
        )
        .unwrap();
        drop(f);

        let s = compute_context_status(&path).unwrap();
        assert_eq!(s.model, "claude-opus-4-8");
        assert_eq!(s.occupancy, 250_000, "current = last usage line");
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.remaining, 750_000);
        assert_eq!(s.pct_used, 25);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn compute_context_status_missing_file_returns_none() {
        assert!(compute_context_status(Path::new("definitely-not-real.jsonl")).is_none());
    }

    #[test]
    fn compute_context_status_no_usage_lines_returns_none() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nousage.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":"hi"}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"summary","summary":"x"}}"#).unwrap();
        drop(f);
        assert!(compute_context_status(&path).is_none());
    }

    #[test]
    fn model_resolved_from_last_usage_line_with_a_model() {
        // First usage line has no model (the early-turn bug case); the second
        // does. We must pick up the later model, not default to empty/null.
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":5000}}}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":6000}}}}}}"#
        )
        .unwrap();
        drop(f);
        let s = compute_context_status(&path).unwrap();
        assert_eq!(s.model, "claude-opus-4-8");
        assert_eq!(s.window, 1_000_000);
    }

    /// A chat mirrored from a paired machine gets its status as the host
    /// daemon's `context_status` JSON answer, so that answer must read back
    /// into the same struct, null included.
    #[test]
    fn a_daemon_context_status_answer_reads_back_unchanged() {
        let s = ContextStatus {
            model: "claude-opus-4-8".into(),
            window: 1_000_000,
            occupancy: 250_000,
            remaining: 750_000,
            pct_used: 25,
            pct_left: 75,
            confidence: "heuristic".into(),
        };
        let wire = serde_json::to_value(Some(&s)).unwrap();
        assert_eq!(serde_json::from_value::<Option<ContextStatus>>(wire).unwrap(), Some(s));
        assert_eq!(serde_json::from_value::<Option<ContextStatus>>(serde_json::Value::Null).unwrap(), None);
    }

    // ---- incremental cursor ----

    use super::tail::{ContextCursor, CursorStore};

    fn usage_line(model: Option<&str>, input: u64) -> String {
        let m = model.map(|m| format!(r#""model":"{m}","#)).unwrap_or_default();
        format!(r#"{{"type":"assistant","message":{{{m}"usage":{{"input_tokens":{input},"cache_read_input_tokens":0}}}}}}"#)
    }

    fn append(path: &Path, line: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(f, "{line}").unwrap();
    }

    #[test]
    fn the_cursor_matches_a_full_read_after_every_append() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"hi"}}"#.to_string(),
            usage_line(None, 5_000),
            "garbage".to_string(),
            usage_line(Some("claude-sonnet-4-5"), 250_000),
            r#"{"type":"user","message":{"content":"more"}}"#.to_string(),
            usage_line(Some("claude-sonnet-4-5"), 30_000),
            usage_line(None, 31_000),
        ];
        let mut cursor = ContextCursor::default();
        assert!(!cursor.advance(&path, |_| false), "no file yet");
        assert_eq!(cursor.status(), compute_context_status(&path));
        for l in &lines {
            append(&path, l);
            assert!(cursor.advance(&path, |_| false));
            assert_eq!(cursor.status(), compute_context_status(&path), "after {l}");
        }
        let s = cursor.status().unwrap();
        assert_eq!((s.occupancy, s.window, s.confidence.as_str()), (31_000, 1_000_000, "proven"));
    }

    #[test]
    fn a_peak_behind_the_offset_still_proves_the_1m_window_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let saved = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let store = CursorStore::<ContextCursor>::new("context-test");
        let status = || {
            store.with(Some(saved.path()), "sess", |c| {
                c.advance(&path, |_| false);
                c.status()
            })
        };
        append(&path, &usage_line(Some("totally-unknown"), 250_000));
        assert_eq!(status().unwrap().window, 1_000_000);
        store.forget_memory(); // the daemon restarts; only the saved file remains
        append(&path, &usage_line(Some("totally-unknown"), 30_000));
        let after = status().unwrap();
        assert_eq!(after.window, 1_000_000, "a cursor that kept only the offset would fall back to 200K");
        assert_eq!(Some(after), compute_context_status(&path));
    }

    #[test]
    fn a_restart_with_nothing_saved_reads_the_whole_file_and_still_gets_the_window_right() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &usage_line(Some("totally-unknown"), 250_000));
        append(&path, &usage_line(Some("totally-unknown"), 30_000));
        let store = CursorStore::<ContextCursor>::new("context-test-unsaved");
        let status = store.with(None, "sess", |c| {
            c.advance(&path, |_| false);
            c.status()
        });
        assert_eq!(status, compute_context_status(&path));
        assert_eq!(status.unwrap().window, 1_000_000);
    }

    #[test]
    fn a_shrunk_or_replaced_file_is_read_from_the_start_and_bumps_the_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut c = ContextCursor::default();
        append(&path, &usage_line(Some("claude-opus-4-8"), 250_000));
        append(&path, &usage_line(Some("claude-opus-4-8"), 260_000));
        c.advance(&path, |_| false);
        assert_eq!(c.epoch(), 0);

        std::fs::write(&path, usage_line(Some("claude-3-opus-1"), 1_000) + "\n").unwrap();
        c.advance(&path, |_| false);
        assert_eq!(c.status(), compute_context_status(&path), "the old peak is gone with the old file");
        assert_eq!(c.status().unwrap().window, 200_000);
        assert_eq!(c.epoch(), 1);

        // Longer than the old offset, so only the head fingerprint can tell.
        let long: Vec<String> = (0..30).map(|i| usage_line(Some("claude-sonnet-4-5"), 100 + i)).collect();
        std::fs::write(&path, long.join("\n") + "\n").unwrap();
        c.advance(&path, |_| false);
        assert_eq!(c.status(), compute_context_status(&path));
        assert_eq!(c.epoch(), 2);
    }

    #[test]
    fn occupancy_collapsing_between_usage_rows_bumps_the_epoch_without_any_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut c = ContextCursor::default();
        for tokens in [30_000, 90_000, 400_000] {
            append(&path, &usage_line(Some("claude-opus-4-8"), tokens));
        }
        c.advance(&path, |_| false);
        assert_eq!(c.epoch(), 0, "growth is not a rewrite");
        append(&path, &usage_line(Some("claude-opus-4-8"), 41_000));
        c.advance(&path, |_| false);
        assert_eq!(c.epoch(), 1, "400K down to 41K is a compaction");
        append(&path, &usage_line(Some("claude-opus-4-8"), 25_000));
        c.advance(&path, |_| false);
        assert_eq!(c.epoch(), 1, "a small fall from 41K is within normal variation");
        append(&path, &usage_line(Some("claude-opus-4-8"), 500_000));
        append(&path, &usage_line(Some("claude-opus-4-8"), 0));
        c.advance(&path, |_| false);
        assert_eq!(c.epoch(), 1, "a zero-usage row is not a collapse");
        append(&path, &usage_line(Some("claude-opus-4-8"), 41_000));
        c.advance(&path, |_| false);
        assert_eq!(c.epoch(), 2, "a collapse after a zero row is still seen against the last real row");
        assert_eq!(c.status(), compute_context_status(&path));
    }

    #[test]
    fn the_flag_stays_set_once_a_line_matched_even_when_later_reads_see_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut c = ContextCursor::default();
        append(&path, "needle");
        c.advance(&path, |l| l.contains("needle"));
        append(&path, "hay");
        c.advance(&path, |l| l.contains("needle"));
        assert!(c.flagged());
    }
}
