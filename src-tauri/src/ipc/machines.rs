//! Multi-machine pairing/management: thin app-side pass-throughs to the
//! daemon's `pair_machine`/`unpair_machine`/`set_machine_label`/
//! `list_machines` RPCs. Response shapes (`PeerMachineView`/`SelfMachine`)
//! aren't ts-rs exported - the frontend hand-types them, like `RemoteDevice`.

use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn pair_machine(url: String, my_url: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("pair_machine", serde_json::json!({ "url": url, "my_url": my_url }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpair_machine(machine_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("unpair_machine", serde_json::json!({ "machine_id": machine_id }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_machine_label(label: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("set_machine_label", serde_json::json!({ "label": label }))
        .await
        .map_err(|e| e.to_string())
}

/// Desktop-only: names a paired peer on this machine only (`rename_machine`).
#[tauri::command]
pub async fn rename_machine(machine_id: String, label: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("rename_machine", serde_json::json!({ "machine_id": machine_id, "label": label }))
        .await
        .map_err(|e| e.to_string())
}

/// Desktop-only: limits (or restores) what `machine_id` may do to this
/// machine's chats - see `daemon::machines::peer_scope`.
#[tauri::command]
pub async fn set_machine_can_drive(machine_id: String, value: bool, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("set_machine_can_drive", serde_json::json!({ "machine_id": machine_id, "value": value }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_machines(state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("list_machines", Value::Null).await.map_err(|e| e.to_string())
}

/// New-chat picker's cross-machine project list: `machine_id` names the
/// machine to spawn on (self or a paired peer) - see the daemon's
/// `list_machine_projects` RPC doc for the forwarding shape.
#[tauri::command]
pub async fn list_machine_projects(machine_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("list_machine_projects", serde_json::json!({ "machine_id": machine_id }))
        .await
        .map_err(|e| e.to_string())
}

/// New-chat picker's account step for a chat aimed at `machine_id`: that
/// machine's accounts (display fields only), its default account id and its
/// binding for `cwd`. See the daemon's `list_machine_accounts` RPC.
#[tauri::command]
pub async fn list_machine_accounts(
    machine_id: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("list_machine_accounts", serde_json::json!({ "machine_id": machine_id, "cwd": cwd }))
        .await
        .map_err(|e| e.to_string())
}

/// Saves a picked account as `machine_id`'s own binding for the project at
/// `cwd` (a peer only; this machine's bindings use `update_project`).
#[tauri::command]
pub async fn set_machine_project_account(
    machine_id: String,
    cwd: String,
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call(
            "set_machine_project_account",
            serde_json::json!({ "machine_id": machine_id, "cwd": cwd, "account_id": account_id }),
        )
        .await
        .map_err(|e| e.to_string())
}
