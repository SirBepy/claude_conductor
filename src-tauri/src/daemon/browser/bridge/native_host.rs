//! The bridge extension's pairing: a native messaging host, which the browser
//! starts on the extension's behalf and which answers with the bridge's port
//! and token. The browser only starts it for an extension listed in the
//! host manifest's `allowed_origins`, so no web page or other extension can
//! read the token, and Joe never pastes one.
//!
//! The host is this same executable: the browser runs it with the calling
//! extension's origin as the first argument (`main.rs` checks for it).

use std::io::{Read, Write};
use std::path::Path;
#[cfg(not(windows))]
use std::path::PathBuf;

use serde_json::{json, Value};

use super::EXTENSION_ID;

pub const HOST_NAME: &str = "com.claude_conductor.browser";

/// True when the browser started this process as the native host.
pub fn is_host_invocation(args: &[String]) -> bool {
    args.get(1).is_some_and(|a| a.starts_with("chrome-extension://"))
}

/// A request is a few bytes of JSON; anything near this is not our extension.
const MAX_REQUEST_BYTES: u32 = 64 * 1024;

/// Serves the extension on stdio until the browser closes the pipe. Reads the
/// pairing file of this process's daemon instance (`CC_DAEMON_INSTANCE`, as
/// the daemon itself resolves it), so a test browser started with that
/// variable pairs with a test daemon.
///
/// It stays up on purpose: the extension holds a `connectNative` port to this
/// process, and Chrome keeps an MV3 service worker alive while such a port is
/// open. A one-shot `sendNativeMessage` ends the process after its reply, so
/// it pairs but keeps nothing alive.
pub fn run_stdio() {
    serve(&mut std::io::stdin().lock(), &mut std::io::stdout().lock(), pairing);
}

/// Reads length-prefixed JSON requests until EOF (the browser closed the
/// port) and answers each: `{"type":"keepalive"}` gets `{"type":"pong"}`,
/// anything else is a pairing request.
fn serve(input: &mut impl Read, output: &mut impl Write, pairing: impl Fn() -> Result<Value, String>) {
    loop {
        let mut len = [0u8; 4];
        if input.read_exact(&mut len).is_err() {
            return;
        }
        let len = u32::from_le_bytes(len);
        if len > MAX_REQUEST_BYTES {
            return;
        }
        let mut request = vec![0u8; len as usize];
        if input.read_exact(&mut request).is_err() {
            return;
        }
        let keepalive = serde_json::from_slice::<Value>(&request).is_ok_and(|v| v["type"] == json!("keepalive"));
        let reply = if keepalive { json!({ "type": "pong" }) } else { pairing().unwrap_or_else(|e| json!({ "error": e })) };
        let body = reply.to_string().into_bytes();
        let sent = output.write_all(&(body.len() as u32).to_le_bytes()).and_then(|_| output.write_all(&body)).and_then(|_| output.flush());
        if sent.is_err() {
            return;
        }
    }
}

fn pairing() -> Result<Value, String> {
    let dir = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    let path = super::pairing_file(&dir, &crate::daemon::instance::instance_suffix());
    let text = std::fs::read_to_string(&path).map_err(|_| "Claude Conductor is not running".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn manifest(exe: &Path) -> Value {
    json!({
        "name": HOST_NAME,
        "description": "Claude Conductor browser pairing",
        "path": exe,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    })
}

/// Registers `exe` as the host for Chrome, Edge, Brave and Chromium.
/// Idempotent; run at every start of the default daemon so a moved or
/// updated install keeps pairing.
pub fn register(exe: &Path, data_dir: &Path) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&manifest(exe)).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let dir = data_dir.join("native-messaging");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("{HOST_NAME}.json"));
        std::fs::write(&file, body).map_err(|e| e.to_string())?;
        for root in WINDOWS_KEYS {
            set_default_value(&format!(r"{root}\NativeMessagingHosts\{HOST_NAME}"), &file.to_string_lossy())?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        for dir in host_dirs() {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(format!("{HOST_NAME}.json")), &body).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Per-user keys each browser reads its native hosts from.
#[cfg(windows)]
const WINDOWS_KEYS: [&str; 4] = [
    r"Software\Google\Chrome",
    r"Software\Microsoft\Edge",
    r"Software\BraveSoftware\Brave-Browser",
    r"Software\Chromium",
];

#[cfg(windows)]
fn set_default_value(subkey: &str, value: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (key, data) = (wide(subkey), wide(value));
    let rc = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR::null(), REG_SZ.0, Some(data.as_ptr().cast()), (data.len() * 2) as u32)
    };
    if rc == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("register native host under HKCU\\{subkey}: {rc:?}"))
    }
}

