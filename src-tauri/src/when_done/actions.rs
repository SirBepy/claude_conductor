//! Actuation: the only part of the protocol that talks to the daemon client and
//! mutates other sessions (auto-resolving their prompts).

use super::idle::log_comment;
use crate::state::AppState;
use std::collections::HashSet;
use tauri::{AppHandle, Manager};

/// Auto-resolve every pending prompt in an armed session: allow permissions
/// as-is, answer questions with the first/default option. Logs each
/// auto-answer to COMMENTS_FOR_BEPY.md. `armed` is the set of sessions busy
/// when when-done was armed; a prompt from any other chat stays pending.
pub(super) async fn auto_resolve_prompts(app: &AppHandle, armed: &HashSet<String>) {
    let state = app.state::<AppState>();
    let prompts = match state.client().await {
        Some(c) => c.list_pending_prompts().await.ok(),
        None => None,
    };
    let Some(prompts) = prompts else { return };
    let Some(arr) = prompts.as_array() else { return };

    // Clone once outside the loop (todo 1006) - reused for every prompt so
    // the outer mutex isn't reacquired per iteration.
    let Some(client) = state.client().await else { return };
    let instances = state.cached_instances.lock().unwrap().clone();

    for p in arr {
        let event = p.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match p.get("payload") {
            Some(v) => v,
            None => continue,
        };
        // `list_pending_prompts` also returns prompts mirrored from a paired
        // peer. This machine going to sleep never blocks on those, and
        // auto-approving another machine's permission prompt is not ours to do.
        if is_mirrored_prompt(&instances, payload) || !prompt_in_armed_scope(armed, payload) {
            continue;
        }
        let request_id = match payload.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };

        match event {
            "permission-requested" => {
                // Approve as-is: hand back the original tool input as updatedInput.
                let input = payload
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let tool = payload
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                if let Err(e) = client
                    .respond_permission(&request_id, true, Some(input), None, None)
                    .await
                {
                    log::warn!("when_done: auto-allow permission failed: {e}");
                } else {
                    log_comment(&format!(
                        "[when-done] auto-approved permission for tool '{tool}' (id {request_id})"
                    ));
                }
            }
            "question-requested" => {
                let questions = payload.get("questions");
                let answers = default_question_answers(questions);
                // Marked as the machine's answer: a sub's question it answers is
                // announced in the main chat, and is no decision of Joe's.
                if let Err(e) = client.respond_question_for_when_done(&request_id, answers.clone()).await {
                    log::warn!("when_done: auto-answer question failed: {e}");
                } else {
                    log_comment(&format!(
                        "[when-done] auto-answered question with default option(s) (id {request_id})"
                    ));
                }
            }
            _ => {}
        }
    }
}

/// Whether a pending prompt belongs to a session that was busy at arm time.
/// Arming means "approve what these running chats need to finish"; a chat
/// that was idle then (or a prompt with no session id) never gets a blind
/// approval, since nobody chose to let it run unattended.
pub(super) fn prompt_in_armed_scope(armed: &HashSet<String>, payload: &serde_json::Value) -> bool {
    // A card the daemon raised (a ceiling, a stuck sub, a close approval, an
    // undelivered message) carries the main chat's id, so it would pass the check
    // below. Its first option is not a harmless default ("Keep going" raises a
    // ceiling), and Joe is the one who decides those.
    if payload.get("daemon_card").and_then(|v| v.as_bool()) == Some(true) {
        return false;
    }
    payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .is_some_and(|sid| armed.contains(sid))
}

/// Whether a pending prompt's payload belongs to a session mirrored from a
/// paired peer, per the cached instance list.
pub(super) fn is_mirrored_prompt(instances: &[crate::types::Instance], payload: &serde_json::Value) -> bool {
    payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .is_some_and(|sid| crate::ipc::chat::history::is_mirrored(instances, sid))
}

/// Build the `{ question_text: first_option_label }` answers map for a question
/// payload. Mirrors what the frontend posts to `respond_question`.
pub(super) fn default_question_answers(questions: Option<&serde_json::Value>) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(arr) = questions.and_then(|q| q.as_array()) {
        for q in arr {
            let qtext = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
            if qtext.is_empty() {
                continue;
            }
            let first_label = q
                .get("options")
                .and_then(|o| o.as_array())
                .and_then(|opts| opts.first())
                .and_then(|opt| opt.get("label"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            map.insert(qtext.to_string(), serde_json::Value::String(first_label.to_string()));
        }
    }
    serde_json::Value::Object(map)
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
