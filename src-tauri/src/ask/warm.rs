//! Warm sidecar processes for the Answers card's threads (Joe, 2026-11-11).
//!
//! A cold `claude -p` per message paid the CLI's start on every reply and showed
//! nothing until the whole answer was done. Here each thread keeps one
//! long-lived `claude -p --input-format stream-json` process: a question is a
//! user message written to its stdin, and text deltas stream out as they come.
//! One spare, already started, waits for the next new thread.
//!
//! Joe's picks: the spare starts the first time a thread opens (not at app
//! start) and is dropped after 30 minutes with no thread use; a thread's process
//! dies after 10 minutes idle; at most 3 thread processes live, the least
//! recently used killed first; past 80k tokens of context a thread moves to a
//! fresh process seeded with its own questions and answers.
//!
//! Every process runs with `sidecar::readonly_args` and passes
//! `sidecar::prepare`'s gates, so it is exactly as read-only as a cold run.

use super::sidecar::{self, AskAnswer, SidecarResult};
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

pub const THREAD_IDLE: Duration = Duration::from_secs(10 * 60);
pub const SPARE_IDLE: Duration = Duration::from_secs(30 * 60);
pub const MAX_THREADS: usize = 3;
pub const RECYCLE_TOKENS: u64 = 80_000;
/// No output this long while a question is out means the process hung.
pub const HANG: Duration = Duration::from_secs(90);
const REAP_EVERY: Duration = Duration::from_secs(30);

/// What the stdout reader hands the turn loop.
enum Out {
    Delta(String),
    /// A new assistant message began: the streamed text restarts, since the
    /// result is the last message's text, not every message's.
    NewMessage,
    /// The context the model just read: input plus both cache counts.
    Context(u64),
    Done(SidecarResult),
}

fn parse_out(line: &str) -> Option<Out> {
    if let Some(d) = crate::chat::parser::text_delta(line) {
        return Some(Out::Delta(d));
    }
    if let Some(r) = sidecar::parse_ask_result_line(line) {
        return Some(Out::Done(r));
    }
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    match v.get("type")?.as_str()? {
        "stream_event" if v.pointer("/event/type").and_then(|t| t.as_str()) == Some("message_start") => {
            Some(Out::NewMessage)
        }
        "assistant" => {
            let u = v.pointer("/message/usage")?;
            let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            Some(Out::Context(n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")))
        }
        _ => None,
    }
}

/// One stream-json user message, newline-terminated.
fn user_line(text: &str) -> String {
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
    });
    format!("{msg}\n")
}

/// Every live warm process's pid, so a daemon shutdown can kill them: a process
/// left running keeps its stdout reader blocked, and on Windows the runtime
/// waits for that reader before the daemon can exit.
static LIVE: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

/// Kills every warm process. Called with the daemon's own shutdown, beside its
/// chat sessions (`daemon::kill_all_sessions`).
pub fn shutdown() {
    let pids = std::mem::take(&mut *LIVE.lock().unwrap_or_else(|p| p.into_inner()));
    for pid in pids {
        crate::util::kill::kill_tree(pid);
    }
}

/// One live `claude` process.
pub(crate) struct WarmProc {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    rx: mpsc::UnboundedReceiver<Out>,
    stderr: Arc<std::sync::Mutex<String>>,
    account_id: String,
    session_id: String,
    context_tokens: u64,
    last_used: Instant,
    hang: Duration,
}

