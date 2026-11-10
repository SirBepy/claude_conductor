//! Desktop IPC mirror for the chat dashboard's Answers card RPCs
//! (`daemon/methods/answers.rs`), same thin-wrapper pattern as `ipc/step_comments.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn answers_state(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("answers_state", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn answers_mark(
    session_id: String,
    keys: Vec<String>,
    read: bool,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("answers_mark", json!({"session_id": session_id, "keys": keys, "read": read}))
        .await
        .map_err(|e| e.to_string())
}

/// Blocks for one cheap model call that writes the short question for an answer
/// whose `send_message` carried none (the daemon stores it once per answer).
#[tauri::command]
pub async fn answers_rewrite_question(
    session_id: String,
    key: String,
    joe: String,
    answer: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("answers_rewrite_question", json!({"session_id": session_id, "key": key, "joe": joe, "answer": answer}))
        .await
        .map_err(|e| e.to_string())
}

/// Blocks for the Ask sidecar's whole run (seconds, not milliseconds).
#[tauri::command]
pub async fn answers_thread_send(
    session_id: String,
    key: Option<String>,
    question: String,
    cwd: Option<String>,
    about_question: Option<String>,
    about_answer: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call(
            "answers_thread_send",
            json!({
                "session_id": session_id,
                "key": key,
                "question": question,
                "cwd": cwd,
                "about_question": about_question.unwrap_or_default(),
                "about_answer": about_answer.unwrap_or_default(),
            }),
        )
        .await
        .map_err(|e| e.to_string())
}
