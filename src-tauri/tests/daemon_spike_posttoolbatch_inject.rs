//! Spike: can a `PostToolBatch` hook inject text into a RUNNING turn, so a
//! message typed mid-turn reaches the model without `cancel_turn` (which
//! aborts the turn and kills every in-flight subagent with it)?
//!
//! Two things have to hold for the nudge queue to be buildable:
//!   1. `hookSpecificOutput.additionalContext` returned from `PostToolBatch`
//!      reaches the model mid-turn, in the daemon's own stream-json spawn
//!      shape (not just in interactive mode).
//!   2. The text can be queued AFTER the turn started and still land, which is
//!      the whole point - the hook fires repeatedly, the queue is filled late.
//!
//! The spike writes the marker only once the first tool call has already
//! resolved, so a pass cannot be explained by the text being present at spawn.
//!
//! Every hook payload is logged to `payloads.log`, which also answers the
//! secondary question: does a payload carry `agent_id` when the hook fires
//! from inside a subagent (the guard that stops a nudge being eaten by an
//! Agent call instead of reaching the main thread).
//!
//! Manual-run only, spends real tokens. Invoke with:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_spike_posttoolbatch_inject -- --ignored --nocapture

#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Text the hook injects. Deliberately not a word the model would produce on
/// its own, so an echo of it in the final message can only have come through
/// `additionalContext`.
const MARKER: &str = "ZEBRAFISH-4417";

/// Reads the hook payload on stdin, appends it to `payloads.log`, and injects
/// `nudge.txt`'s contents (once) if that file exists. Mirrors the real
/// endpoint: empty stdout when there is nothing queued, never an envelope
/// wrapping an empty string.
const HOOK_JS: &str = r#"
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const tag = process.argv[2] || "batch";
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(dir, "payloads.log"), tag + " " + raw.trim() + "\n");
  if (tag !== "batch") { process.exit(0); }
  const nudge = path.join(dir, "nudge.txt");
  let text = "";
  try {
    text = fs.readFileSync(nudge, "utf8").trim();
    fs.unlinkSync(nudge);
  } catch (e) { /* nothing queued: empty stdout is the no-op */ }
  if (text) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: text,
      },
    }));
  }
  process.exit(0);
});
"#;

/// Registers all three hooks the nudge feature relies on, each tagging its own
/// lines in `payloads.log`. Returns the settings path to pass as `--settings`.
fn write_settings(dir: &std::path::Path, hook_js: &std::path::Path) -> std::path::PathBuf {
    let cmd = |tag: &str| format!("node \"{}\" {tag}", hook_js.display());
    let settings = serde_json::json!({
        "hooks": {
            "PostToolBatch": [
                { "hooks": [ { "type": "command", "command": cmd("batch"), "timeout": 15 } ] }
            ],
            "SubagentStart": [
                { "hooks": [ { "type": "command", "command": cmd("start"), "timeout": 15 } ] }
            ],
            "SubagentStop": [
                { "hooks": [ { "type": "command", "command": cmd("stop"), "timeout": 15 } ] }
            ]
        }
    });
    let path = dir.join("settings.json");
    std::fs::write(&path, settings.to_string()).expect("write settings.json");
    path
}

/// Spawns the CLI in the daemon's own stream-json shape, writes `prompt` as one
/// turn, and returns the whole stdout transcript once the process exits.
fn run_turn(dir: &std::path::Path, settings: &std::path::Path, allowed: &str, prompt: &str) -> String {
    let mut child = Command::new("claude")
        .args([
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--settings", &settings.display().to_string(),
            "--allowedTools", allowed,
        ])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn claude");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let drain = thread::spawn(move || {
        let mut transcript = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            eprintln!("[stdout] {line}");
            transcript.push_str(&line);
            transcript.push('\n');
        }
        transcript
    });
    let frame = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
    });
    writeln!(stdin, "{frame}").expect("write turn");
    stdin.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(240);
    while Instant::now() < deadline {
        if child.try_wait().expect("try_wait").is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    let _ = child.wait();
    drain.join().unwrap()
}

