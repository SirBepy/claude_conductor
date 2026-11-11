//! The read-only `claude -p` sidecar: its gates, its arguments and its prompt.
//! Answers-card threads run it as warm processes (`warm.rs`); a one-shot job
//! (the decisions checkup) runs `run_readonly`. Gate order: drift owns the NotLoggedIn message, so it runs before
//! credentials and billing.

use crate::chat::billing::check_metered_billing;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Hardcoded for v1. Joe picked medium effort explicitly (2026-08-24); the
/// model was never answered, so it is a const rather than a settings surface
/// nobody asked for.
pub const ASK_MODEL: &str = "sonnet";
/// "What was i meant to do" means reading a transcript and inferring intent,
/// which low effort visibly degrades. Low was also no faster (2026-11-10, same
/// question needing the transcript: 27.4s at low, 24.2s and 32.6s at medium):
/// the wait is the transcript searches, not the thinking. Sonnet is already
/// the lightest tier Joe allows.
pub const ASK_EFFORT: &str = "medium";

/// `--allowedTools` only PRE-APPROVES: it is not an exhaustive allowlist, so
/// absence from here does not stop a tool running.
const ALLOWED_TOOLS: &str = "Read Grep Glob";

/// `--tools`: the only built-in tools the run has at all, the same three.
/// Without it the run listed 44 tools, and past Ask runs called PowerShell,
/// which `DENIED_TOOLS` never named and Joe's own permission allowlist approved.
const TOOL_SET: &str = "Read,Grep,Glob";

/// Run as a brand-new, bare chat: `--safe-mode` drops Joe's CLAUDE.md, skills,
/// plugins, hooks and MCP servers (auth and permissions still load), and
/// `--strict-mcp-config` with no `--mcp-config` keeps every MCP server out.
/// Measured 2026-11-10 on a follow-up answerable from the answer itself: 15.0s
/// to the result with all of that loaded (init alone 4.3s: 12 MCP servers, the
/// session hooks, 21k tokens of fresh cache) against 5.2s without it.
const BARE_RUN: [&str; 2] = ["--safe-mode", "--strict-mcp-config"];

/// The actual read-only guarantee. `Task` too: a subagent would not inherit
/// it. `WebSearch`/`WebFetch` are denied, not merely left un-pre-approved:
/// no `--permission-prompt-tool`/`--permission-mode` is set on
/// a sidecar spawn (see `cli_args` below), so an un-pre-approved tool that isn't
/// explicitly denied would still run silently in this non-interactive `-p`
/// session instead of being blocked. Joe decided 2026-10-19 to drop both -
/// 16 Ask sessions since 2026-09-22 made zero WebSearch/WebFetch calls - so
/// there is no reason for the sidecar to ever reach the network, read-only
/// transcript question or not: the transcript it reads can carry text
/// injected by an earlier WebFetch in the main chat, and a WebFetch here
/// would be a silent exfiltration path for it.
const DENIED_TOOLS: &str =
    "Edit Write NotebookEdit Bash BashOutput KillShell PowerShell Task WebSearch WebFetch";

/// What came back from one sidecar run.
#[derive(Debug)]
pub struct AskAnswer {
    pub text: String,
    /// The sidecar's session id, so the next question can `--resume` it.
    pub sidecar_session_id: String,
}

/// The terminal `result` line of a `--output-format stream-json` run.
pub struct SidecarResult {
    pub text: String,
    /// Whichever session id `claude` actually ran under - a `--resume` is free
    /// to continue under a new one, and the follow-up has to resume that.
    pub session_id: Option<String>,
    pub is_error: bool,
}

/// Reads the whole answer off one stdout line, or `None` if the line isn't the
/// `result` line. NOT `chat::parser::text_delta`: that matches only the
/// `stream_event` lines `claude` emits under `--include-partial-messages`,
/// which a one-shot Ask never passes, so reading deltas here silently produced
/// an empty answer after every paid-for run.
pub fn parse_ask_result_line(line: &str) -> Option<SidecarResult> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "result" {
        return None;
    }
    Some(SidecarResult {
        text: v.get("result").and_then(|r| r.as_str()).unwrap_or_default().to_string(),
        session_id: v.get("session_id").and_then(|s| s.as_str()).map(str::to_string),
        is_error: v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
    })
}

