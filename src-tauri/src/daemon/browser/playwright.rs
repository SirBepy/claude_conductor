//! One `@playwright/mcp` child per chat, spoken to as an MCP client over
//! stdio. Every child attaches to the same Chrome over CDP, so they share the
//! profile's sign-ins, but each opens its own tab on start: Playwright MCP
//! tracks a "current tab" per connection, and two chats steering one tab
//! would trample each other. A child can instead attach to one of Joe's own
//! browsers through the Playwright extension (`Attach::Extension`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::target::Mine;
use super::tabs;

const INIT_TIMEOUT: Duration = Duration::from_secs(30);
/// A tool call can legitimately wait (`browser_wait_for`, a slow page load),
/// but a wedged child must not hold the chat's turn forever.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(300);
/// Output files (snapshots, screenshots) evict oldest-first past this.
const OUTPUT_MAX_BYTES: u64 = 200 * 1024 * 1024;

/// What a child drives. A relaunched daemon Chrome means a new port, and a
/// changed Settings choice means a different browser; either way the old
/// child is stale.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attach {
    /// The daemon's own Chrome, over its DevTools port.
    Cdp(u16),
    /// One of Joe's browsers, through the Playwright extension.
    Extension(Mine),
}

/// The Playwright extension's token. With it the connect page skips its
/// tab picker, and a connection that never comes fails after 30s with a
/// reason instead of waiting out the whole call timeout.
const EXTENSION_TOKEN_VAR: &str = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";

/// The token for a new extension child, read fresh each time: Joe sets it as
/// a user environment variable, which a daemon started before he set (or
/// changed) it never sees, so the user-scope value wins and the daemon's own
/// environment is only the fallback.
fn extension_token() -> Option<String> {
    pick_token(user_env_var(EXTENSION_TOKEN_VAR), std::env::var(EXTENSION_TOKEN_VAR).ok())
}

fn pick_token(user: Option<String>, process: Option<String>) -> Option<String> {
    [user, process].into_iter().flatten().map(|t| t.trim().to_string()).find(|t| !t.is_empty())
}

/// A REG_SZ value under HKCU\Environment, where Windows keeps user-scope
/// environment variables.
#[cfg(windows)]
fn user_env_var(name: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (key, value) = (wide("Environment"), wide(name));
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..len.min(buf.len())]))
}

#[cfg(not(windows))]
fn user_env_var(_name: &str) -> Option<String> {
    None
}

fn attach_args(attach: &Attach) -> Result<Vec<String>, String> {
    match attach {
        Attach::Cdp(port) => Ok(vec!["--cdp-endpoint".to_string(), format!("http://127.0.0.1:{port}")]),
        Attach::Extension(mine) => mine.playwright_args(),
    }
}

pub struct PlaywrightClient {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    pub attach: Attach,
    pub last_used: Instant,
    output_dir: PathBuf,
    /// DevTools target id of the tab this driver opened, when it could be
    /// told apart from others; closed when the driver is retired.
    tab_id: Option<String>,
}

impl PlaywrightClient {
    pub async fn start(node: &Path, cli: &Path, attach: &Attach, output_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(output_dir).map_err(|e| format!("create {}: {e}", output_dir.display()))?;
        let mut cmd = Command::new(node);
        cmd.arg(cli)
            .args(attach_args(attach)?)
            .arg("--output-dir")
            .arg(output_dir)
            .arg("--output-max-size")
            .arg(OUTPUT_MAX_BYTES.to_string())
            // Relative links in responses resolve against the cwd.
            .current_dir(output_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Attach::Extension(_) = attach {
            if let Some(token) = extension_token() {
                cmd.env(EXTENSION_TOKEN_VAR, token);
            }
        }
        crate::util::process::hide_console_tokio(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("start playwright-mcp: {e}"))?;
        crate::util::process::guard_orphan_tree(&child);
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::debug!("playwright-mcp stderr: {line}");
                }
            });
        }
        let stdin = child.stdin.take().ok_or("playwright-mcp has no stdin")?;
        let stdout = child.stdout.take().ok_or("playwright-mcp has no stdout")?;
        let mut client = Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 0,
            attach: attach.clone(),
            last_used: Instant::now(),
            output_dir: output_dir.to_path_buf(),
            tab_id: None,
        };
        client
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "cc_conductor", "version": env!("CARGO_PKG_VERSION") }
                }),
                INIT_TIMEOUT,
            )
            .await?;
        client.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        // Tab bookkeeping reads the daemon Chrome's DevTools HTTP endpoint,
        // which Joe's own browser does not expose.
        if let Attach::Cdp(port) = attach {
            let base = tabs::base_url(*port);
            client.tab_id = tabs::open_and_find(&base, || async {
                client.call_tool("browser_tabs", json!({ "action": "new" }), INIT_TIMEOUT).await.map(|_| ())
            })
            .await?;
        }
        Ok(client)
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }

    /// `kill` plus closing the tab this driver opened: a replacement driver
    /// opens its own, so leaving this one would pile a tab up per restart.
    pub async fn retire(&mut self) {
        self.kill().await;
        if let (Some(id), Attach::Cdp(port)) = (self.tab_id.take(), &self.attach) {
            tabs::close_page(&tabs::base_url(*port), &id).await;
        }
    }

    /// The MCP `result` object (`content` plus `isError`), with file links
    /// made absolute so the chat can open them.
    pub async fn call_tool(&mut self, name: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        self.last_used = Instant::now();
        let mut result = self.request("tools/call", json!({ "name": name, "arguments": args }), timeout).await?;
        if let Some(parts) = result["content"].as_array_mut() {
            for part in parts {
                if let Some(text) = part["text"].as_str() {
                    part["text"] = Value::String(absolutize_links(text, &self.output_dir));
                }
            }
        }
        Ok(result)
    }

    async fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("write to playwright-mcp: {e}"))?;
        self.stdin.flush().await.map_err(|e| format!("flush playwright-mcp: {e}"))
    }

    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let line = match tokio::time::timeout_at(deadline, self.lines.next_line()).await {
                Err(_) => return Err(format!("playwright-mcp {method} timed out after {}s", timeout.as_secs())),
                Ok(Err(e)) => return Err(format!("read from playwright-mcp: {e}")),
                Ok(Ok(None)) => return Err("playwright-mcp exited".to_string()),
                Ok(Ok(Some(l))) => l,
            };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            // Notifications and server-to-client requests carry no matching id.
            if msg["id"].as_u64() != Some(id) || msg.get("method").is_some() {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(format!("playwright-mcp {method}: {}", err["message"].as_str().unwrap_or("error")));
            }
            return Ok(msg["result"].clone());
        }
    }
}

