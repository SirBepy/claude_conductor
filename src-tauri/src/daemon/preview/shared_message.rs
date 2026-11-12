//! Joe's message to one element of a shared mockup: the panel
//! sends `{ preview id, region id or "shell", text }`, the daemon works out which
//! chat owns that element, delivers the text to it as a user message and queues
//! one `back.rs` line for the main chat saying where it went. Joe never picks
//! the chat.
//!
//! The text goes to the target as an ordinary user message (never `is_meta`),
//! and the main chat's line carries only the element and the target's name, so a
//! sub's or Joe's words never ride in app-authored text.

use super::shared::{regions, SHELL_ID};
use super::{load_list, store_path};
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;

const MAX_TEXT_CHARS: usize = 4000;

/// Where one element message goes.
#[derive(Debug, PartialEq)]
pub(super) struct Target {
    pub owner: String,
    pub session_id: String,
    pub name: String,
    /// The text sent to the target: Joe's words behind one line naming the element.
    pub framed: String,
}

fn in_family(state: &DaemonState, owner: &str, id: &str) -> bool {
    id == owner || state.registry.get(id).and_then(|i| i.subchat_of).as_deref() == Some(owner)
}

fn name_of(state: &DaemonState, id: &str) -> String {
    state
        .registry
        .get(id)
        .and_then(|i| i.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()))
        .unwrap_or_else(|| id.chars().take(8).collect())
}

/// The chat that owns `element` of preview `id`: a region's writer, or for
/// `shell` the layout sub, falling back to the main chat when none is named (or
/// the named one left the family). Refuses an unknown preview, a preview that is
/// not a shared mockup, a region the page does not have, and a writer outside
/// the family.
pub(super) fn resolve_at(path: &Path, state: &DaemonState, id: &str, element: &str, text: &str) -> Result<Target, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("the message is empty".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("the message is over {MAX_TEXT_CHARS} characters"));
    }
    let list = load_list(path);
    let snap = list.iter().find(|s| s.id == id).ok_or("unknown preview")?;
    let shared = snap.shared.as_ref().ok_or("that preview is not a shared mockup")?;
    let owner = shared.owner_session_id.clone();
    let (target, what) = if element == SHELL_ID {
        let layout = shared.layout_session_id.clone().filter(|l| in_family(state, &owner, l));
        (layout.unwrap_or_else(|| owner.clone()), "the page layout (the shell)".to_string())
    } else {
        if !regions(&shared.shell).iter().any(|r| r == element) {
            return Err(format!("\"{element}\" is not a region of this page"));
        }
        let writer = shared.parts.iter().find(|p| p.id == element).map(|p| p.owner_session_id.clone());
        (writer.unwrap_or_else(|| owner.clone()), format!("the \"{element}\" region"))
    };
    if !in_family(state, &owner, &target) {
        return Err("that element's owner is not part of this page's main chat".into());
    }
    let framed = format!("About {what} of the shared mockup \"{}\": {text}", snap.slug);
    Ok(Target { owner, name: name_of(state, &target), session_id: target, framed })
}

/// Resolves, delivers through `deliver(session_id, text)`, then queues the one
/// line for the main chat. The line is skipped when the main chat is itself the
/// target, since it received the message directly. Nothing is queued when
/// delivery fails.
pub(super) async fn send_at<F, Fut>(
    path: &Path,
    root: Option<&Path>,
    state: &DaemonState,
    id: &str,
    element: &str,
    text: &str,
    deliver: F,
) -> Result<Value, RpcError>
where
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<(), RpcError>>,
{
    let target = resolve_at(path, state, id, element, text).map_err(RpcError::invalid_params)?;
    deliver(target.session_id.clone(), target.framed.clone()).await?;
    if target.session_id != target.owner {
        match root {
            Some(root) => crate::daemon::subchats::back::queue_element_in(root, &target.owner, element, &target.name),
            None => crate::daemon::subchats::back::queue_element(&target.owner, element, &target.name),
        }
    }
    Ok(json!({ "ok": true, "target_session_id": target.session_id, "target_name": target.name, "element": element }))
}