/// The em dash line stands in for Joe's global CLAUDE.md rule, which the bare
/// run (`BARE_RUN`) no longer loads.
pub fn build_prompt(question: &str, transcript: Option<&Path>, cwd: Option<&str>) -> String {
    let mut ctx = String::new();
    if let Some(t) = transcript {
        ctx.push_str(&format!(
            "\n\nThe chat being asked about has its full transcript at:\n{}\nRead it when the \
question is about what was said, decided, or left unfinished.",
            t.display()
        ));
    }
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        ctx.push_str(&format!("\n\nThat chat's project is at:\n{c}\nRead files there when the question is about the code."));
    }
    format!(
        "You are answering a quick side question for the developer, ABOUT a Claude Code chat he \
has open. You are not in that chat and cannot act on it.\n\n\
Answer directly and briefly - a few sentences, or short bullets. No preamble, no restating the \
question, no offer to help further. Markdown is fine. Never use the em dash character. If you \
genuinely cannot tell, say so instead of guessing.\n\n\
You can read, and only read. Never propose that you will change something yourself.\
{ctx}\n\nThe question is:\n{question}"
    )
}

/// The full `claude` CLI argv for one Ask run (excluding the binary path
/// itself and stdio/env/cwd, which `Gate::command` sets on the `Command`).
/// Extracted so a test can pin exactly what reaches the process - including
/// that nothing here sets `--permission-prompt-tool`/`--permission-mode`/
/// `--dangerously-skip-permissions`, which would let a tool absent from
/// `ALLOWED_TOOLS` run anyway instead of needing `DENIED_TOOLS`.
///
/// `persist` false adds `--no-session-persistence`: the run leaves no session
/// file, so it never shows in a history list and cannot be resumed. Ask keeps its
/// sessions (a follow-up resumes them); a one-shot job that only returns text,
/// like the decisions checkup, does not.
fn cli_args(prompt: &str, resume: Option<&str>, new_session_id: &str, persist: bool) -> Vec<String> {
    let mut args = vec!["-p".to_string(), prompt.to_string()];
    args.extend(readonly_args());
    match resume {
        Some(id) => {
            args.push("--resume".to_string());
            args.push(id.to_string());
        }
        None => {
            args.push("--session-id".to_string());
            args.push(new_session_id.to_string());
        }
    }
    if !persist {
        args.push("--no-session-persistence".to_string());
    }
    args
}

