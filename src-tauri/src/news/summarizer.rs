//! Lazily generates an ADHD-friendly Markdown "what shipped + why it matters"
//! summary of a news article by running a one-shot, billing-guarded `claude -p`
//! over the scraped article text. Subscription-billed (Pro/Max), same pool as
//! chat; refuses to run under any metered-billing env.
//!
//! The generation streams: it spawns claude with `--output-format stream-json
//! --include-partial-messages`, reads stdout line-by-line, and surfaces each
//! text delta via a callback so the UI can live-write the summary as it forms
//! (rather than freezing on a spinner for the whole 15-40s run).

use crate::chat::billing::check_metered_billing;
use crate::settings::paths;
use crate::types::NewsPost;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Model used for news summaries. Hardcoded for v1 (low volume, so prose
/// quality beats haiku's marginal savings).
pub const SUMMARY_MODEL: &str = "sonnet";

/// Reasoning effort. A 2-section news summary needs no deep reasoning, so the
/// lowest effort - which is meaningfully faster + cheaper - is the right call.
pub const SUMMARY_EFFORT: &str = "low";

/// Builds the summarizer prompt: an ADHD-friendly, scannable Markdown summary
/// ("what shipped + why it matters" to a Claude / Claude Code power user).
pub fn build_prompt(title: &str, article_text: &str) -> String {
    format!(
        "Summarize this Anthropic announcement for a power user of Claude and \
Claude Code. Write it ADHD-friendly: short, scannable chunks, never walls of text. \
Use Markdown - a few small bold lead-ins or `###` sub-headings to break it up, \
**bold** for key terms, *italics* for nuance, and bullet lists where they fit. \
Cover what shipped and why it matters to someone using Claude and Claude Code daily. \
Be specific and concrete; skip marketing language and any preamble. Aim for a few \
tight chunks total.\n\nTitle: {title}\n\nArticle: {article_text}"
    )
}


/// Spawns claude in the app-data dir (never the repo, so it can't ingest a stray
/// CLAUDE.md), streams its stdout, invokes `on_delta` for each text chunk as it
/// arrives, and returns the full trimmed summary. Errors if metered billing is
/// detected, claude is missing/non-zero, or the output is empty.
pub async fn generate_summary_streaming<F: FnMut(&str)>(
    title: &str,
    article_text: &str,
    mut on_delta: F,
) -> Result<String> {
    // News summarization uses the default account (registry empty = skip,
    // per docs/multi-account/02-chat-routing.md step 1). No spawn path may
    // fall back to `~/.claude`.
    let account = crate::accounts::resolve_default_account().map_err(|e| {
        log::info!("news summarizer: skipping - {e}");
        anyhow!("no account configured for news summarization: {e}")
    })?;
    // Same drift-then-credentials-then-billing order as daemon::lifecycle's
    // spawn_session: drift owns the NotLoggedIn message, so it must run first.
    crate::accounts::drift::check(&account).map_err(|e| {
        log::info!("news summarizer: skipping - account drift: {e}");
        anyhow!("{e}")
    })?;
    crate::accounts::credentials::check_now(&account).map_err(|e| {
        log::info!("news summarizer: skipping - credentials: {e}");
        anyhow!("{e}")
    })?;
    let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
    let effective_env = spawn_env.effective_env(std::env::vars());
    check_metered_billing(&|k| effective_env.get(k).cloned()).map_err(|e| anyhow!("{e}"))?;

    let cwd = paths::ensure_data_dir().context("resolve app-data dir")?;
    let prompt = build_prompt(title, article_text);

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg(SUMMARY_MODEL)
        .arg("--effort")
        .arg(SUMMARY_EFFORT)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    spawn_env.apply_tokio(&mut cmd);
    hide_console_tokio(&mut cmd);
    // Same job-object orphan guard as daemon::lifecycle's chat spawn: claude
    // loads the user's own MCP servers, so a dying daemon must not strand
    // the cmd/npx/node subtree.
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().context("spawn claude")?;
    crate::util::process::guard_orphan_tree(&child);
    let stdout = child.stdout.take().context("claude stdout")?;
    // Drain stderr concurrently so a chatty stderr can't fill its pipe and
    // deadlock the stdout read loop.
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
            on_delta(&chunk);
        }
    }

    let status = child.wait().await.context("wait claude")?;
    let stderr_out = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("claude exited {:?}: {}", status.code(), stderr_out.trim()));
    }
    let text = full.trim().to_string();
    if text.is_empty() {
        return Err(anyhow!("claude produced an empty summary"));
    }
    Ok(text)
}

/// RAII guard: removes `slug` from the inflight set on drop (success or error).
struct InFlightGuard {
    inflight: Arc<Mutex<HashSet<String>>>,
    slug: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.inflight.lock().unwrap().remove(&self.slug);
    }
}

