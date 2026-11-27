//! One lean, no-tools `claude -p` call per note. Same flags and billing guards as
//! the dictation rewrite (`voice::cleanup`, `voice::rewrite::lean_args`): the
//! model gets no tools, no hooks, no MCP servers and no session log, so a note
//! that tries to instruct it has nothing to act with. The daemon, not the model,
//! writes the todos and the front matter, after checking what the model claims.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::chat::billing::check_metered_billing;
use crate::util::process::hide_console_tokio;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Judgment over a transcript, not a rewrite of it, so a step above dictation's
/// haiku; the effort stays low because the answer is a short JSON object.
pub const TRIAGE_MODEL: &str = "sonnet";
pub const TRIAGE_EFFORT: &str = "low";

const CALL_TIMEOUT: Duration = Duration::from_secs(180);

pub enum TriageError {
    /// No call can work now (no subscription account, a metered-billing variable,
    /// no `claude`): the run stops instead of trying every note.
    Unavailable(String),
    /// This note's call failed; the next one may still work.
    Failed(String),
}

pub trait Triager: Send + Sync {
    /// The model's whole reply text for `input` under `system`.
    fn decide<'a>(&'a self, system: &'a str, input: &'a str) -> BoxFut<'a, Result<String, TriageError>>;
}

pub struct LeanTriager {
    work_dir: PathBuf,
}

impl LeanTriager {
    pub fn new(app_data: PathBuf) -> Self {
        Self { work_dir: app_data.join("voice-notes").join("triage") }
    }
}

impl Triager for LeanTriager {
    fn decide<'a>(&'a self, system: &'a str, input: &'a str) -> BoxFut<'a, Result<String, TriageError>> {
        Box::pin(async move {
            match tokio::time::timeout(CALL_TIMEOUT, self.run(system, input)).await {
                Ok(r) => r,
                Err(_) => Err(TriageError::Failed(format!("the model took longer than {}s", CALL_TIMEOUT.as_secs()))),
            }
        })
    }
}

impl LeanTriager {
    async fn run(&self, system: &str, input: &str) -> Result<String, TriageError> {
        use TriageError::{Failed, Unavailable};
        let account = crate::accounts::resolve_default_account().map_err(|e| Unavailable(format!("no account for the triage pass: {e}")))?;
        // Subscription accounts only, like every non-chat spawn (CLAUDE.md: the chat hub is subscription-only).
        crate::accounts::refuse_non_subscription(&account, "voice-note triage").map_err(Unavailable)?;
        crate::accounts::drift::check(&account).map_err(|e| Unavailable(e.to_string()))?;
        crate::accounts::credentials::check_now(&account).map_err(|e| Unavailable(e.to_string()))?;
        let spawn_env = crate::accounts::env::SpawnEnv::for_account(&account.config_dir);
        let effective_env = spawn_env.effective_env(std::env::vars());
        check_metered_billing(&|k| effective_env.get(k).cloned()).map_err(|e| Unavailable(e.to_string()))?;

        std::fs::create_dir_all(&self.work_dir).map_err(|e| Failed(format!("cannot create {}: {e}", self.work_dir.display())))?;
        let system_file = self.work_dir.join("triage-system.txt");
        let mcp_file = self.work_dir.join("triage-empty-mcp.json");
        std::fs::write(&system_file, system).map_err(|e| Failed(format!("cannot write the system prompt: {e}")))?;
        std::fs::write(&mcp_file, r#"{"mcpServers":{}}"#).map_err(|e| Failed(format!("cannot write the empty MCP config: {e}")))?;

        // Run in the work dir, never a repo, so a stray CLAUDE.md cannot steer the pass.
        let mut cmd = tokio::process::Command::new(crate::util::claude_bin::program());
        cmd.args(crate::voice::rewrite::lean_args(TRIAGE_MODEL, TRIAGE_EFFORT, &system_file, &mcp_file))
            .current_dir(&self.work_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        spawn_env.apply_tokio(&mut cmd);
        hide_console_tokio(&mut cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| Unavailable(format!("cannot start claude: {e}")))?;
        crate::util::process::guard_orphan_tree(&child);
        // The transcript goes over stdin: a command line is readable by every process of this user.
        let mut stdin = child.stdin.take().ok_or_else(|| Failed("claude has no stdin".into()))?;
        stdin.write_all(input.as_bytes()).await.map_err(|e| Failed(format!("cannot send the note to claude: {e}")))?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or_else(|| Failed("claude has no stdout".into()))?;
        let stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut s = String::new();
            if let Some(mut se) = stderr {
                let _ = se.read_to_string(&mut s).await;
            }
            s
        });
        let mut result = None;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await.map_err(|e| Failed(format!("cannot read claude's output: {e}")))? {
            if let Some(r) = crate::ask::sidecar::parse_ask_result_line(&line) {
                result = Some(r);
            }
        }
        let status = child.wait().await.map_err(|e| Failed(format!("cannot wait for claude: {e}")))?;
        let stderr_out = stderr_task.await.unwrap_or_default();
        if !status.success() {
            return Err(Failed(format!("claude exited {:?}: {}", status.code(), stderr_out.trim())));
        }
        let result = result.ok_or_else(|| Failed(format!("claude returned no result: {}", stderr_out.trim())))?;
        if result.is_error || result.text.trim().is_empty() {
            return Err(Failed(format!("claude returned an empty or failed result: {}", stderr_out.trim())));
        }
        Ok(result.text)
    }
}