impl WarmProc {
    /// Starts `cmd` (stdout and stderr already piped) with a piped stdin.
    pub(crate) fn start(mut cmd: tokio::process::Command, account_id: String, session_id: String, hang: Duration) -> Result<Self> {
        cmd.stdin(std::process::Stdio::piped());
        let mut child = cmd.spawn().context("spawn claude")?;
        crate::util::process::guard_orphan_tree(&child);
        if let Some(pid) = child.id() {
            LIVE.lock().unwrap_or_else(|p| p.into_inner()).push(pid);
        }
        let stdin = child.stdin.take().context("claude stdin")?;
        let stdout = child.stdout.take().context("claude stdout")?;
        let stderr = Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(se) = child.stderr.take() {
            let buf = stderr.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(se).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let mut b = buf.lock().unwrap_or_else(|p| p.into_inner());
                    b.push_str(&l);
                    b.push('\n');
                    if b.len() > 4_096 {
                        let keep: String = b.chars().rev().take(2_048).collect::<Vec<_>>().into_iter().rev().collect();
                        *b = keep;
                    }
                }
            });
        }
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(o) = parse_out(&line) {
                    if tx.send(o).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self { child, stdin, rx, stderr, account_id, session_id, context_tokens: 0, last_used: Instant::now(), hang })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn usable(&mut self, account_id: &str) -> bool {
        self.account_id == account_id && self.alive()
    }

    fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap_or_else(|p| p.into_inner()).trim().to_string()
    }

    /// Writes one question and reads until its result, calling `on_delta` with
    /// the reply so far. Errs when the process exits or goes `hang` silent.
    async fn turn(&mut self, text: &str, on_delta: &mut (dyn FnMut(&str) + Send)) -> Result<SidecarResult> {
        while self.rx.try_recv().is_ok() {}
        self.stdin.write_all(user_line(text).as_bytes()).await.context("write to claude")?;
        self.stdin.flush().await.context("write to claude")?;
        let mut acc = String::new();
        loop {
            match tokio::time::timeout(self.hang, self.rx.recv()).await {
                Err(_) => return Err(anyhow!("Ask got no output for {}s", self.hang.as_secs())),
                Ok(None) => return Err(anyhow!("Ask's claude exited: {}", self.stderr_tail())),
                Ok(Some(Out::Delta(d))) => {
                    acc.push_str(&d);
                    on_delta(&acc);
                }
                Ok(Some(Out::NewMessage)) => acc.clear(),
                Ok(Some(Out::Context(n))) => self.context_tokens = n,
                Ok(Some(Out::Done(r))) => {
                    self.last_used = Instant::now();
                    if let Some(s) = &r.session_id {
                        self.session_id = s.clone();
                    }
                    return Ok(r);
                }
            }
        }
    }
}

impl Drop for WarmProc {
    fn drop(&mut self) {
        // kill_on_drop ends the child itself; the pid only leaves the shutdown list.
        if let Some(pid) = self.child.id() {
            LIVE.lock().unwrap_or_else(|p| p.into_inner()).retain(|p| *p != pid);
        }
    }
}

/// How a process for a thread starts.
pub(crate) enum Start {
    New(String),
    Resume(String),
}

/// Makes a process; the real one runs `claude`, tests run a fake.
pub(crate) type Spawner = dyn Fn(&Start) -> Result<WarmProc> + Send + Sync;

fn spawn_claude(start: &Start) -> Result<WarmProc> {
    let gate = sidecar::prepare("Ask", None)?;
    let mut args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
    ];
    args.extend(sidecar::readonly_args());
    let id = match start {
        Start::New(id) => {
            args.extend(["--session-id".to_string(), id.clone()]);
            id.clone()
        }
        Start::Resume(id) => {
            args.extend(["--resume".to_string(), id.clone()]);
            id.clone()
        }
    };
    let cmd = gate.command(args);
    WarmProc::start(cmd, gate.account_id, id, HANG)
}

/// One question for a thread, with the prompt for each way its process can be
/// in. The pool picks one once it knows which process answers.
pub struct Turn<'a> {
    pub thread_id: &'a str,
    /// The thread's sidecar session, `None` for a new thread.
    pub resume: Option<&'a str>,
    /// A fresh session's first prompt: instructions, transcript path, question.
    pub first: &'a str,
    /// A session that already holds the thread: new main-chat turns and the question.
    pub follow: &'a str,
    /// A fresh session continuing a thread: `first` plus the thread's own Q&A.
    pub seed: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    First,
    Follow,
    Resume,
    Seed,
}

