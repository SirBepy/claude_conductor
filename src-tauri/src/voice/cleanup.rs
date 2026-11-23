//! Rewrites a raw speech-to-text dictation transcript through one lean,
//! one-shot `claude -p` pass (haiku, low effort): punctuation, filler and
//! false starts out, spoken lists as bullets, self-corrections resolved,
//! the speaker's own vocabulary in the prompt. The pure rules (prompt, output
//! contract, skip rule, flags) live in `rewrite`; this file spawns and gates.
//! Same billing-guarded, subscription-only shape as `ask::sidecar`; unlike
//! `ask`, this is stateless - no store, no resume.

use super::rewrite;
use crate::chat::billing::check_metered_billing;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Semaphore;

/// Haiku, per Joe's own call (todo: voice dictation cleanup, 2026-10-18) -
/// this runs on every dictation, so cost/latency beats prose quality.
pub const CLEANUP_MODEL: &str = "haiku";
pub const CLEANUP_EFFORT: &str = "low";

/// A slow call falls back to the raw text instead of holding up Send; the
/// child is killed on drop (`kill_on_drop`) when the timeout fires.
const REWRITE_TIMEOUT: Duration = Duration::from_secs(8);

/// One rewrite at a time across desktop and phone: dictations are serial by
/// nature, and a flood (a paired phone included) must queue, not fan out into
/// parallel billed processes. The system-prompt file is also per-call state.
fn gate() -> &'static Semaphore {
    static GATE: OnceLock<Semaphore> = OnceLock::new();
    GATE.get_or_init(|| Semaphore::new(1))
}

/// Terms and heard->corrected pairs from the sidecar's own files, so the model
/// sees what Whisper was biased toward. Missing or unreadable files are empty,
/// never an error: the rewrite works without any vocabulary.
fn load_vocab(voice_dir: &Path) -> (Vec<String>, Vec<(String, String)>) {
    let read = |name: &str| -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(voice_dir.join(name)).ok()?).ok()
    };
    // The user's own `terms` first, then the daemon-seeded project names, so
    // the prompt's cap never drops a hand-added word for a seeded one.
    let vocab = read("voice-vocab.json");
    let list = |key: &str| -> Vec<String> {
        vocab
            .as_ref()
            .and_then(|v| v.get(key).cloned())
            .and_then(|t| serde_json::from_value::<Vec<String>>(t).ok())
            .unwrap_or_default()
    };
    let mut terms = list("terms");
    terms.extend(list("seeded"));
    let pairs = read("voice-corrections.json")
        .and_then(|v| v.get("pairs").cloned())
        .and_then(|p| p.as_array().cloned())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some((
                        p.get("heard")?.as_str()?.to_string(),
                        p.get("corrected")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    (terms, pairs)
}

/// Runs one rewrite. Empty input is returned as-is and so is a short one with
/// no list or correction cue, both without spawning anything. Errors (no
/// account, metered billing, timeout, claude failure, an unusable reply) are
/// returned to the caller, which keeps the raw transcript on failure rather
/// than losing or corrupting it.
pub async fn clean_transcript(raw: &str) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.chars().count() > rewrite::MAX_INPUT_CHARS {
        return Err(anyhow!("dictation too long to rewrite, keeping the raw text"));
    }
    if rewrite::should_skip(raw) {
        return Ok(raw.to_string());
    }

    let _turn = gate().acquire().await.context("rewrite gate closed")?;
    let started = Instant::now();
    let outcome = tokio::time::timeout(REWRITE_TIMEOUT, run_rewrite(raw)).await;
    // Timing only: the transcript is private and never logged.
    let (label, result) = match outcome {
        Ok(Ok(text)) => ("ok", Ok(text)),
        Ok(Err(e)) => ("error", Err(e)),
        Err(_) => ("timeout", Err(anyhow!("dictation rewrite timed out after {}s", REWRITE_TIMEOUT.as_secs()))),
    };
    log::info!(
        "[voice] rewrite {label} in {} ms (in {} chars)",
        started.elapsed().as_millis(),
        raw.chars().count()
    );
    result
}

