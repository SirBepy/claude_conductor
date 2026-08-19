//! Actuation: the only part of the protocol that talks to the daemon client and
//! mutates other sessions (auto-resolving their prompts, injecting `/close`).

use super::idle::log_comment;
use crate::state::AppState;
use tauri::{AppHandle, Manager};

/// Auto-resolve every pending prompt: allow permissions as-is, answer questions
/// with the first/default option. Logs each auto-answer to COMMENTS_FOR_BEPY.md.
pub(super) async fn auto_resolve_prompts(app: &AppHandle) {
    let state = app.state::<AppState>();
    let prompts = {
        let guard = state.daemon_client.lock().await;
        match guard.as_ref() {
            Some(c) => c.list_pending_prompts().await.ok(),
            None => None,
        }
    };
    let Some(prompts) = prompts else { return };
    let Some(arr) = prompts.as_array() else { return };

    for p in arr {
        let event = p.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match p.get("payload") {
            Some(v) => v,
            None => continue,
        };
        let request_id = match payload.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let guard = state.daemon_client.lock().await;
        let Some(client) = guard.as_ref() else { return };

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
                    .respond_permission(&request_id, true, Some(input), None)
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
                if let Err(e) = client.respond_question(&request_id, answers.clone(), false).await {
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

/// Inject `/close` into a single session via the daemon.
pub(super) async fn inject_close(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<AppState>();
    let guard = state.daemon_client.lock().await;
    let Some(client) = guard.as_ref() else {
        return false;
    };
    match client.send_message(session_id, "/close").await {
        Ok(()) => true,
        Err(e) => {
            log::warn!("when_done: send /close to {session_id} failed: {e}");
            false
        }
    }
}
