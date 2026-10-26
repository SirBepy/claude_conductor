//! One `@playwright/mcp` child per chat, spoken to as an MCP client over
//! stdio. Every child attaches to the same Chrome over CDP, so they share the
//! profile's sign-ins, but each opens its own tab on start: Playwright MCP
//! tracks a "current tab" per connection, and two chats steering one tab
//! would trample each other. A child can instead attach to one of Joe's own
//! browsers through the bridge (`Attach::Bridge`), in a window of its own.

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
    /// One of Joe's browsers, through the bridge's per-chat CDP endpoint.
    Bridge(Mine),
}

fn attach_args(attach: &Attach, bridge_endpoint: Option<&str>) -> Result<Vec<String>, String> {
    match (attach, bridge_endpoint) {
        (Attach::Cdp(port), _) => Ok(vec!["--cdp-endpoint".to_string(), format!("http://127.0.0.1:{port}")]),
        (Attach::Bridge(_), Some(endpoint)) => Ok(vec!["--cdp-endpoint".to_string(), endpoint.to_string()]),
        (Attach::Bridge(_), None) => Err("no bridge endpoint for Joe's browser".to_string()),
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
    /// The bridge registration an `Attach::Bridge` child connects through,
    /// dropped when the driver is retired.
    bridge_key: Option<String>,
}

impl PlaywrightClient {
    /// `bridge` is the registration key and endpoint an `Attach::Bridge`
    /// child connects through.
    pub async fn start(node: &Path, cli: &Path, attach: &Attach, output_dir: &Path, bridge: Option<(String, String)>) -> Result<Self, String> {
        std::fs::create_dir_all(output_dir).map_err(|e| format!("create {}: {e}", output_dir.display()))?;
        let (bridge_key, endpoint) = bridge.unzip();
        let mut cmd = Command::new(node);
        cmd.arg(cli)
            .args(attach_args(attach, endpoint.as_deref())?)
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
            bridge_key,
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
        // The child's exit closes its bridge socket, which closes its window.
        if let Some(key) = self.bridge_key.take() {
            super::bridge::get().unregister(&key);
        }
        if let (Some(id), Attach::Cdp(port)) = (self.tab_id.take(), &self.attach) {
            tabs::close_page(&tabs::base_url(*port), &id).await;
        }
    }

    /// `call_tool`, except that a chat's own `browser_tabs new` in the daemon
    /// Chrome replaces its previous tab instead of leaving it open: a chat
    /// works in one tab at a time, and the old ones only piled up. (Joe's own
    /// browser does the same in `bridge`.)
    pub async fn call_replacing_tabs(&mut self, name: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let port = match self.attach {
            Attach::Cdp(port) if name == "browser_tabs" && args["action"] == "new" => port,
            _ => return self.call_tool(name, args, timeout).await,
        };
        let base = tabs::base_url(port);
        let mut out = None;
        let found = {
            let (me, out) = (&mut *self, &mut out);
            tabs::open_and_find(&base, move || async move {
                *out = Some(me.call_tool(name, args, timeout).await?);
                Ok::<(), String>(())
            })
            .await?
        };
        if let Some(old) = found.and_then(|new| self.tab_id.replace(new)) {
            tabs::close_page(&base, &old).await;
        }
        Ok(out.unwrap_or(Value::Null))
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
        assert_eq!(attach_args(&Attach::Cdp(9222), None).unwrap(), ["--cdp-endpoint", "http://127.0.0.1:9222"]);
    }

    #[test]
    fn joes_browser_is_attached_through_its_bridge_endpoint() {
        use super::super::target::{App, Mine};
        let bridge = Attach::Bridge(Mine { app: App::Chrome, profile: None });
        let endpoint = "ws://127.0.0.1:5/cdp/k?token=t";
        assert_eq!(attach_args(&bridge, Some(endpoint)).unwrap(), ["--cdp-endpoint", endpoint]);
        assert!(attach_args(&bridge, None).is_err());
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