/// The real store and the real delivery.
pub async fn send<F, Fut>(state: &DaemonState, id: &str, element: &str, text: &str, deliver: F) -> Result<Value, RpcError>
where
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<(), RpcError>>,
{
    let path = store_path().ok_or_else(|| RpcError::internal("the preview store has no data directory"))?;
    send_at(&path, None, state, id, element, text, deliver).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::preview::shared::run_at;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::sync::{Arc, Mutex};

    const SHELL: &str = "<main><div data-part=\"header\"></div><div data-part=\"footer\"></div></main>";

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, Arc<DaemonState>, String) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preview-history.json");
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        for id in ["main", "sub-a", "sub-b", "stranger"] {
            st.registry.upsert_interactive(id, Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        st.registry.set_subchat_of("sub-a", Some("main".into()));
        st.registry.set_subchat_of("sub-b", Some("main".into()));
        st.registry.set_name("sub-a", "Hero".to_string());
        st.registry.set_name("sub-b", "Layouter".to_string());
        run_at(&path, &st, "main", &json!({"action": "create", "slug": "page", "shell": SHELL}));
        run_at(&path, &st, "sub-a", &json!({"action": "part", "part": "header", "html": "H"}));
        let id = load_list(&path)[0].id.clone();
        (tmp, path, st, id)
    }

    type Sent = Arc<Mutex<Vec<(String, String)>>>;

    fn recorder(sent: &Sent) -> impl FnOnce(String, String) -> std::future::Ready<Result<(), RpcError>> {
        let sent = sent.clone();
        move |sid, text| {
            sent.lock().unwrap().push((sid, text));
            std::future::ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn a_region_message_goes_to_its_writer_and_queues_exactly_one_line_for_the_main_chat() {
        let (tmp, path, st, id) = setup();
        let sent: Sent = Default::default();
        let out = send_at(&path, Some(tmp.path()), &st, &id, "header", "make it bigger", recorder(&sent)).await.unwrap();
        assert_eq!(out["target_session_id"], json!("sub-a"));
        let got = sent.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "sub-a");
        assert!(got[0].1.contains("make it bigger") && got[0].1.contains("\"header\" region"), "{}", got[0].1);
        let served = crate::daemon::subchats::back::peek_in(tmp.path(), "main").expect("one line for the main chat");
        assert_eq!(served.text.matches("\n- ").count(), 1, "{}", served.text);
        assert!(served.text.contains("\"header\" went to \"Hero\""), "{}", served.text);
        assert!(!served.text.contains("make it bigger"), "the message text never rides in the line");
    }

    #[tokio::test]
    async fn a_shell_message_goes_to_the_layout_sub_else_to_the_main_chat_with_no_line() {
        let (tmp, path, st, id) = setup();
        let sent: Sent = Default::default();
        send_at(&path, Some(tmp.path()), &st, &id, "shell", "denser", recorder(&sent)).await.unwrap();
        assert_eq!(sent.lock().unwrap()[0].0, "main", "no layout sub named: the main chat gets it");
        assert!(crate::daemon::subchats::back::peek_in(tmp.path(), "main").is_none(), "the main chat got the message itself");
        run_at(&path, &st, "main", &json!({"action": "layout", "slug": "page", "sub": "sub-b"}));
        send_at(&path, Some(tmp.path()), &st, &id, "shell", "denser", recorder(&sent)).await.unwrap();
        assert_eq!(sent.lock().unwrap()[1].0, "sub-b");
        let served = crate::daemon::subchats::back::peek_in(tmp.path(), "main").unwrap();
        assert!(served.text.contains("\"shell\" went to \"Layouter\""), "{}", served.text);
    }

    #[tokio::test]
    async fn an_unfilled_region_goes_to_the_main_chat() {
        let (tmp, path, st, id) = setup();
        let sent: Sent = Default::default();
        send_at(&path, Some(tmp.path()), &st, &id, "footer", "x", recorder(&sent)).await.unwrap();
        assert_eq!(sent.lock().unwrap()[0].0, "main");
    }

    #[tokio::test]
    async fn a_target_outside_the_family_an_unknown_region_and_an_empty_text_are_refused_and_send_nothing() {
        let (tmp, path, st, id) = setup();
        let sent: Sent = Default::default();
        assert!(send_at(&path, Some(tmp.path()), &st, &id, "nope", "x", recorder(&sent)).await.is_err());
        assert!(send_at(&path, Some(tmp.path()), &st, &id, "header", "   ", recorder(&sent)).await.is_err());
        assert!(send_at(&path, Some(tmp.path()), &st, "no-such-preview", "header", "x", recorder(&sent)).await.is_err());
        // The writer left the family (promoted out of the main chat).
        st.registry.set_subchat_of("sub-a", None);
        assert!(send_at(&path, Some(tmp.path()), &st, &id, "header", "x", recorder(&sent)).await.is_err());
        assert!(sent.lock().unwrap().is_empty());
        assert!(crate::daemon::subchats::back::peek_in(tmp.path(), "main").is_none());
    }

    #[tokio::test]
    async fn a_failed_delivery_queues_no_line() {
        let (tmp, path, st, id) = setup();
        let r = send_at(&path, Some(tmp.path()), &st, &id, "header", "x", |_s, _t| std::future::ready(Err(RpcError::internal("busy")))).await;
        assert!(r.is_err());
        assert!(crate::daemon::subchats::back::peek_in(tmp.path(), "main").is_none());
    }

    #[tokio::test]
    async fn an_ordinary_preview_is_refused() {
        let (tmp, path, st, _id) = setup();
        crate::daemon::preview::push_at(&path, "T".into(), Some("plain".into()), "<p></p>".into(), "chat".into(), Some("main".into())).unwrap();
        let plain = load_list(&path).into_iter().find(|s| s.slug == "plain").unwrap().id;
        let sent: Sent = Default::default();
        assert!(send_at(&path, Some(tmp.path()), &st, &plain, "header", "x", recorder(&sent)).await.is_err());
    }
}