impl Mode {
    /// What to try after a process failed in this mode: a live process that died
    /// resumes its session, a session that cannot resume is seeded fresh.
    fn after_failure(self) -> Mode {
        match self {
            Mode::Follow => Mode::Resume,
            Mode::Resume | Mode::Seed => Mode::Seed,
            Mode::First => Mode::First,
        }
    }
}

#[derive(Default)]
pub(crate) struct Pool {
    spare: Option<WarmProc>,
    threads: HashMap<String, WarmProc>,
    /// The last time any thread opened or asked; the spare outlives it by `SPARE_IDLE`.
    last_use: Option<Instant>,
}

impl Pool {
    /// Kills the least recently used thread processes past `MAX_THREADS`.
    fn evict(&mut self) {
        while self.threads.len() > MAX_THREADS {
            let Some(oldest) = self.threads.iter().min_by_key(|(_, w)| w.last_used).map(|(k, _)| k.clone()) else { break };
            self.threads.remove(&oldest);
        }
    }

    /// Drops what has idled out or died. Dropping a `WarmProc` kills its child.
    fn reap(&mut self, now: Instant) {
        self.threads.retain(|_, w| now.duration_since(w.last_used) < THREAD_IDLE && w.alive());
        let spare_wanted = self.last_use.is_some_and(|u| now.duration_since(u) < SPARE_IDLE);
        if !spare_wanted || self.spare.as_mut().is_some_and(|w| !w.alive()) {
            self.spare = None;
        }
    }

    fn ensure_spare(&mut self, spawner: &Spawner) -> Result<()> {
        if self.spare.as_mut().is_some_and(|w| w.alive()) {
            return Ok(());
        }
        self.spare = Some(spawner(&Start::New(uuid::Uuid::new_v4().to_string()))?);
        Ok(())
    }
}

/// Answers one question on its thread's process, retrying once on a crash or a
/// hang (a live process resumes its session in a fresh one; a session that will
/// not resume is seeded fresh), then refills the spare.
pub(crate) async fn send_on(
    pool: &Mutex<Pool>,
    spawner: &Spawner,
    account_id: &str,
    t: Turn<'_>,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<AskAnswer> {
    let (mut proc, mut mode) = {
        let mut p = pool.lock().await;
        p.last_use = Some(Instant::now());
        let live = p.threads.remove(t.thread_id).and_then(|mut w| w.usable(account_id).then_some(w));
        match live {
            Some(w) if w.context_tokens > RECYCLE_TOKENS => (None, Mode::Seed),
            Some(w) => (Some(w), Mode::Follow),
            None if t.resume.is_none() => (p.spare.take().and_then(|mut w| w.usable(account_id).then_some(w)), Mode::First),
            None => (None, Mode::Resume),
        }
    };
    let mut last_err = anyhow!("Ask did not run");
    for _ in 0..2 {
        let start = match (mode, t.resume) {
            (Mode::Resume, Some(id)) => Start::Resume(id.to_string()),
            _ => Start::New(uuid::Uuid::new_v4().to_string()),
        };
        let mut w = match proc.take() {
            Some(w) => w,
            None => spawner(&start)?,
        };
        let prompt = match mode {
            Mode::First => t.first,
            Mode::Follow | Mode::Resume => t.follow,
            Mode::Seed => t.seed,
        };
        match w.turn(prompt, on_delta).await {
            Ok(r) => {
                let text = r.text.trim().to_string();
                let session = w.session_id.clone();
                let mut p = pool.lock().await;
                p.threads.insert(t.thread_id.to_string(), w);
                p.evict();
                if let Err(e) = p.ensure_spare(spawner) {
                    log::warn!("ask warm: spare did not start: {e:#}");
                }
                drop(p);
                if r.is_error || text.is_empty() {
                    return Err(anyhow!("Ask produced an empty answer"));
                }
                return Ok(AskAnswer { text, sidecar_session_id: session });
            }
            Err(e) => {
                log::warn!("ask warm: {mode:?} turn failed, retrying: {e:#}");
                on_delta("");
                last_err = e;
                mode = mode.after_failure();
            }
        }
    }
    Err(last_err)
}

