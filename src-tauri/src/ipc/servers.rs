//! Lists the dev servers registered with the standalone `server_supervisor` app
//! (the sidecar that `/supervised-run` routes long-lived servers through) that
//! are currently running for a given project folder. Powers the statusbar
//! `servers` chip: a live count of this chat's running servers, each openable in
//! the browser. Fails open (empty vec) on any error - the supervisor is an
//! optional external app and must never break the statusbar.

use std::time::Duration;

/// One running dev server for the current project, as surfaced to the statusbar
/// `servers` chip.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ServerInfo {
    /// Supervisor entry id, e.g. `my-app:dev` - stable key for the row.
    pub id: String,
    /// Short process/command name, e.g. `dev`, `flutter run`.
    pub name: String,
    /// Localhost port it's listening on.
    pub port: u16,
}

/// Basename of a working-directory path, matching how the supervisor derives its
/// `project` field (and how the `folder` chip derives its label). Slash-agnostic.
fn folder_basename(cwd: &str) -> Option<String> {
    cwd.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .last()
        .map(|s| s.to_string())
}

/// Running servers whose supervisor `project` equals this cwd's folder name.
/// Empty vec when the supervisor is down/unreachable or nothing matches.
#[tauri::command]
pub async fn list_project_servers(cwd: String) -> Vec<ServerInfo> {
    list_project_servers_inner(cwd).await.unwrap_or_default()
}

async fn list_project_servers_inner(cwd: String) -> Option<Vec<ServerInfo>> {
    let project = folder_basename(&cwd)?;
    let (token, port) = crate::util::supervisor_client::supervisor_config()?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://127.0.0.1:{port}/procs"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let procs: serde_json::Value = resp.json().await.ok()?;

    let mut out = Vec::new();
    for p in procs.as_array()?.iter() {
        if p.get("project").and_then(|v| v.as_str()) != Some(project.as_str()) {
            continue;
        }
        if p.get("status").and_then(|v| v.as_str()) != Some("running") {
            continue;
        }
        let port = match p.get("port").and_then(|v| v.as_u64()) {
            Some(n) if n > 0 && n <= u16::MAX as u64 => n as u16,
            _ => continue,
        };
        let id = p
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = p
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("server")
            .to_string();
        out.push(ServerInfo { id, name, port });
    }
    Some(out)
}