async fn run_rewrite(raw: &str) -> Result<String> {
    let account = crate::accounts::resolve_default_account()
        .map_err(|e| anyhow!("no account configured for dictation cleanup: {e}"))?;
    crate::accounts::refuse_non_subscription(&account, "dictation cleanup").map_err(|e| anyhow!("{e}"))?;
    crate::accounts::drift::check(&account).map_err(|e| anyhow!("{e}"))?;
    crate::accounts::credentials::check_now(&account).map_err(|e| anyhow!("{e}"))?;
    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    let effective_env = spawn_env.effective_env(std::env::vars());
    check_metered_billing(&|k| effective_env.get(k).cloned()).map_err(|e| anyhow!("{e}"))?;

    // Run in the app-data dir, never the repo, so a stray CLAUDE.md can't
    // steer a pass that is only supposed to rewrite a transcript.
    let cwd = crate::settings::paths::ensure_data_dir().context("resolve app-data dir")?;
    let voice_dir = crate::daemon::app_data_dir().join("voice");
    std::fs::create_dir_all(&voice_dir).context("create voice dir")?;
    let (terms, pairs) = load_vocab(&voice_dir);
    let system_file = voice_dir.join("rewrite-system.txt");
    let mcp_file = voice_dir.join("rewrite-empty-mcp.json");
    std::fs::write(&system_file, rewrite::build_system_prompt(&terms, &pairs)).context("write system prompt")?;
    std::fs::write(&mcp_file, r#"{"mcpServers":{}}"#).context("write empty mcp config")?;

    let mut cmd = tokio::process::Command::new(crate::util::claude_bin::program());
    cmd.args(rewrite::lean_args(CLEANUP_MODEL, CLEANUP_EFFORT, &system_file, &mcp_file))
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    spawn_env.apply_tokio(&mut cmd);
    hide_console_tokio(&mut cmd);
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().context("spawn claude")?;
    crate::util::process::guard_orphan_tree(&child);
    // The transcript goes over stdin, never argv: a command line is readable
    // by every local process of this user.
    let mut stdin = child.stdin.take().context("claude stdin")?;
    stdin.write_all(raw.as_bytes()).await.context("write transcript to claude")?;
    drop(stdin);
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
    if result.is_error || result.text.trim().is_empty() {
        return Err(anyhow!("dictation cleanup produced an empty result: {}", stderr_out.trim()));
    }
    rewrite::parse_reply(raw, &result.text)
        .ok_or_else(|| anyhow!("dictation rewrite reply broke the output contract, keeping the raw text"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_model_and_effort_are_cheap() {
        assert_eq!(CLEANUP_MODEL, "haiku");
        assert_eq!(CLEANUP_EFFORT, "low");
    }

    #[tokio::test]
    async fn empty_input_returns_empty_without_spawning() {
        assert_eq!(clean_transcript("   ").await.unwrap(), "");
    }

    #[tokio::test]
    async fn short_input_without_a_cue_is_returned_without_spawning() {
        assert_eq!(clean_transcript("  sounds good ").await.unwrap(), "sounds good");
    }

    #[tokio::test]
    async fn over_long_input_is_refused_without_spawning() {
        let long = "word ".repeat(rewrite::MAX_INPUT_CHARS);
        assert!(clean_transcript(&long).await.is_err());
    }

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cc-voice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn load_vocab_reads_terms_and_pairs() {
        let d = scratch_dir("vocab-ok");
        std::fs::write(d.join("voice-vocab.json"), r#"{"terms":["zng","zirtue"],"seeded":["zng-app"]}"#).unwrap();
        std::fs::write(
            d.join("voice-corrections.json"),
            r#"{"pairs":[{"heard":"zing","corrected":"zng"},{"heard":"x"}]}"#,
        )
        .unwrap();
        let (terms, pairs) = load_vocab(&d);
        assert_eq!(terms, vec!["zng", "zirtue", "zng-app"]);
        assert_eq!(pairs, vec![("zing".to_string(), "zng".to_string())]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn load_vocab_tolerates_missing_and_corrupt_files() {
        let d = scratch_dir("vocab-bad");
        assert_eq!(load_vocab(&d), (vec![], vec![]));
        std::fs::write(d.join("voice-vocab.json"), "{not json").unwrap();
        assert_eq!(load_vocab(&d), (vec![], vec![]));
        let _ = std::fs::remove_dir_all(&d);
    }
}