/// Opening a thread: its process comes up while Joe types. A thread with a live
/// process is only touched; one with a session resumes it; a new one makes sure
/// the spare is there.
pub(crate) async fn prewarm_on(pool: &Mutex<Pool>, spawner: &Spawner, account_id: &str, thread_id: Option<&str>, resume: Option<&str>) -> Result<()> {
    let mut p = pool.lock().await;
    p.last_use = Some(Instant::now());
    if let Some(id) = thread_id {
        if let Some(w) = p.threads.get_mut(id) {
            if w.usable(account_id) {
                w.last_used = Instant::now();
                return Ok(());
            }
            p.threads.remove(id);
        }
        if let Some(session) = resume {
            let w = spawner(&Start::Resume(session.to_string()))?;
            p.threads.insert(id.to_string(), w);
            p.evict();
            return Ok(());
        }
    }
    p.ensure_spare(spawner)
}

fn pool() -> &'static Mutex<Pool> {
    static POOL: OnceLock<Mutex<Pool>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Pool::default()))
}

fn default_account_id() -> Result<String> {
    crate::accounts::resolve_default_account().map(|a| a.id).map_err(|e| anyhow!("no account configured for Ask: {e}"))
}

fn ensure_reaper() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(REAP_EVERY).await;
            pool().lock().await.reap(Instant::now());
        }
    });
}

/// `send_on` against the daemon's pool and the real `claude`.
pub async fn send(t: Turn<'_>, on_delta: &mut (dyn FnMut(&str) + Send)) -> Result<AskAnswer> {
    ensure_reaper();
    let account = default_account_id()?;
    send_on(pool(), &spawn_claude, &account, t, on_delta).await
}

