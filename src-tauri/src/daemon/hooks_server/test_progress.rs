//! `/hooks/test-progress` (pc-1684): a test run reports its counts to the chat's
//! dashboard while it runs. `scripts/test-progress.mjs` is the one caller: it runs
//! vitest or cargo test, parses the output as it streams and POSTs here.
//!
//! This is a loopback route behind the same Host/Origin guard as every route, NOT
//! an MCP tool and with no `TRANSPORT_TABLE` row (absent = desktop pipe only), so
//! a phone or a paired machine cannot POST to it (the `test_progress` frame it
//! publishes is kept off a paired machine's stream by `remote_ws_pump.rs`'s
//! `peer_may_see_preview`). It takes display-only data: every
//! list length and string size is capped, and it is refused for a `session_id` the
//! registry does not know. It RAISES NOTHING: no card, no Waiting-on-you item, no
//! turn mark (`mark_mcp_tool_used` would count it as the chat's own tool call).
//! The numbers live in memory only, one entry per runner, and ride out as one
//! `test_progress` notification that the desktop re-emits as `test-progress`.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

/// Runners kept per chat (vitest, cargo test, a few spares).
const MAX_RUNNERS: usize = 4;
/// Failing test names kept per run; the card says "+N more" for the rest.
const MAX_FAILING: usize = 12;
const MAX_NAME_CHARS: usize = 160;
const MAX_RUNNER_CHARS: usize = 24;
/// Chats with a stored run; the least recently reported one is dropped past this.
const MAX_CHATS: usize = 64;
const MAX_COUNT: u64 = 10_000_000;
const STATES: [&str; 4] = ["running", "passed", "failed", "error"];

