//! Cleans a raw speech-to-text dictation transcript via a cheap, one-shot
//! `claude -p` pass (haiku, low effort): strips stutters/false
//! starts/repeated words, never rephrases. Same billing-guarded,
//! subscription-only sidecar shape as `ask::sidecar`;
//! unlike `ask`, this is stateless - no store, no resume.

use crate::chat::billing::check_metered_billing;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Haiku, per Joe's own call (todo: voice dictation cleanup, 2026-10-18) -
/// this runs on every dictation, so cost/latency beats prose quality.
pub const CLEANUP_MODEL: &str = "haiku";
pub const CLEANUP_EFFORT: &str = "low";

/// Instructs the model to remove ONLY mechanical dictation artifacts
/// (stutters, false starts, verbatim-repeated filler) and never touch
/// wording, grammar beyond that, or content - a rephrase would silently
/// change what the user said.
pub fn build_prompt(raw: &str) -> String {
    format!(
        "You are cleaning up a raw speech-to-text dictation transcript before it is shown to the \
person who spoke it. Remove ONLY: repeated words or phrases caused by stuttering, false starts \
that were immediately restarted (e.g. \"I went to the - I went to the store\" becomes \"I went to \
the store\"), and filler repeated verbatim (e.g. \"I don't know, I don't know\" becomes \"I don't \
know\"). Do NOT rephrase, do NOT change word choice, do NOT fix grammar beyond what removing a \
stutter requires, do NOT add or remove any actual information, do NOT change tone, and do NOT add \
punctuation or wording that wasn't spoken. If there is nothing to remove, return the transcript \
completely unchanged. Output ONLY the cleaned transcript - no preamble, no quotes, no \
explanation.\n\nTranscript:\n{raw}"
    )
}

/// Runs one cleanup pass. Empty/whitespace-only input is returned as-is
/// without spawning anything. Errors (no account, metered billing, claude
/// failure) are returned to the caller, which keeps the raw transcript on
/// failure rather than losing or corrupting it.
pub async fn clean_transcript(raw: &str) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }

    let account = crate::accounts::resolve_default_account()
        .map_err(|e| anyhow!("no account configured for dictation cleanup: {e}"))?;
    crate::accounts::refuse_api_credit(&account, "dictation cleanup").map_err(|e| anyhow!("{e}"))?;
    crate::accounts::drift::check(&account).map_err(|e| anyhow!("{e}"))?;
    crate::accounts::credentials::check_now(&account).map_err(|e| anyhow!("{e}"))?;
    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    let effective_env = spawn_env.effective_env(std::env::vars());
    check_metered_billing(&|k| effective_env.get(k).cloned()).map_err(|e| anyhow!("{e}"))?;

    // Run in the app-data dir, never the repo, so a stray CLAUDE.md can't
    // steer a pass that is only supposed to strip stutters.
    let cwd = crate::settings::paths::ensure_data_dir().context("resolve app-data dir")?;
    let prompt = build_prompt(raw);

    let mut cmd = tokio::process::Command::new(crate::util::claude_bin::program());
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg(CLEANUP_MODEL)
        .arg("--effort")
        .arg(CLEANUP_EFFORT)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .current_dir(&cwd)
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

    // No --include-partial-messages: only the terminal `result` line matters,
    // same reasoning as ask::sidecar (reused parser below).
    let mut result = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.context("read claude stdout")? {
        if let Some(r) = crate::ask::sidecar::parse_ask_result_line(&line) {
            result = Some(r);
        }
    }

    let status = child.wait().await.context("wait claude")?;
    let stderr_out = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("claude exited {:?}: {}", status.code(), stderr_out.trim()));
    }
    let result = result
        .ok_or_else(|| anyhow!("dictation cleanup got no result from claude: {}", stderr_out.trim()))?;
    let text = result.text.trim().to_string();
    if result.is_error || text.is_empty() {
        return Err(anyhow!("dictation cleanup produced an empty result: {}", stderr_out.trim()));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_includes_transcript_and_the_output_only_instruction() {
        let p = build_prompt("i went to the the store");
        assert!(p.contains("i went to the the store"));
        assert!(p.contains("Output ONLY the cleaned transcript"));
    }

    #[test]
    fn prompt_forbids_rephrasing_and_content_changes() {
        let p = build_prompt("x");
        assert!(p.contains("Do NOT rephrase"));
        assert!(p.contains("do NOT add or remove any actual information"));
    }

    #[test]
    fn cleanup_model_and_effort_are_cheap() {
        assert_eq!(CLEANUP_MODEL, "haiku");
        assert_eq!(CLEANUP_EFFORT, "low");
    }

    #[tokio::test]
    async fn empty_input_returns_empty_without_spawning() {
        assert_eq!(clean_transcript("   ").await.unwrap(), "");
    }
}
