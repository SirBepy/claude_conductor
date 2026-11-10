//! The chat dashboard's three quick-view buttons (docs/chat-dashboard-design.md,
//! "Extra content and quick views"): Bigger plan, Decided and Project memory.
//! v1 only reads data that already exists on disk and hands it to the webview's
//! plain read view; nothing is written.
//!
//! Desktop-pipe only: absent from `remote_transport_table::TRANSPORT_TABLE`,
//! since the phone always draws the Messages view and never shows the buttons.
//! A chat mirrored from a paired peer has no `Instance` here, so it answers
//! "not available" rather than reading this machine's files for another
//! machine's chat.

use super::super::rpc::{Router, RpcError};
use super::super::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A file read in full would let one huge memory file stall the webview.
const MAX_DOC_BYTES: usize = 200 * 1024;
const MAX_DOCS: usize = 200;

/// `<cwd>/.claude/todos/PLAN.md`: the project's bigger plan (the todo format's
/// PLAN lane). A chat that links a different plan doc is handled in the webview,
/// which sees the chat's links; the daemon only knows the project's own file.
const PLAN_REL: [&str; 3] = [".claude", "todos", "PLAN.md"];

/// One file shown in the read view.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct Doc {
    name: String,
    body: String,
}

/// What a quick view hands back. `docs` is empty when there is nothing to read,
/// and `message` then says so in words Joe can read as-is.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct QuickView {
    view: String,
    title: String,
    docs: Vec<Doc>,
    message: String,
}

fn empty(view: &str, title: &str, message: &str) -> QuickView {
    QuickView { view: view.into(), title: title.into(), docs: Vec::new(), message: message.into() }
}

fn read_capped(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let cut = bytes.len().min(MAX_DOC_BYTES);
    let mut text = String::from_utf8_lossy(&bytes[..cut]).into_owned();
    if cut < bytes.len() {
        text.push_str("\n\n(cut here: the file is longer than the read view shows)");
    }
    Some(text)
}

pub(crate) fn plan_view(cwd: &Path) -> QuickView {
    let path = PLAN_REL.iter().fold(cwd.to_path_buf(), |p, s| p.join(s));
    match read_capped(&path).filter(|t| !t.trim().is_empty()) {
        Some(body) => QuickView {
            view: "plan".into(),
            title: "Bigger plan".into(),
            docs: vec![Doc { name: "PLAN.md".into(), body }],
            message: String::new(),
        },
        None => empty("plan", "Bigger plan", "This project has no bigger plan: .claude/todos/PLAN.md does not exist."),
    }
}

pub(crate) fn decided_view(log: Option<String>) -> QuickView {
    match log {
        Some(body) => QuickView {
            view: "decided".into(),
            title: "Decided".into(),
            docs: vec![Doc { name: "decisions.md".into(), body }],
            message: String::new(),
        },
        None => empty("decided", "Decided", "Nothing decided yet: this chat has no decisions log."),
    }
}

/// Claude Code's folder name for a working directory: every character that is
/// not a letter or digit becomes `-`.
pub(crate) fn encode_cwd(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The project's Auto Memory folder. The session's transcript sits in
/// `projects/<encoded cwd>/`, so its parent is the safest anchor (it is right
/// whatever account wrote it). Without a transcript the encoded cwd is looked
/// up under `projects_root`, comparing names without case because the drive
/// letter's case differs between a cwd and the folder Claude Code made.
pub(crate) fn memory_dir(transcript: Option<&Path>, cwd: &Path, projects_root: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = transcript.and_then(Path::parent).map(|p| p.join("memory")).filter(|p| p.is_dir()) {
        return Some(dir);
    }
    let want = encode_cwd(cwd);
    let found = std::fs::read_dir(projects_root?)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&want))?;
    Some(found.path().join("memory")).filter(|p| p.is_dir())
}