#[cfg(not(windows))]
fn host_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return vec![] };
    #[cfg(target_os = "macos")]
    let roots = ["Google/Chrome", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Chromium"].map(|r| home.join("Library/Application Support").join(r));
    #[cfg(not(target_os = "macos"))]
    let roots = ["google-chrome", "microsoft-edge", "BraveSoftware/Brave-Browser", "chromium"].map(|r| home.join(".config").join(r));
    roots.into_iter().map(|r| r.join("NativeMessagingHosts")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_bridge_extension_may_start_the_host() {
        let m = manifest(Path::new(r"C:\app\conductor.exe"));
        assert_eq!(m["allowed_origins"], json!([format!("chrome-extension://{EXTENSION_ID}/")]));
        assert_eq!(m["name"], json!(HOST_NAME));
        assert_eq!(m["type"], json!("stdio"));
    }

    fn frame(v: &Value) -> Vec<u8> {
        let body = v.to_string().into_bytes();
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend(body);
        out
    }

    fn replies(mut out: &[u8]) -> Vec<Value> {
        let mut all = vec![];
        while !out.is_empty() {
            let len = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
            all.push(serde_json::from_slice(&out[4..4 + len]).unwrap());
            out = &out[4 + len..];
        }
        all
    }

    /// The held port is what keeps Brave's worker alive: the host answers
    /// every request on it and only ends when the browser closes stdin.
    #[test]
    fn the_host_answers_every_request_and_stays_up_until_stdin_ends() {
        let mut input = Vec::new();
        for v in [json!({ "type": "pair" }), json!({ "type": "keepalive" }), json!({ "type": "keepalive" }), json!({ "type": "pair" })] {
            input.extend(frame(&v));
        }
        let mut out = Vec::new();
        serve(&mut input.as_slice(), &mut out, || Ok(json!({ "port": 7, "token": "t" })));
        let got = replies(&out);
        let paired = json!({ "port": 7, "token": "t" });
        assert_eq!(got, [paired.clone(), json!({ "type": "pong" }), json!({ "type": "pong" }), paired], "one reply per request, in order, none lost to an early exit");
    }

    /// A reader that blocks like a live pipe proves the host does not exit
    /// after its first reply: it must still be waiting for the next request.
    #[test]
    fn the_host_does_not_exit_after_the_first_reply_while_stdin_is_open() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        struct Pipe(std::sync::mpsc::Receiver<Vec<u8>>, Vec<u8>);
        impl Read for Pipe {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.1.is_empty() {
                    match self.0.recv() {
                        Ok(next) => self.1 = next,
                        Err(_) => return Ok(0),
                    }
                }
                let n = buf.len().min(self.1.len());
                buf[..n].copy_from_slice(&self.1[..n]);
                self.1.drain(..n);
                Ok(n)
            }
        }
        let host = std::thread::spawn(move || {
            let mut out = Vec::new();
            serve(&mut Pipe(rx, Vec::new()), &mut out, || Ok(json!({})));
            out
        });
        tx.send(frame(&json!({ "type": "keepalive" }))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!host.is_finished(), "the host quit with the port still open");
        tx.send(frame(&json!({ "type": "keepalive" }))).unwrap();
        drop(tx);
        assert_eq!(replies(&host.join().unwrap()).len(), 2, "a request after the first is still answered, and EOF ends it");
    }

    #[test]
    fn a_pairing_failure_is_an_error_reply_not_an_exit() {
        let input = [frame(&json!({ "type": "pair" })), frame(&json!({ "type": "keepalive" }))].concat();
        let mut out = Vec::new();
        serve(&mut input.as_slice(), &mut out, || Err("Claude Conductor is not running".to_string()));
        assert_eq!(replies(&out), [json!({ "error": "Claude Conductor is not running" }), json!({ "type": "pong" })]);
    }

    #[test]
    fn an_oversized_or_truncated_request_ends_the_host_without_a_reply() {
        let mut out = Vec::new();
        serve(&mut (MAX_REQUEST_BYTES + 1).to_le_bytes().as_slice(), &mut out, || Ok(json!({})));
        assert!(out.is_empty());
        let mut truncated = 10u32.to_le_bytes().to_vec();
        truncated.extend(b"{}");
        serve(&mut truncated.as_slice(), &mut out, || Ok(json!({})));
        assert!(out.is_empty());
    }

    #[test]
    fn the_browser_starting_the_host_is_recognised() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_host_invocation(&args(&["conductor.exe", "chrome-extension://abc/", "--parent-window=0"])));
        assert!(!is_host_invocation(&args(&["conductor.exe", "--daemon"])));
        assert!(!is_host_invocation(&args(&["conductor.exe"])));
    }

    /// The manifest's pinned key must give the id every allowed_origins and
    /// Origin check uses, or pairing silently never happens.
    #[test]
    fn the_pinned_manifest_key_gives_the_extension_id() {
        use base64::Engine;
        use sha2::Digest;
        let manifest: Value = serde_json::from_str(include_str!("../../../../../browser-extension/manifest.json")).unwrap();
        let der = base64::engine::general_purpose::STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap();
        let hash = sha2::Sha256::digest(&der);
        let id: String = hash[..16].iter().flat_map(|b| [b >> 4, b & 0xf]).map(|n| (b'a' + n) as char).collect();
        assert_eq!(id, EXTENSION_ID);
    }
}
