//! Desktop pass-throughs for the new-chat picker's "add a project from
//! GitHub" row. The work (gh calls, clone, project registration) lives in the
//! daemon's `github_search_repos` / `github_clone_repo` RPCs, shared with the
//! phone; see `daemon/methods/github_repos.rs`.

use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn github_search_repos(query: String, scope: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("github_search_repos", serde_json::json!({ "query": query, "scope": scope }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_clone_repo(
    full_name: String,
    account: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call(
            "github_clone_repo",
            serde_json::json!({ "full_name": full_name, "account": account.unwrap_or_default() }),
        )
        .await
        .map_err(|e| e.to_string())
}
