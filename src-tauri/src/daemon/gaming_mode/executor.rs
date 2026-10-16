//! `RealExecutor`: the only production [`super::GamingModeExecutor`]. Every
//! method here is a real external call (HTTP to server_supervisor, a
//! `docker` subprocess, or a real scheduled-items write) - never constructed
//! by a test; `FakeExecutor` (in `super::tests`) stands in for it there.

use super::{GamingModeExecutor, SupervisorProc};
use crate::sessions::scheduled_items::{ScheduledItem, ScheduledKind};

pub struct RealExecutor;

impl RealExecutor {
    fn supervisor_registry_root(project_id: &str) -> Option<String> {
        let dir = crate::util::supervisor_client::supervisor_dir()?;
        let raw = std::fs::read_to_string(dir.join("projects.json")).ok()?;
        let list: serde_json::Value = serde_json::from_str(&raw).ok()?;
        list.as_array()?.iter().find_map(|p| {
            if p.get("id").and_then(|v| v.as_str()) == Some(project_id) {
                p.get("root").and_then(|v| v.as_str()).map(str::to_string)
            } else {
                None
            }
        })
    }

    fn hidden_command(program: &str, args: &[&str]) -> std::process::Command {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args);
        crate::util::process::hide_console(&mut cmd);
        cmd
    }
}

impl GamingModeExecutor for RealExecutor {
    fn supervisor_procs(&self) -> Result<Vec<SupervisorProc>, String> {
        let (token, port) = crate::util::supervisor_client::supervisor_config()
            .ok_or("server_supervisor not running (no token/port)")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(format!("http://127.0.0.1:{port}/procs"))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        let procs: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let arr = procs.as_array().ok_or("unexpected /procs response shape")?;
        Ok(arr
            .iter()
            .filter_map(|p| {
                let id = p.get("id").and_then(|v| v.as_str())?.to_string();
                let status = p.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let project_id = id.split_once(':').map(|(a, _)| a).unwrap_or(&id);
                let root = Self::supervisor_registry_root(project_id);
                Some(SupervisorProc { id, root, status })
            })
            .collect())
    }

    fn supervisor_stop(&self, id: &str) -> Result<(), String> {
        let (token, port) = crate::util::supervisor_client::supervisor_config().ok_or("server_supervisor not running")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .post(format!("http://127.0.0.1:{port}/procs/{id}/stop"))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn supervisor_start(&self, id: &str) -> Result<(), String> {
        let (token, port) = crate::util::supervisor_client::supervisor_config().ok_or("server_supervisor not running")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .post(format!("http://127.0.0.1:{port}/procs/{id}/start"))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn docker_running_containers(&self) -> Result<Vec<String>, String> {
        let out = Self::hidden_command("docker", &["ps", "-q"]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
    }

    fn docker_stop(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut args = vec!["stop"];
        args.extend(ids.iter().map(String::as_str));
        let out = Self::hidden_command("docker", &args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(())
    }

    fn docker_start(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut args = vec!["start"];
        args.extend(ids.iter().map(String::as_str));
        let out = Self::hidden_command("docker", &args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(())
    }

    fn docker_desktop_running(&self) -> bool {
        Self::hidden_command("docker", &["info"]).output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn docker_desktop_stop(&self) {
        let _ = Self::hidden_command("docker", &["desktop", "stop"]).output();
    }

    fn docker_desktop_start(&self) {
        let _ = Self::hidden_command("docker", &["desktop", "start"]).output();
    }

    fn queue_message(&self, session_id: &str, cwd: &str, prompt: &str) {
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: session_id.to_string(), cwd: cwd.to_string() },
            prompt.to_string(),
            chrono::Utc::now().to_rfc3339(),
            None,
        );
        crate::sessions::scheduled_items::upsert(item);
    }
}