/// `prewarm_on` against the daemon's pool and the real `claude`.
pub async fn prewarm(thread_id: Option<&str>, resume: Option<&str>) -> Result<()> {
    ensure_reaper();
    let account = default_account_id()?;
    prewarm_on(pool(), &spawn_claude, &account, thread_id, resume).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn stream_lines_become_deltas_restarts_context_and_the_result() {
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#;
        assert!(matches!(parse_out(delta), Some(Out::Delta(d)) if d == "Hi"));
        let start = r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#;
        assert!(matches!(parse_out(start), Some(Out::NewMessage)));
        let asst = r#"{"type":"assistant","message":{"content":[],"usage":{"input_tokens":3,"cache_creation_input_tokens":40,"cache_read_input_tokens":500}}}"#;
        assert!(matches!(parse_out(asst), Some(Out::Context(543))));
        let res = r#"{"type":"result","subtype":"success","is_error":false,"result":"Hi there","session_id":"s1"}"#;
        assert!(matches!(parse_out(res), Some(Out::Done(r)) if r.text == "Hi there"));
        assert!(parse_out(r#"{"type":"system","subtype":"init"}"#).is_none());
    }

    #[test]
    fn a_question_is_one_stream_json_user_line() {
        let l = user_line("why?\nreally");
        assert!(l.ends_with('\n') && l.matches('\n').count() == 1);
        let v: serde_json::Value = serde_json::from_str(l.trim()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "why?\nreally");
    }

    #[test]
    fn a_failed_process_resumes_and_a_failed_resume_is_seeded() {
        assert_eq!(Mode::Follow.after_failure(), Mode::Resume);
        assert_eq!(Mode::Resume.after_failure(), Mode::Seed);
        assert_eq!(Mode::First.after_failure(), Mode::First);
    }

    /// Time to the first visible text, cold (`run_readonly`: nothing shows until
    /// the whole reply) against warm (the first streamed delta), for a new
    /// question and a follow-up. Run by hand:
    /// `cargo test --lib ask::warm::tests::live_first_token -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "live: runs the real claude CLI on the default account, a few small billed turns"]
    async fn live_first_token_cold_vs_warm() {
        let q1 = sidecar::build_prompt("In two sentences: why does a long-lived process answer faster than a fresh one?", None, None);
        let q2 = "His follow-up:\nAnd what does it cost to keep one idle?";

        let t = Instant::now();
        let cold = sidecar::run_readonly("Ask", &q1, None, &uuid::Uuid::new_v4().to_string(), None, true).await.unwrap();
        let cold_new = t.elapsed();
        let t = Instant::now();
        sidecar::run_readonly("Ask", q2, Some(&cold.sidecar_session_id), "unused", None, true).await.unwrap();
        let cold_follow = t.elapsed();

        let acct = default_account_id().unwrap();
        let pool = Mutex::new(Pool::default());
        let first_token = |pool: &'static Mutex<Pool>, turn: Turn<'static>| async move {
            let t = Instant::now();
            let mut first: Option<Duration> = None;
            let acct = default_account_id().unwrap();
            let a = send_on(pool, &spawn_claude, &acct, turn, &mut |s: &str| {
                if first.is_none() && !s.is_empty() {
                    first = Some(t.elapsed());
                }
            })
            .await
            .unwrap();
            (first.unwrap_or_default(), t.elapsed(), a.sidecar_session_id)
        };
        let pool: &'static Mutex<Pool> = Box::leak(Box::new(pool));
        let q1s: &'static str = Box::leak(q1.into_boxed_str());

        // No spare: the process starts inside the send.
        let (unwarmed_first, _, _) = first_token(pool, Turn { thread_id: "live-0", resume: None, first: q1s, follow: q1s, seed: q1s }).await;
        // Opened first (prewarm), then asked a few seconds later, as Joe types.
        pool.lock().await.spare = None;
        prewarm_on(pool, &spawn_claude, &acct, None, None).await.unwrap();
        tokio::time::sleep(Duration::from_secs(6)).await;
        let (warm_first, warm_total, sid) = first_token(pool, Turn { thread_id: "live-1", resume: None, first: q1s, follow: q1s, seed: q1s }).await;
        let sid: &'static str = Box::leak(sid.into_boxed_str());
        let (follow_first, follow_total, _) = first_token(pool, Turn { thread_id: "live-1", resume: Some(sid), first: q1s, follow: q2, seed: q1s }).await;

        eprintln!("cold new question: first text = whole reply = {:.1}s", cold_new.as_secs_f64());
        eprintln!("cold follow-up (--resume): first text = whole reply = {:.1}s", cold_follow.as_secs_f64());
        eprintln!("warm new question, no spare yet: first token {:.1}s", unwarmed_first.as_secs_f64());
        eprintln!("warm new question, prewarmed: first token {:.1}s, whole reply {:.1}s", warm_first.as_secs_f64(), warm_total.as_secs_f64());
        eprintln!("warm follow-up: first token {:.1}s, whole reply {:.1}s", follow_first.as_secs_f64(), follow_total.as_secs_f64());
        // Kill the live processes, or the runtime waits on their readers forever.
        *pool.lock().await = Pool::default();
        assert!(warm_first < cold_new && follow_first < cold_follow);
    }

    // ---- Real processes: a PowerShell stand-in for `claude` -------------------

    /// Answers each stdin line like `claude` in stream-json mode: a message start,
    /// two deltas, an assistant line with usage, then the result. The question
    /// decides the rest: DIE exits, HANG goes quiet, BIG reports a huge context,
    /// and every answer echoes the question so a test sees which prompt was sent.
    /// A session id starting with "gone" exits at once, like a resume of a
    /// session `claude` no longer has.
    #[cfg(windows)]
    const FAKE: &str = r#"
if ($env:FAKE_SID -like 'gone*') { exit 4 }
while ($null -ne ($l = [Console]::In.ReadLine())) {
  $q = ($l | ConvertFrom-Json).message.content[0].text
  if ($q -match 'DIE') { exit 3 }
  if ($q -match 'HANG') { Start-Sleep -Seconds 30; continue }
  $ctx = if ($q -match 'BIG') { 90000 } else { 1200 }
  [Console]::Out.WriteLine('{"type":"stream_event","event":{"type":"message_start","message":{}}}')
  [Console]::Out.WriteLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ans "}}}')
  [Console]::Out.WriteLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"to"}}}')
  [Console]::Out.WriteLine('{"type":"assistant","message":{"content":[],"usage":{"input_tokens":' + $ctx + '}}}')
  $r = @{ type = 'result'; subtype = 'success'; is_error = $false; result = "ans to $q"; session_id = $env:FAKE_SID } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($r)
  [Console]::Out.Flush()
}
"#;

    #[cfg(windows)]
    struct Fake {
        spawned: Arc<AtomicUsize>,
        starts: Arc<std::sync::Mutex<Vec<String>>>,
        hang: Duration,
    }

    #[cfg(windows)]
    impl Fake {
        fn new(hang: Duration) -> Self {
            Self { spawned: Arc::default(), starts: Arc::default(), hang }
        }
        fn spawner(&self) -> Box<Spawner> {
            let spawned = self.spawned.clone();
            let starts = self.starts.clone();
            let hang = self.hang;
            Box::new(move |s: &Start| {
                spawned.fetch_add(1, Ordering::SeqCst);
                let (kind, id) = match s {
                    Start::New(id) => ("new", id.clone()),
                    Start::Resume(id) => ("resume", id.clone()),
                };
                starts.lock().unwrap().push(format!("{kind}:{id}"));
                let mut cmd = tokio::process::Command::new("powershell");
                cmd.args(["-NoProfile", "-NonInteractive", "-Command", FAKE])
                    .env("FAKE_SID", &id)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                WarmProc::start(cmd, "acct".to_string(), id, hang)
            })
        }
    }

    #[cfg(windows)]
    fn turn<'a>(thread: &'a str, resume: Option<&'a str>, first: &'a str, follow: &'a str) -> Turn<'a> {
        Turn { thread_id: thread, resume, first, follow, seed: "SEED" }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_thread_claims_the_spare_streams_and_keeps_its_process_for_follow_ups() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        prewarm_on(&pool, &*sp, "acct", None, None).await.unwrap();
        assert_eq!(fake.spawned.load(Ordering::SeqCst), 1, "opening a thread starts the spare");

        let mut seen = Vec::new();
        let a = send_on(&pool, &*sp, "acct", turn("t1", None, "FIRST", "FOLLOW"), &mut |s: &str| seen.push(s.to_string())).await.unwrap();
        assert_eq!(a.text, "ans to FIRST");
        assert_eq!(seen, vec!["ans ".to_string(), "ans to".to_string()], "partial text streams as it comes");
        // The spare answered, and a new spare took its place.
        assert_eq!(fake.spawned.load(Ordering::SeqCst), 2);

        let sid = a.sidecar_session_id.clone();
        let b = send_on(&pool, &*sp, "acct", turn("t1", Some(&sid), "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        assert_eq!(b.text, "ans to FOLLOW", "a live thread gets only the follow-up");
        assert_eq!(fake.spawned.load(Ordering::SeqCst), 2, "no new process for a follow-up");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_dead_process_is_retried_by_resuming_its_session() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        let a = send_on(&pool, &*sp, "acct", turn("t1", None, "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        let sid = a.sidecar_session_id.clone();
        // DIE kills the live process; the one retry resumes the same session.
        let err = send_on(&pool, &*sp, "acct", turn("t1", Some(&sid), "FIRST", "DIE"), &mut |_: &str| {}).await;
        assert!(err.is_err(), "the resumed process dies on the same question too");
        let starts = fake.starts.lock().unwrap().clone();
        assert_eq!(starts.last(), Some(&format!("resume:{sid}")), "{starts:?}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_session_that_will_not_resume_is_seeded_in_a_fresh_process() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        let a = send_on(&pool, &*sp, "acct", turn("t1", Some("gone-1"), "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        assert_eq!(a.text, "ans to SEED");
        let starts = fake.starts.lock().unwrap().clone();
        assert_eq!(starts[0], "resume:gone-1");
        assert!(starts[1].starts_with("new:"), "{starts:?}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_silent_process_counts_as_hung_and_is_replaced() {
        let fake = Fake::new(Duration::from_millis(1_500));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        let t0 = Instant::now();
        let err = send_on(&pool, &*sp, "acct", turn("t1", None, "HANG", "FOLLOW"), &mut |_: &str| {}).await.unwrap_err();
        assert!(format!("{err:#}").contains("no output"), "{err:#}");
        assert_eq!(fake.spawned.load(Ordering::SeqCst), 2, "one retry in a fresh process");
        assert!(t0.elapsed() < Duration::from_secs(15));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn past_the_context_limit_a_thread_moves_to_a_fresh_seeded_process() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        let a = send_on(&pool, &*sp, "acct", turn("t1", None, "BIG first", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        let before = fake.spawned.load(Ordering::SeqCst);
        let b = send_on(&pool, &*sp, "acct", turn("t1", Some(&a.sidecar_session_id), "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        assert_eq!(b.text, "ans to SEED");
        assert!(fake.spawned.load(Ordering::SeqCst) > before);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn at_most_three_thread_processes_live_and_the_oldest_goes_first() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        for t in ["t1", "t2", "t3", "t4"] {
            send_on(&pool, &*sp, "acct", turn(t, None, "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        }
        let p = pool.lock().await;
        let mut live: Vec<&String> = p.threads.keys().collect();
        live.sort();
        assert_eq!(live, vec!["t2", "t3", "t4"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn idle_threads_and_an_unused_spare_are_reaped() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        send_on(&pool, &*sp, "acct", turn("t1", None, "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        let mut p = pool.lock().await;
        assert!(p.spare.is_some() && p.threads.contains_key("t1"));
        let now = Instant::now();
        p.reap(now + Duration::from_secs(9 * 60));
        assert!(p.threads.contains_key("t1") && p.spare.is_some(), "nothing goes before its time");
        p.reap(now + THREAD_IDLE + Duration::from_secs(1));
        assert!(!p.threads.contains_key("t1"), "a thread idle 10 minutes is killed");
        assert!(p.spare.is_some(), "the spare stays while threads were used in the last 30 minutes");
        p.reap(now + SPARE_IDLE + Duration::from_secs(1));
        assert!(p.spare.is_none(), "30 minutes with no thread use drops the spare");
    }

    /// The daemon's shutdown kills what this list holds (`shutdown`), so every
    /// live process must be on it and leave it when it goes.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_live_process_is_on_the_shutdown_list_until_it_is_dropped() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let w = sp(&Start::New("x".into())).unwrap();
        let pid = w.child.id().unwrap();
        assert!(LIVE.lock().unwrap().contains(&pid));
        drop(w);
        assert!(!LIVE.lock().unwrap().contains(&pid));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn opening_a_known_thread_resumes_its_session_before_joe_asks() {
        let fake = Fake::new(Duration::from_secs(20));
        let sp = fake.spawner();
        let pool = Mutex::new(Pool::default());
        prewarm_on(&pool, &*sp, "acct", Some("t9"), Some("sess-9")).await.unwrap();
        assert_eq!(fake.starts.lock().unwrap().clone(), vec!["resume:sess-9".to_string()]);
        let a = send_on(&pool, &*sp, "acct", turn("t9", Some("sess-9"), "FIRST", "FOLLOW"), &mut |_: &str| {}).await.unwrap();
        assert_eq!(a.text, "ans to FOLLOW");
    }
}
