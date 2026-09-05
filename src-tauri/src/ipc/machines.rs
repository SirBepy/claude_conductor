//! Multi-machine pairing/management: thin app-side pass-throughs to the
//! daemon's `pair_machine`/`unpair_machine`/`set_machine_label`/
//! `list_machines` RPCs. Response shapes (`PeerMachineView`/`SelfMachine`)
//! aren't ts-rs exported - the frontend hand-types them, like `RemoteDevice`.

use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn pair_machine(url: String, my_url: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("pair_machine", serde_json::json!({ "url": url, "my_url": my_url }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpair_machine(machine_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("unpair_machine", serde_json::json!({ "machine_id": machine_id }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_machine_label(label: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("set_machine_label", serde_json::json!({ "label": label }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_machines(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("list_machines", Value::Null).await.map_err(|e| e.to_string())
}

/// New-chat picker's cross-machine project list: `machine_id` names the
/// machine to spawn on (self or a paired peer) - see the daemon's
/// `list_machine_projects` RPC doc for the forwarding shape.
#[tauri::command]
pub async fn list_machine_projects(machine_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("list_machine_projects", serde_json::json!({ "machine_id": machine_id }))
        .await
        .map_err(|e| e.to_string())
}