/// Model, effort, the read-only tool set and the bare run: everything a sidecar
/// run needs whether it takes one prompt (`cli_args`) or stays up for a thread
/// (`warm.rs`).
pub(crate) fn readonly_args() -> Vec<String> {
    let mut args = vec![
        "--model".to_string(),
        ASK_MODEL.to_string(),
        "--effort".to_string(),
        ASK_EFFORT.to_string(),
        "--tools".to_string(),
        TOOL_SET.to_string(),
        "--allowedTools".to_string(),
        ALLOWED_TOOLS.to_string(),
        "--disallowedTools".to_string(),
        DENIED_TOOLS.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
    args.extend(BARE_RUN.iter().map(|a| a.to_string()));
    args
}

/// An account that passed every gate a read-only sidecar run needs: a
/// subscription account (never API credit), no drift, live credentials, no
/// metered-billing env.
pub(crate) struct Gate {
    pub account_id: String,
    spawn_env: crate::accounts::env::SpawnEnv,
    run_dir: std::path::PathBuf,
}

/// Resolves `account_id` (else the default account) and runs the gates.
/// `what` names the caller in errors.
pub(crate) fn prepare(what: &str, account_id: Option<&str>) -> Result<Gate> {
    let account = match account_id {
        Some(id) => {
            let default_id = crate::settings::paths::settings_file()
                .ok()
                .map(|p| crate::settings::load(&p))
                .and_then(|s| s.default_account_id);
            crate::accounts::resolve_account(Some(id), default_id.as_deref())
        }
        None => crate::accounts::resolve_default_account(),
    }
    .map_err(|e| anyhow!("no account configured for {what}: {e}"))?;
    crate::accounts::refuse_api_credit(&account, what).map_err(|e| anyhow!("{e}"))?;
    crate::accounts::drift::check(&account).map_err(|e| anyhow!("{e}"))?;
    crate::accounts::credentials::check_now(&account).map_err(|e| anyhow!("{e}"))?;
    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    let effective_env = spawn_env.effective_env(std::env::vars());
    check_metered_billing(&|k| effective_env.get(k).cloned()).map_err(|e| anyhow!("{e}"))?;
    // Run in the app-data dir, never the repo, so a stray CLAUDE.md can't be
    // picked up as instructions for a question that only needed to read.
    let run_dir = crate::settings::paths::ensure_data_dir().context("resolve app-data dir")?;
    Ok(Gate { account_id: account.id, spawn_env, run_dir })
}

impl Gate {
    /// A `claude` command for this account with `args`, stdout and stderr piped;
    /// the caller sets stdin.
    pub(crate) fn command(&self, args: Vec<String>) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(crate::util::claude_bin::program());
        cmd.args(args);
        cmd.current_dir(&self.run_dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        self.spawn_env.apply_tokio(&mut cmd);
        hide_console_tokio(&mut cmd);
        cmd.kill_on_drop(true);
        cmd
    }
}

/// Runs one read-only sonnet `claude -p` job with a caller-built `prompt` and
/// returns its final text. Everything `ask` guarantees holds for any caller
/// (subscription accounts only, the billing gate, Read/Grep/Glob and nothing
/// that writes or reaches the network). `account_id` pins the account the job
/// bills, else the default one is used; `what` names the caller in errors.
/// `persist` false leaves no session behind (see `cli_args`), which is only
/// right for a caller that never resumes.
pub async fn run_readonly(
    what: &str,
    prompt: &str,
    resume: Option<&str>,
    new_session_id: &str,
    account_id: Option<&str>,
    persist: bool,
) -> Result<AskAnswer> {
    let gate = prepare(what, account_id)?;
    let mut cmd = gate.command(cli_args(prompt, resume, new_session_id, persist));
    cmd.stdin(std::process::Stdio::null());

    let mut child = cmd.spawn().context("spawn claude")?;
    crate::util::process::guard_orphan_tree(&child);
    let stdout = child.stdout.take().context("claude stdout")?;
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        if let Some(mut se) = stderr {
            let _ = se.read_to_string(&mut s).await;
        }
        s
    });

    let mut result: Option<SidecarResult> = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.context("read claude stdout")? {
        if let Some(r) = parse_ask_result_line(&line) {
            result = Some(r);
        }
    }

    let status = child.wait().await.context("wait claude")?;
    let stderr_out = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("claude exited {:?}: {}", status.code(), stderr_out.trim()));
    }
    let result = result
        .ok_or_else(|| anyhow!("{what} got no result from claude: {}", stderr_out.trim()))?;
    let text = result.text.trim().to_string();
    if result.is_error || text.is_empty() {
        return Err(anyhow!("{what} produced an empty answer: {}", stderr_out.trim()));
    }
    Ok(AskAnswer {
        text,
        sidecar_session_id: result
            .session_id
            .unwrap_or_else(|| resume.unwrap_or(new_session_id).to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_carries_transcript_and_cwd_when_known() {
        let p = build_prompt("why", Some(Path::new("/t/x.jsonl")), Some("/proj"));
        assert!(p.contains("/t/x.jsonl"));
        assert!(p.contains("/proj"));
        assert!(p.ends_with("why"));
    }

    #[test]
    fn prompt_asks_for_no_hand_off_line() {
        // The Answers card has nowhere to put a suggested instruction (the Ask
        // panel that turned one into a composer draft is gone), so the prompt
        // must not ask for one, or replies could end in a stray line.
        let p = build_prompt("why", None, None);
        assert!(!p.contains("SUGGESTED"));
    }

    #[test]
    fn prompt_omits_context_sections_when_unknown() {
        let p = build_prompt("why", None, None);
        assert!(!p.contains("transcript at"));
        assert!(!p.contains("project is at"));
    }

    #[test]
    fn prompt_treats_empty_cwd_as_absent() {
        let p = build_prompt("why", None, Some(""));
        assert!(!p.contains("project is at"));
    }

    /// Captured verbatim from `claude -p --output-format stream-json --verbose`
    /// (2.1.278), trimmed to the fields this parser reads.
    const REAL_RESULT_LINE: &str = r#"{"stop_reason":"end_turn","session_id":"348563a5-17c8-4908-b25a-f36c316ee356","total_cost_usd":0.17245,"is_error":false,"num_turns":1,"subtype":"success","result":"PONG","type":"result","duration_ms":3820}"#;

    #[test]
    fn result_line_yields_the_answer_and_the_session_claude_actually_used() {
        let r = parse_ask_result_line(REAL_RESULT_LINE).expect("result line");
        assert_eq!(r.text, "PONG");
        assert_eq!(r.session_id.as_deref(), Some("348563a5-17c8-4908-b25a-f36c316ee356"));
        assert!(!r.is_error);
    }

    #[test]
    fn non_result_lines_are_skipped() {
        // Without --include-partial-messages there are no stream_event deltas at
        // all, so the assistant + init lines are all the loop sees before the
        // result line; none of them may be mistaken for the answer.
        for line in [
            r#"{"type":"system","subtype":"init","session_id":"s"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]},"session_id":"s"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PO"}}}"#,
            "",
            "not json",
        ] {
            assert!(parse_ask_result_line(line).is_none(), "{line}");
        }
    }

    #[test]
    fn an_errored_run_is_not_read_as_an_answer() {
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","session_id":"s"}"#;
        let r = parse_ask_result_line(line).expect("result line");
        assert!(r.is_error);
        assert!(r.text.is_empty());
    }

    #[test]
    fn allowed_tools_are_read_only() {
        for t in ALLOWED_TOOLS.split(' ') {
            assert!(matches!(t, "Read" | "Grep" | "Glob"), "{t} is not a read-only tool");
        }
    }

    /// A run that loads Joe's MCP servers, hooks and plugins took three times as
    /// long to answer, and one with the default tool set ran PowerShell.
    #[test]
    fn built_args_run_bare_with_only_the_read_tools() {
        let args = cli_args("q", None, "sid", true);
        let tools_idx = args.iter().position(|a| a == "--tools").expect("--tools");
        let mut set: Vec<&str> = args[tools_idx + 1].split(',').collect();
        let mut allowed: Vec<&str> = ALLOWED_TOOLS.split(' ').collect();
        set.sort_unstable();
        allowed.sort_unstable();
        assert_eq!(set, allowed);
        for flag in ["--safe-mode", "--strict-mcp-config"] {
            assert!(args.iter().any(|a| a == flag), "{flag} missing: {args:?}");
        }
        // strict with no config means no MCP server at all.
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        let resumed = cli_args("q", Some("old"), "sid", true);
        assert!(resumed.iter().any(|a| a == "--safe-mode"));
    }

    #[test]
    fn every_mutating_tool_is_explicitly_denied() {
        // Absence from ALLOWED_TOOLS is not enough: that flag only pre-approves,
        // so a mutating tool has to be named in the deny list to be refused.
        for t in ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell", "Task"] {
            assert!(DENIED_TOOLS.split(' ').any(|d| d == t), "{t} is not denied");
        }
    }

    #[test]
    fn built_args_deny_web_tools_and_carry_no_permission_bypass() {
        let args = cli_args("q", None, "sid", true);

        let disallowed_idx = args.iter().position(|a| a == "--disallowedTools").unwrap();
        let disallowed = &args[disallowed_idx + 1];
        assert!(disallowed.split(' ').any(|t| t == "WebFetch"), "got: {disallowed}");
        assert!(disallowed.split(' ').any(|t| t == "WebSearch"), "got: {disallowed}");

        let allowed_idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        let allowed = &args[allowed_idx + 1];
        assert!(!allowed.contains("WebFetch"), "got: {allowed}");
        assert!(!allowed.contains("WebSearch"), "got: {allowed}");

        // Confirms this comment's premise is actually true, not just asserted:
        // no flag here would let a denied tool run anyway.
        assert!(!args.iter().any(|a| {
            a == "--permission-prompt-tool" || a == "--permission-mode" || a == "--dangerously-skip-permissions"
        }));
    }

    #[test]
    fn built_args_resume_vs_fresh_session() {
        let fresh = cli_args("q", None, "new-sid", true);
        assert!(fresh.windows(2).any(|w| w == ["--session-id".to_string(), "new-sid".to_string()]));

        let resumed = cli_args("q", Some("old-sid"), "new-sid", true);
        assert!(resumed.windows(2).any(|w| w == ["--resume".to_string(), "old-sid".to_string()]));
    }

    /// Ask resumes its sessions, so they are kept. A checkup never resumes, and
    /// its sessions showed up in the global History as "You are a checkup reader".
    #[test]
    fn only_a_job_that_never_resumes_asks_the_cli_to_keep_no_session() {
        let flag = "--no-session-persistence".to_string();
        assert!(!cli_args("q", None, "sid", true).contains(&flag));
        assert!(!cli_args("q", Some("old"), "sid", true).contains(&flag));
        assert!(cli_args("q", None, "sid", false).contains(&flag));
    }

    #[test]
    fn web_tools_are_denied_not_just_unapproved() {
        // WebSearch/WebFetch must not merely be absent from
        // ALLOWED_TOOLS - they have to be in DENIED_TOOLS, since this spawn
        // sets no --permission-prompt-tool/--permission-mode that would
        // otherwise let an un-pre-approved tool run anyway.
        for t in ["WebSearch", "WebFetch"] {
            assert!(!ALLOWED_TOOLS.split(' ').any(|a| a == t), "{t} must not be pre-approved");
            assert!(DENIED_TOOLS.split(' ').any(|d| d == t), "{t} must be explicitly denied");
        }
    }

    #[test]
    fn no_tool_is_both_allowed_and_denied() {
        for a in ALLOWED_TOOLS.split(' ') {
            assert!(!DENIED_TOOLS.split(' ').any(|d| d == a), "{a} is both allowed and denied");
        }
    }
}