/// MEMORY.md first (it is the index), then every other `.md` by name.
pub(crate) fn memory_view(dir: Option<&Path>) -> QuickView {
    let none = || empty("memory", "Project memory", "This project has no memory yet.");
    let Some(dir) = dir else { return none() };
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_file())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.to_ascii_lowercase().ends_with(".md"))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| {
        let key = |n: &str| (!n.eq_ignore_ascii_case("MEMORY.md"), n.to_ascii_lowercase());
        key(a).cmp(&key(b))
    });
    let total = names.len();
    names.truncate(MAX_DOCS);
    let mut docs: Vec<Doc> = names
        .into_iter()
        .filter_map(|n| read_capped(&dir.join(&n)).map(|body| Doc { name: n, body }))
        .collect();
    if total > MAX_DOCS {
        docs.push(Doc { name: "(more)".into(), body: format!("{} more files are not shown.", total - MAX_DOCS) });
    }
    if docs.is_empty() {
        return none();
    }
    QuickView { view: "memory".into(), title: "Project memory".into(), docs, message: String::new() }
}

fn unavailable(view: &str) -> QuickView {
    empty(view, "Not available", "This chat is not hosted on this machine, so its files cannot be read here.")
}

pub fn register_quick_views(router: &mut Router, state: Arc<DaemonState>) {
    router.register("chat_quick_view", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(Deserialize)]
            struct P {
                session_id: String,
                view: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            if !matches!(p.view.as_str(), "plan" | "decided" | "memory") {
                return Err(RpcError::invalid_params(format!("unknown view: {}", p.view)));
            }
            let inst = state.registry.get(&p.session_id);
            let sid = p.session_id.clone();
            let view = p.view.clone();
            let out = tokio::task::spawn_blocking(move || match (view.as_str(), inst) {
                ("plan", Some(i)) => plan_view(&i.cwd),
                // A sub's decisions live in its main chat's log.
                ("decided", Some(i)) => {
                    decided_view(crate::daemon::subchats::decisions::read_log(i.subchat_of.as_deref().unwrap_or(&sid)))
                }
                ("memory", Some(i)) => {
                    let root = dirs::home_dir().map(|h| h.join(".claude").join("projects"));
                    memory_view(memory_dir(i.transcript_path.as_deref(), &i.cwd, root.as_deref()).as_deref())
                }
                _ => unavailable(&view),
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(out))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-quick-views-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plan_reads_the_projects_plan_file_and_says_so_when_there_is_none() {
        let cwd = tmp("plan");
        let none = plan_view(&cwd);
        assert!(none.docs.is_empty());
        assert!(none.message.contains("no bigger plan"));
        std::fs::create_dir_all(cwd.join(".claude").join("todos")).unwrap();
        std::fs::write(cwd.join(".claude").join("todos").join("PLAN.md"), "# Plan\nstep one").unwrap();
        let got = plan_view(&cwd);
        assert_eq!(got.docs.len(), 1);
        assert!(got.docs[0].body.contains("step one"));
        assert!(got.message.is_empty());
    }

    #[test]
    fn an_empty_plan_file_counts_as_no_plan() {
        let cwd = tmp("plan-empty");
        std::fs::create_dir_all(cwd.join(".claude").join("todos")).unwrap();
        std::fs::write(cwd.join(".claude").join("todos").join("PLAN.md"), "  \n").unwrap();
        assert!(plan_view(&cwd).docs.is_empty());
    }

    #[test]
    fn a_chat_with_no_decisions_log_says_nothing_is_decided() {
        let v = decided_view(None);
        assert!(v.docs.is_empty());
        assert!(v.message.contains("Nothing decided"));
        let v = decided_view(Some("# decisions\n- D1".into()));
        assert_eq!(v.docs[0].name, "decisions.md");
    }

    #[test]
    fn the_encoded_cwd_matches_claude_codes_folder_name() {
        assert_eq!(
            encode_cwd(Path::new(r"c:\Users\tecno\Desktop\Projects\claude_usage_in_taskbar")),
            "c--Users-tecno-Desktop-Projects-claude-usage-in-taskbar"
        );
    }

    #[test]
    fn memory_lists_the_index_first_and_finds_the_folder_without_a_transcript() {
        let root = tmp("mem-root");
        let cwd = Path::new(r"C:\Work\my_proj");
        let mem = root.join("c--Work-my-proj").join("memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(mem.join("zeta.md"), "z").unwrap();
        std::fs::write(mem.join("MEMORY.md"), "- [z](zeta.md)").unwrap();
        std::fs::write(mem.join("alpha.md"), "a").unwrap();
        std::fs::write(mem.join("notes.txt"), "skipped").unwrap();
        let dir = memory_dir(None, cwd, Some(&root)).expect("drive-letter case differs, name still matches");
        let v = memory_view(Some(&dir));
        let names: Vec<_> = v.docs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["MEMORY.md", "alpha.md", "zeta.md"]);
    }

    #[test]
    fn the_transcripts_folder_wins_over_the_encoded_lookup() {
        let root = tmp("mem-transcript");
        let proj = root.join("whatever");
        std::fs::create_dir_all(proj.join("memory")).unwrap();
        let transcript = proj.join("s.jsonl");
        let dir = memory_dir(Some(&transcript), Path::new("/nope"), None).unwrap();
        assert_eq!(dir, proj.join("memory"));
    }

    #[test]
    fn a_project_with_no_memory_folder_says_so() {
        let root = tmp("mem-none");
        assert!(memory_dir(None, Path::new("/x/y"), Some(&root)).is_none());
        let v = memory_view(None);
        assert!(v.docs.is_empty());
        assert!(v.message.contains("no memory"));
    }

    #[test]
    fn a_huge_memory_file_is_cut() {
        let root = tmp("mem-big");
        std::fs::write(root.join("MEMORY.md"), "x".repeat(MAX_DOC_BYTES + 10)).unwrap();
        let v = memory_view(Some(&root));
        assert!(v.docs[0].body.contains("cut here"));
    }

    mod rpc {
        use super::*;
        use crate::daemon::rpc::{ConnectionContext, Request, Response};
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;
        use crate::types::Settings;

        async fn call(state: Arc<DaemonState>, params: Value) -> Response {
            let mut r = Router::new();
            register_quick_views(&mut r, state);
            let (tx, _rx) = tokio::sync::mpsc::channel(16);
            r.dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "chat_quick_view".into(), params: Some(params) },
                ConnectionContext::new(tx),
            )
            .await
        }

        fn state_with(session_id: &str, cwd: PathBuf) -> Arc<DaemonState> {
            let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
            let settings = std::sync::Mutex::new(Settings::default());
            st.registry.register(
                RegisterInput {
                    session_id: session_id.into(),
                    cwd,
                    pid: 1,
                    kind: InstanceKind::Interactive,
                    is_remote: false,
                    transcript_path: None,
                    started_at: "2026-01-01T00:00:00Z".into(),
                },
                &settings,
                "2026-01-01T00:00:00Z",
            );
            st
        }

        #[tokio::test]
        async fn an_unknown_view_is_refused() {
            let st = state_with("qv-a", tmp("rpc-a"));
            let resp = call(st, json!({"session_id": "qv-a", "view": "nope"})).await;
            assert!(resp.error.is_some());
        }

        #[tokio::test]
        async fn the_plan_view_reads_the_sessions_project_folder() {
            let cwd = tmp("rpc-plan");
            std::fs::create_dir_all(cwd.join(".claude").join("todos")).unwrap();
            std::fs::write(cwd.join(".claude").join("todos").join("PLAN.md"), "# Plan\nbig").unwrap();
            let resp = call(state_with("qv-plan", cwd), json!({"session_id": "qv-plan", "view": "plan"})).await;
            let v = resp.result.expect("ok");
            assert_eq!(v["docs"][0]["name"], "PLAN.md");
            assert!(v["docs"][0]["body"].as_str().unwrap().contains("big"));
        }

        #[tokio::test]
        async fn a_session_this_daemon_does_not_host_reads_nothing() {
            let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
            let resp = call(st, json!({"session_id": "elsewhere", "view": "memory"})).await;
            let v = resp.result.expect("ok");
            assert_eq!(v["docs"].as_array().unwrap().len(), 0);
            assert!(v["message"].as_str().unwrap().contains("not hosted"));
        }

        #[tokio::test]
        async fn a_plain_chat_has_no_decisions() {
            let resp = call(state_with("qv-plain-chat", tmp("rpc-plain")), json!({"session_id": "qv-plain-chat", "view": "decided"})).await;
            let v = resp.result.expect("ok");
            assert_eq!(v["docs"].as_array().unwrap().len(), 0);
            assert!(v["message"].as_str().unwrap().contains("Nothing decided"));
        }
    }
}