#[derive(Deserialize)]
pub(super) struct TestProgressBody {
    session_id: String,
    // Option, not `#[serde(default)]`: the latter covers a missing key only,
    // an explicit `null` would still 4xx.
    #[serde(default)]
    runner: Option<String>,
    #[serde(default)]
    passed: Option<u64>,
    #[serde(default)]
    failed: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    failing: Option<Vec<String>>,
    /// Names the caller already cut (the wrapper keeps twelve), counted on top of the ones cut here.
    #[serde(default)]
    failing_more: Option<u64>,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Run {
    pub runner: String,
    pub passed: u64,
    pub failed: u64,
    /// 0 = the runner has not said how many there are (cargo test prints it per binary).
    pub total: u64,
    pub failing: Vec<String>,
    /// How many failing names were cut by `MAX_FAILING`.
    pub failing_more: u64,
    pub state: String,
    /// When the daemon last heard from the runner, Unix ms.
    pub at_ms: u64,
}

#[derive(Default)]
struct Store {
    runs: HashMap<String, Vec<Run>>,
    /// Chats in the order they last reported, oldest first.
    order: VecDeque<String>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One line of display text: control characters (a newline in a test name) become
/// spaces, the rest is trimmed and cut to `max` characters.
fn clean(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    flat.trim().chars().take(max).collect()
}

/// Validates and caps a report, stores it and returns the chat's runs, newest report last.
/// An unknown or ended chat is refused, and nothing is stored for it.
fn record(ctx: &HookCtx, body: TestProgressBody, at_ms: u64) -> Result<Vec<Run>, String> {
    let sid = body.session_id.trim().to_string();
    match ctx.state.registry.get(&sid) {
        Some(inst) if inst.ended_at.is_none() => {}
        _ => return Err(format!("unknown session: {sid}")),
    }
    let runner = clean(body.runner.as_deref().unwrap_or(""), MAX_RUNNER_CHARS);
    if runner.is_empty() {
        return Err("runner is missing: name the test runner (vitest, cargo test)".to_string());
    }
    let state = body.state.as_deref().map(str::trim).unwrap_or("running").to_string();
    if !STATES.contains(&state.as_str()) {
        return Err(format!("state {state:?} is not one of {}", STATES.join(", ")));
    }
    let names: Vec<String> = body
        .failing
        .unwrap_or_default()
        .iter()
        .map(|n| clean(n, MAX_NAME_CHARS))
        .filter(|n| !n.is_empty())
        .collect();
    let failing_more = (names.len().saturating_sub(MAX_FAILING) as u64)
        .saturating_add(body.failing_more.unwrap_or(0))
        .min(MAX_COUNT);
    let run = Run {
        runner,
        passed: body.passed.unwrap_or(0).min(MAX_COUNT),
        failed: body.failed.unwrap_or(0).min(MAX_COUNT),
        total: body.total.unwrap_or(0).min(MAX_COUNT),
        failing: names.into_iter().take(MAX_FAILING).collect(),
        failing_more,
        state,
        at_ms,
    };
    let mut guard = store().lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.put(&sid, run, MAX_CHATS))
}

impl Store {
    /// Stores `run` for chat `sid` and returns the chat's runs. A runner's newer
    /// report replaces its older one and moves to the end, so the runner that
    /// reported longest ago is the one that falls off past `MAX_RUNNERS`.
    fn put(&mut self, sid: &str, run: Run, max_chats: usize) -> Vec<Run> {
        self.order.retain(|s| s != sid);
        self.order.push_back(sid.to_string());
        while self.order.len() > max_chats {
            if let Some(old) = self.order.pop_front() {
                self.runs.remove(&old);
            }
        }
        let runs = self.runs.entry(sid.to_string()).or_default();
        runs.retain(|r| r.runner != run.runner);
        runs.push(run);
        while runs.len() > MAX_RUNNERS {
            runs.remove(0);
        }
        runs.clone()
    }
}

pub(super) async fn on_test_progress(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<TestProgressBody>,
) -> impl IntoResponse {
    let sid = body.session_id.trim().to_string();
    match record(&ctx, body, now_ms()) {
        Ok(runs) => {
            ctx.state.notifier.publish("test_progress", json!({"session_id": sid, "runs": runs}));
            (StatusCode::OK, Json(json!({"ok": true})))
        }
        Err(e) => rejected_sends::reply("/hooks/test-progress", &sid, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use std::path::Path;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    fn chat(c: &HookCtx, id: &str) {
        c.state.registry.upsert_interactive(id, Path::new("."), "proj", "2026-11-20T08:00:00+00:00");
    }

    fn body(sid: &str, runner: &str, state: &str) -> TestProgressBody {
        TestProgressBody {
            session_id: sid.to_string(),
            runner: Some(runner.to_string()),
            passed: Some(3),
            failed: Some(1),
            total: Some(10),
            failing: Some(vec!["a > b".to_string()]),
            failing_more: None,
            state: Some(state.to_string()),
        }
    }

    async fn call(c: &Arc<HookCtx>, b: TestProgressBody) -> Value {
        let resp = on_test_progress(AxState(c.clone()), ValidatedJson(b)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn an_unknown_session_is_refused_and_nothing_is_stored_or_published() {
        let c = ctx();
        let mut rx = c.state.notifier.subscribe();
        let v = call(&c, body("tp-ghost", "vitest", "running")).await;
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown session"));
        assert!(rx.try_recv().is_err(), "a refused report publishes nothing");
        assert!(!store().lock().unwrap().runs.contains_key("tp-ghost"));
    }

    #[tokio::test]
    async fn an_ended_chat_is_refused() {
        let c = ctx();
        chat(&c, "tp-ended");
        c.state.registry.mark_ended("tp-ended", crate::types::EndReason::Manual, "2026-11-20T09:00:00+00:00");
        let v = call(&c, body("tp-ended", "vitest", "running")).await;
        assert_eq!(v["ok"], false);
    }

    #[tokio::test]
    async fn a_report_is_stored_published_and_raises_nothing() {
        let c = ctx();
        chat(&c, "tp-ok");
        let mut rx = c.state.notifier.subscribe();
        let v = call(&c, body("tp-ok", "vitest", "running")).await;
        assert_eq!(v["ok"], true);
        let frame = rx.try_recv().expect("one notification");
        assert_eq!(frame["method"], "test_progress");
        assert_eq!(frame["params"]["session_id"], "tp-ok");
        assert_eq!(frame["params"]["runs"][0]["passed"], 3);
        assert_eq!(frame["params"]["runs"][0]["failing"][0], "a > b");
        // The only thing published is the progress frame: no card, no prompt, no question.
        assert!(rx.try_recv().is_err());
        assert!(c.state.registry.get("tp-ok").unwrap().awaiting.is_none(), "the chat's status is untouched");
    }

    #[tokio::test]
    async fn lists_names_runners_and_counts_are_capped() {
        let c = ctx();
        chat(&c, "tp-caps");
        let mut b = body("tp-caps", &"x".repeat(200), "failed");
        b.failing = Some((0..40).map(|i| format!("{i}-{}\nline", "n".repeat(500))).collect());
        b.passed = Some(u64::MAX);
        let runs = record(&c, b, 1).unwrap();
        let r = &runs[0];
        assert_eq!(r.runner.chars().count(), MAX_RUNNER_CHARS);
        assert_eq!(r.failing.len(), MAX_FAILING);
        assert_eq!(r.failing_more, 40 - MAX_FAILING as u64);
        assert!(r.failing.iter().all(|n| n.chars().count() <= MAX_NAME_CHARS && !n.contains('\n')));
        assert_eq!(r.passed, MAX_COUNT);
    }

    #[tokio::test]
    async fn names_the_caller_already_cut_are_counted_on_top() {
        let c = ctx();
        chat(&c, "tp-more");
        let mut b = body("tp-more", "vitest", "failed");
        b.failing = Some((0..14).map(|i| format!("t{i}")).collect());
        b.failing_more = Some(30);
        let r = record(&c, b, 1).unwrap().remove(0);
        // Two cut here, thirty cut by the wrapper.
        assert_eq!(r.failing_more, 32);
        let mut huge = body("tp-more", "cargo test", "failed");
        huge.failing_more = Some(u64::MAX);
        assert_eq!(record(&c, huge, 2).unwrap().last().unwrap().failing_more, MAX_COUNT);
    }

    #[tokio::test]
    async fn a_runner_replaces_its_own_run_and_only_four_runners_are_kept() {
        let c = ctx();
        chat(&c, "tp-runners");
        record(&c, body("tp-runners", "vitest", "running"), 1).unwrap();
        let again = record(&c, body("tp-runners", "vitest", "passed"), 2).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].state, "passed");
        for r in ["a", "b", "c", "d"] {
            record(&c, body("tp-runners", r, "running"), 3).unwrap();
        }
        let kept = record(&c, body("tp-runners", "e", "running"), 4).unwrap();
        let names: Vec<&str> = kept.iter().map(|r| r.runner.as_str()).collect();
        assert_eq!(names, ["b", "c", "d", "e"], "the runner that reported longest ago falls off");
    }

    #[tokio::test]
    async fn a_missing_runner_or_a_bad_state_is_refused_naming_the_fix() {
        let c = ctx();
        chat(&c, "tp-bad");
        let mut b = body("tp-bad", "  ", "running");
        assert!(record(&c, std::mem::replace(&mut b, body("tp-bad", "vitest", "melting")), 1).unwrap_err().contains("runner is missing"));
        assert!(record(&c, b, 1).unwrap_err().contains("not one of"));
    }

    #[test]
    fn body_accepts_explicit_nulls() {
        let b: TestProgressBody = serde_json::from_str(
            r#"{"session_id":"s","runner":"vitest","passed":null,"failed":null,"total":null,"failing":null,"state":null}"#,
        )
        .unwrap();
        assert!(b.passed.is_none() && b.failing.is_none() && b.state.is_none());
    }

    #[test]
    fn the_store_keeps_at_most_max_chats() {
        let mut st = Store::default();
        let run = |i: u64| Run { runner: "vitest".into(), passed: i, failed: 0, total: 0, failing: vec![], failing_more: 0, state: "running".into(), at_ms: i };
        for i in 0..8u64 {
            st.put(&format!("c{i}"), run(i), 5);
        }
        assert_eq!(st.runs.len(), 5);
        assert!(!st.runs.contains_key("c0") && st.runs.contains_key("c7"), "the least recently reported chat is dropped");
        st.put("c3", run(9), 5);
        st.put("c8", run(9), 5);
        assert!(st.runs.contains_key("c3"), "a chat that reported again is the newest, not the next to go");
    }
}
