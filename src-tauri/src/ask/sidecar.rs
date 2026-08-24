//! Spawns the read-only `claude -p` sidecar that answers one Ask question.
//! Gate order matches `news::summarizer`: drift owns the NotLoggedIn message,
//! so it runs before credentials and billing.

use crate::chat::billing::check_metered_billing;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Hardcoded for v1. Joe picked medium effort explicitly (2026-08-24); the
/// model was never answered, so this takes `news::summarizer`'s precedent of a
/// const rather than inventing a settings surface nobody asked for.
pub const ASK_MODEL: &str = "sonnet";
/// Higher than the summarizer's `low`: "what was i meant to do" means reading a
/// transcript and inferring intent, which low effort visibly degrades.
pub const ASK_EFFORT: &str = "medium";

/// The whole read-only guarantee. `claude` may look at anything through these
/// and cannot Edit, Write, Bash or otherwise act. Never widen this without
/// re-reading Ask's doc comment.
const ALLOWED_TOOLS: &str = "Read Grep Glob WebSearch WebFetch";

/// What came back from one sidecar run.
pub struct AskAnswer {
    pub text: String,
    /// The sidecar's session id, so the next question can `--resume` it.
    pub sidecar_session_id: String,
}

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
question, no offer to help further. Markdown is fine. If you genuinely cannot tell, say so \
instead of guessing.\n\n\
You can read, and only read. Never propose that you will change something yourself; if the answer \
implies work, describe what needs doing and stop.{ctx}\n\nThe question is:\n{question}"
    )
}

/// Runs one question. `resume` continues an existing sidecar thread; `None`
/// starts a fresh one with `new_session_id`.
pub async fn ask(
    question: &str,
    transcript: Option<&Path>,
    cwd: Option<&str>,
    resume: Option<&str>,
    new_session_id: &str,
) -> Result<AskAnswer> {
    let account = crate::accounts::resolve_default_account()
        .map_err(|e| anyhow!("no account configured for Ask: {e}"))?;
    crate::accounts::drift::check(&account).map_err(|e| anyhow!("{e}"))?;
    crate::accounts::credentials::check_now(&account).map_err(|e| anyhow!("{e}"))?;
    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    let effective_env = spawn_env.effective_env(std::env::vars());
    check_metered_billing(&|k| effective_env.get(k).cloned()).map_err(|e| anyhow!("{e}"))?;

    // Run in the app-data dir, never the repo, so a stray CLAUDE.md can't be
    // picked up as instructions for a question that only needed to read.
    let run_dir = crate::settings::paths::ensure_data_dir().context("resolve app-data dir")?;
    let prompt = build_prompt(question, transcript, cwd);

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg(ASK_MODEL)
        .arg("--effort")
        .arg(ASK_EFFORT)
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");
    match resume {
        Some(id) => {
            cmd.arg("--resume").arg(id);
        }
        None => {
            cmd.arg("--session-id").arg(new_session_id);
        }
    }
    cmd.current_dir(&run_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    spawn_env.apply_tokio(&mut cmd);
    hide_console_tokio(&mut cmd);
    cmd.kill_on_drop(true);

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

    let mut full = String::new();
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.context("read claude stdout")? {
        if let Some(chunk) = crate::chat::parser::text_delta(&line) {
            full.push_str(&chunk);
        }
    }

    let status = child.wait().await.context("wait claude")?;
    let stderr_out = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("claude exited {:?}: {}", status.code(), stderr_out.trim()));
    }
    let text = full.trim().to_string();
    if text.is_empty() {
        return Err(anyhow!("Ask produced an empty answer"));
    }
    Ok(AskAnswer {
        text,
        sidecar_session_id: resume.unwrap_or(new_session_id).to_string(),
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

    #[test]
    fn allowed_tools_are_read_only() {
        for t in ALLOWED_TOOLS.split(' ') {
            assert!(
                matches!(t, "Read" | "Grep" | "Glob" | "WebSearch" | "WebFetch"),
                "{t} is not a read-only tool"
            );
        }
        assert!(!ALLOWED_TOOLS.contains("Edit"));
        assert!(!ALLOWED_TOOLS.contains("Write"));
        assert!(!ALLOWED_TOOLS.contains("Bash"));
    }
}