/// Playwright MCP writes markdown links relative to its cwd, e.g.
/// `[Snapshot](page-...yml)`. A chat runs in a different cwd, so rewrite each
/// link that names a file in `dir` to its absolute path.
fn absolutize_links(text: &str, dir: &Path) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("](") {
        let (head, tail) = rest.split_at(start + 2);
        out.push_str(head);
        let Some(end) = tail.find(')') else {
            rest = tail;
            break;
        };
        let target = &tail[..end];
        let candidate = Path::new(target);
        if !target.is_empty() && candidate.is_relative() && !target.contains("://") && dir.join(candidate).is_file() {
            out.push_str(&dir.join(candidate).to_string_lossy());
        } else {
            out.push_str(target);
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_daemon_chrome_is_attached_over_its_devtools_port() {
        assert_eq!(attach_args(&Attach::Cdp(9222)).unwrap(), ["--cdp-endpoint", "http://127.0.0.1:9222"]);
    }

    #[test]
    fn joes_browser_is_attached_through_the_extension_not_a_port() {
        use super::super::target::{App, Mine};
        let args = attach_args(&Attach::Extension(Mine { app: App::Chrome, profile: None })).unwrap();
        assert!(args.contains(&"--extension".to_string()));
        assert!(!args.iter().any(|a| a == "--cdp-endpoint"), "{args:?}");
    }

    #[test]
    fn the_extension_token_prefers_the_user_scope_and_falls_back_to_the_process_env() {
        assert_eq!(pick_token(Some("u".into()), Some("p".into())).as_deref(), Some("u"));
        assert_eq!(pick_token(None, Some(" p ".into())).as_deref(), Some("p"));
        assert_eq!(pick_token(Some("  ".into()), Some("p".into())).as_deref(), Some("p"));
        assert_eq!(pick_token(None, None), None);
    }

    /// A value this test writes itself would land in Joe's real registry, so
    /// it reads one Windows sets for a normal user profile instead. A CI
    /// runner account may lack it, so its absence is not a failure.
    #[cfg(windows)]
    #[test]
    fn a_user_scope_variable_is_read_from_the_registry() {
        if let Some(temp) = user_env_var("TEMP") {
            assert!(temp.to_lowercase().contains("temp"), "{temp}");
        }
        assert_eq!(user_env_var("CC_SURELY_NOT_A_VARIABLE_1334"), None);
    }

    #[test]
    fn relative_links_to_existing_output_files_become_absolute() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("page-1.yml"), "x").unwrap();
        let text = "- [Snapshot](page-1.yml)\n- [Example](https://example.com/)\n- [Gone](missing.png)";
        let out = absolutize_links(text, dir.path());
        assert!(out.contains(&format!("[Snapshot]({})", dir.path().join("page-1.yml").display())));
        assert!(out.contains("[Example](https://example.com/)"), "URLs are left alone");
        assert!(out.contains("[Gone](missing.png)"), "a link to no file is left alone");
    }

    #[test]
    fn text_without_links_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(absolutize_links("plain ](unterminated", dir.path()), "plain ](unterminated");
        assert_eq!(absolutize_links("", dir.path()), "");
    }
}