#[test]
#[ignore]
fn posttoolbatch_additional_context_reaches_a_running_turn() {
    let dir = std::env::temp_dir().join(format!("cc-nudge-spike-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create spike dir");
    let hook_js = dir.join("hook.js");
    std::fs::write(&hook_js, HOOK_JS).expect("write hook.js");

    let settings_path = write_settings(&dir, &hook_js);

    let mut child = Command::new("claude")
        .args([
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--settings", &settings_path.display().to_string(),
            "--allowedTools", "Bash",
        ])
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn claude");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");

    // Signals the main thread the moment the first tool RESULT lands, so the
    // marker is written strictly after the turn is already under way.
    let (tx, rx) = mpsc::channel::<()>();
    let drain = thread::spawn(move || {
        let mut first_result_signalled = false;
        let mut transcript = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            eprintln!("[stdout] {line}");
            transcript.push_str(&line);
            transcript.push('\n');
            if !first_result_signalled && line.contains("\"type\":\"user\"") && line.contains("tool_result") {
                first_result_signalled = true;
                let _ = tx.send(());
            }
        }
        transcript
    });

    writeln!(
        stdin,
        r#"{{"type":"user","message":{{"role":"user","content":"Do these in order, one tool call at a time. 1) Run the Bash tool: echo one. 2) Run the Bash tool: echo two. 3) Run the Bash tool: echo three. Then your final message must be exactly one line: SAW: <text> where <text> is any text that appeared in your context between those tool calls that did not come from me or from the tool output, or SAW: NONE if there was none."}}}}"#
    )
    .expect("write turn");
    stdin.flush().unwrap();

    // The load-bearing part of the spike: queue the marker only after a tool
    // call has already resolved. If it still lands, late queueing works.
    let queued_late = rx.recv_timeout(Duration::from_secs(90)).is_ok();
    std::fs::write(dir.join("nudge.txt"), MARKER).expect("write nudge.txt");
    eprintln!("[spike] marker queued after first tool result: {queued_late}");

    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        if child.try_wait().expect("try_wait").is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    let _ = child.wait();
    let transcript = drain.join().unwrap();

    let payloads = std::fs::read_to_string(dir.join("payloads.log")).unwrap_or_default();
    let hook_fired = payloads.lines().count();
    let saw_agent_id = payloads.contains("\"agent_id\"");
    let injected = transcript.contains(MARKER);

    eprintln!("---- POSTTOOLBATCH INJECT SPIKE ----");
    eprintln!("hook invocations: {hook_fired}");
    eprintln!("any payload carried agent_id: {saw_agent_id}");
    eprintln!("marker appears in the model's own output: {injected}");
    eprintln!("spike dir (payloads.log kept for inspection): {}", dir.display());
    eprintln!(
        "PASS means: hook fired 2+ times, the marker was written only after the first tool \
         result, and the model echoed it back. Anything else means mid-turn injection is NOT \
         usable and the nudge queue must fall back to the Stop hook alone."
    );

    assert!(hook_fired > 0, "PostToolBatch hook never fired - not registrable this way");
    assert!(queued_late, "never observed a tool result, so the timing claim is untested");
    assert!(
        injected,
        "marker never reached the model: PostToolBatch additionalContext does not inject mid-turn"
    );
}

/// Second half of the same question: the daemon tracks in-flight `Agent` calls
/// so an interrupt can report what it killed, and the nudge drain refuses to
/// fire inside a subagent. Both rest on claims about hook payloads the first
/// spike could not test, because it never dispatched a subagent:
///
///   1. `SubagentStart` and `SubagentStop` actually fire for an `Agent` call in
///      this spawn shape. If not, the killed-subagent report is always empty.
///   2. A hook firing from INSIDE a subagent carries `agent_id`, which is the
///      only thing separating "the main thread is between tool batches" from
///      "a subagent is", and so the only thing stopping a subagent from
///      swallowing a message meant for the main thread.
#[test]
#[ignore]
fn subagent_hooks_fire_and_their_payloads_are_distinguishable() {
    let dir = std::env::temp_dir().join(format!("cc-subagent-spike-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create spike dir");
    let hook_js = dir.join("hook.js");
    std::fs::write(&hook_js, HOOK_JS).expect("write hook.js");
    std::fs::write(dir.join("one.md"), "# one").expect("seed a file to find");
    let settings = write_settings(&dir, &hook_js);

    run_turn(
        &dir,
        &settings,
        "Task,Bash,Glob,Read",
        "Dispatch a single Explore subagent with the Agent tool to count the .md files in this \
         directory. When it reports back, reply with just that count and nothing else.",
    );

    let payloads = std::fs::read_to_string(dir.join("payloads.log")).unwrap_or_default();
    let started = payloads.lines().filter(|l| l.starts_with("start ")).count();
    let stopped = payloads.lines().filter(|l| l.starts_with("stop ")).count();
    // The guard's actual premise: some batch hook fired from inside the
    // subagent, and those lines - and only those - carry an agent_id.
    let batch_lines: Vec<&str> = payloads.lines().filter(|l| l.starts_with("batch ")).collect();
    let batch_with_agent = batch_lines.iter().filter(|l| l.contains("\"agent_id\"")).count();

    eprintln!("---- SUBAGENT HOOK SPIKE ----");
    eprintln!("SubagentStart invocations: {started}");
    eprintln!("SubagentStop invocations: {stopped}");
    eprintln!("PostToolBatch invocations: {} ({batch_with_agent} carried agent_id)", batch_lines.len());
    eprintln!("spike dir (payloads.log kept for inspection): {}", dir.display());
    eprintln!(
        "A zero in EITHER of the first two means the killed-subagent report can never fire and \
         that half should be dropped rather than shipped dark. Zero agent_id-carrying batch \
         lines means the nudge guard is untestable from the payload and needs another signal."
    );

    assert!(started > 0, "SubagentStart never fired: in-flight Agent calls cannot be tracked");
    assert!(stopped > 0, "SubagentStop never fired: every finished subagent would look killed");
}