/// Fetches the article for `slug`, streams a Markdown summary, writes the
/// `ai_summary*` fields back to the store, and returns the updated post. When
/// `emit` is true, fires `news-summary-phase` (fetching -> writing) and
/// `news-summary-delta` events keyed by slug so the open detail view can show
/// progress and live-write the text. On any failure nothing is persisted.
///
/// If a generation for the same slug is already in-flight (from the eager
/// backfill racing with this call), this function polls the store until the
/// inflight task writes the summary or times out - no second claude spawn.
pub async fn generate_for_slug(
    app: &AppHandle,
    path: &Path,
    slug: &str,
    emit: bool,
) -> Result<NewsPost> {
    // Grab the inflight set from AppState (absent in unit tests where there is no state).
    let inflight = app
        .try_state::<crate::state::AppState>()
        .map(|s| Arc::clone(&s.news_inflight));

    if let Some(ref set) = inflight {
        let already_running = {
            let mut guard = set.lock().unwrap();
            if guard.contains(slug) {
                true
            } else {
                guard.insert(slug.to_string());
                false
            }
        };

        if already_running {
            // Another task is generating this slug; poll until it saves the
            // summary (or clears the inflight entry on error) rather than
            // spawning a competing claude process.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let still_running = set.lock().unwrap().contains(slug);
                if !still_running {
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(anyhow!(
                        "timed out waiting for in-flight summary for {slug}"
                    ));
                }
            }
            // The other task finished; return whatever it wrote (or error if it failed).
            let store = crate::news::load(path);
            return store
                .posts
                .iter()
                .find(|p| p.slug == slug)
                .ok_or_else(|| anyhow!("post {slug} not found"))
                .and_then(|p| {
                    p.ai_summary
                        .as_ref()
                        .map(|_| p.clone())
                        .ok_or_else(|| anyhow!("in-flight generation for {slug} failed"))
                });
        }
    }

    // This call owns the slot; the guard clears it on exit (success or error).
    let _guard = inflight.map(|set| InFlightGuard {
        inflight: set,
        slug: slug.to_string(),
    });

    let (url, title) = {
        let store = crate::news::load(path);
        let post = store.posts.iter().find(|p| p.slug == slug)
            .ok_or_else(|| anyhow!("no post with slug {slug}"))?;
        (post.url.clone(), post.title.clone())
    };

    if emit {
        let _ = app.emit("news-summary-phase", serde_json::json!({ "slug": slug, "phase": "fetching" }));
    }
    let article_text = crate::news::scraper::fetch_article_text(&url).await?;

    if emit {
        let _ = app.emit("news-summary-phase", serde_json::json!({ "slug": slug, "phase": "writing" }));
    }
    let summary = {
        let app = app.clone();
        let slug = slug.to_string();
        generate_summary_streaming(&title, &article_text, |chunk| {
            if emit {
                let _ = app.emit("news-summary-delta", serde_json::json!({ "slug": slug, "chunk": chunk }));
            }
        })
        .await?
    };

    let mut store = crate::news::load(path);
    let post = store.posts.iter_mut().find(|p| p.slug == slug)
        .ok_or_else(|| anyhow!("no post with slug {slug}"))?;
    post.ai_summary = Some(summary);
    post.ai_summary_model = Some(SUMMARY_MODEL.to_string());
    post.ai_summary_at = Some(chrono::Utc::now().to_rfc3339());
    let snapshot = post.clone();
    crate::news::save(path, &store)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_includes_title_article_and_markdown_instruction() {
        let p = build_prompt("Claude Opus 4.8", "Body text here.");
        assert!(p.contains("Claude Opus 4.8"));
        assert!(p.contains("Body text here."));
        assert!(p.contains("Markdown"));
        assert!(p.contains("why it matters"));
    }

    #[test]
    fn summary_model_and_effort_are_subscription_safe_and_fast() {
        // Metered refusal is covered by chat::billing tests; generate_*
        // calls check_metered_billing before spawning. Lock the wiring here.
        assert_eq!(SUMMARY_MODEL, "sonnet");
        assert_eq!(SUMMARY_EFFORT, "low");
    }

    #[test]
    fn parse_text_delta_extracts_visible_text_only() {
        let textline = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}"#;
        assert_eq!(crate::chat::parser::text_delta(textline).as_deref(), Some("Hello"));
    }

    #[test]
    fn parse_text_delta_ignores_thinking_and_envelopes() {
        let thinking = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}}"#;
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#;
        let system = r#"{"type":"system","subtype":"init"}"#;
        assert_eq!(crate::chat::parser::text_delta(thinking), None);
        assert_eq!(crate::chat::parser::text_delta(start), None);
        assert_eq!(crate::chat::parser::text_delta(system), None);
        assert_eq!(crate::chat::parser::text_delta(""), None);
        assert_eq!(crate::chat::parser::text_delta("not json"), None);
    }
}
