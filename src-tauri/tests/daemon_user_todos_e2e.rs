//! "Your Todos" per-turn injection (todo 692), over the daemon's real HTTP
//! routes. `#[ignore]`: spawns a daemon, but starts no `claude` turn, so no
//! quota. Run it BARE, never piped - the spawned daemon inherits the pipe
//! handle and the pipeline outlives the test, printing nothing:
//!   cargo test --manifest-path src-tauri/Cargo.toml --test daemon_user_todos_e2e -- --ignored --nocapture

#![cfg(windows)]

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const MARKER: &str = "ZORBLAX-7741";

fn daemon_exe() -> PathBuf {
    // Derive from this test binary rather than assuming ./target: .cargo/config.toml
    // redirects target-dir off the repo.
    let mut p = std::env::current_exe().unwrap();
    p.pop();
    p.pop();
    p.push("cc-conductor-daemon.exe");
    p
}

fn todos_dir() -> PathBuf {
    dirs::data_dir().unwrap().join("claude-conductor").join("user-todos")
}

/// The store file holding our marker card. Found by content rather than by
/// project id, so the test never has to reimplement project-id hashing.
fn store_file() -> PathBuf {
    let dir = todos_dir();
    for entry in std::fs::read_dir(&dir).expect("user-todos dir").flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if std::fs::read_to_string(&path).map(|s| s.contains(MARKER)).unwrap_or(false) {
            return path;
        }
    }
    panic!("no store file under {dir:?} contains the marker card");
}

fn read_cards(path: &PathBuf) -> Vec<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).expect("read store")).expect("parse store")
}

/// Deliberately no pipe client: an earlier revision opened the daemon's named
/// pipe just to reach two already-unit-tested RPCs, and raced its bind.
async fn spawn_daemon() -> (std::process::Child, String) {
    const INSTANCE: &str = "test-todos";
    let app_data = dirs::data_dir().unwrap().join("claude-conductor");
    let _ = std::fs::remove_file(app_data.join(format!("daemon-{INSTANCE}.lock")));
    let port_file = app_data.join(format!("hooks_port-{INSTANCE}.txt"));
    let _ = std::fs::remove_file(&port_file);

    let build = Command::new("cargo").args(["build", "--bin", "cc-conductor-daemon"]).status().expect("cargo build");
    assert!(build.success());

    let child = Command::new(daemon_exe())
        .env("CC_DAEMON_INSTANCE", INSTANCE)
        .env("CC_DAEMON_NO_AUTOSTART", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn daemon");

    let mut hook_port = String::new();
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if !p.trim().is_empty() {
                hook_port = p.trim().to_string();
                break;
            }
        }
    }
    assert!(!hook_port.is_empty(), "daemon did not write its hook port file");
    (child, hook_port)
}

#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn a_card_reaches_the_prompt_hook_and_serving_it_marks_it_seen() {
    let (mut child, hook_port) = spawn_daemon().await;
    let http = reqwest::Client::new();

    let session_id = format!("todos-e2e-{}", std::process::id());
    let cwd = std::env::temp_dir().join(format!("cc-todos-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create cwd");
    let cwd_s = cwd.to_string_lossy().to_string();

    // Register the session so `caller_project` can resolve a project from it.
    let resp = http
        .post(format!("http://127.0.0.1:{hook_port}/hooks/session-start"))
        .json(&json!({"session_id": session_id, "cwd": cwd_s, "pid": 99999, "transcript_path": null, "source": "startup"}))
        .send()
        .await
        .expect("POST session-start");
    assert!(resp.status().is_success());

    // Write a card through the SAME route the `write_user_todo` MCP tool uses.
    let body: Value = http
        .post(format!("http://127.0.0.1:{hook_port}/todos/write"))
        .json(&json!({
            "session_id": session_id,
            "action": "add",
            "text": format!("Rename the KV namespace to {MARKER}"),
        }))
        .send()
        .await
        .expect("POST /todos/write")
        .json()
        .await
        .expect("json");
    assert_eq!(body["ok"], json!(true), "write_user_todo failed: {body}");

    let prompt_hook = format!("http://127.0.0.1:{hook_port}/hooks/prompt-submit?session_id={session_id}");

    // The hook renders the card, with scope derived from the viewing session.
    let injected = http.post(&prompt_hook).body("{}").send().await.expect("POST hook").text().await.expect("text");
    assert!(injected.contains("hookSpecificOutput"), "wrong envelope: {injected}");
    assert!(injected.contains("UserPromptSubmit"), "wrong hookEventName: {injected}");
    assert!(injected.contains(MARKER), "card missing from the injected block: {injected}");
    assert!(injected.contains("(this chat)"), "scope not derived for the viewer: {injected}");

    // A user-side tick's only persisted effect is clearing `seen_by_origin`,
    // which is what raises the notify CTA. Written straight to the store so
    // this stays a pure HTTP test (see the module header).
    let path = store_file();
    let mut cards = read_cards(&path);
    cards[0]["state"] = json!("done");
    cards[0]["by_ai"] = json!(false);
    cards[0]["seen_by_origin"] = json!(false);
    std::fs::write(&path, serde_json::to_string_pretty(&cards).unwrap()).expect("write store");

    // Serving the hook again is what clears it, with nothing clicked.
    let _ = http.post(&prompt_hook).body("{}").send().await.expect("POST hook again");
    assert_eq!(
        read_cards(&path)[0]["seen_by_origin"],
        json!(true),
        "a served turn must mark the card seen, or the CTA never clears itself"
    );

    // An empty board injects NOTHING, rather than a paragraph saying so into
    // every turn forever.
    std::fs::write(&path, "[]").expect("empty store");
    let empty = http.post(&prompt_hook).body("{}").send().await.expect("POST hook empty").text().await.expect("text");
    assert!(empty.is_empty(), "an empty board must inject no bytes, got: {empty}");

    let _ = std::fs::remove_file(&path);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&cwd);
}
