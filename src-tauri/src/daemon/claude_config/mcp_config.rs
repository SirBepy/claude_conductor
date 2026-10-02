//! MCP config writing: the per-turn `.mcp.json` handed to `claude` via
//! `--mcp-config`.

use std::path::PathBuf;

/// Write a temporary .mcp.json file for the given turn and return its path.
/// Returns None if the app-data dir is unavailable (non-fatal; permission
/// relay simply won't be wired up for this turn).
///
/// `is_jarvis` adds `CC_JARVIS=1` to the spawned MCP child's env IFF this
/// turn belongs to the Jarvis singleton session (todo 272, chunk 2b) - that
/// var is what `mcp::server::run_stdio` reads to decide whether to advertise
/// the fleet-orchestration tools (`spawn_worker`/`send_to_session`/
/// `fleet_status`/`respond_worker_prompt`) in `tools/list`. A normal
/// session's config is byte-identical to before this var existed.
pub(crate) fn write_mcp_config(
    turn_id: &str,
    tracking_id: &str,
    is_jarvis: bool,
    connectors: serde_json::Map<String, serde_json::Value>,
) -> Option<PathBuf> {
    match write_mcp_config_inner(turn_id, tracking_id, is_jarvis, connectors) {
        Ok(path) => {
            log::info!(
                "daemon: turn {turn_id} (session {tracking_id}) wrote mcp config to {}",
                path.display()
            );
            Some(path)
        }
        Err(reason) => {
            log::warn!(
                "daemon: turn {turn_id} (session {tracking_id}) could not write mcp config: \
                 {reason}; claude will register zero MCP tools this turn (todo 907)"
            );
            None
        }
    }
}

fn write_mcp_config_inner(
    turn_id: &str,
    tracking_id: &str,
    is_jarvis: bool,
    connectors: serde_json::Map<String, serde_json::Value>,
) -> Result<PathBuf, String> {
    let mcp_dir = crate::settings::paths::mcp_temp_dir()
        .map_err(|e| format!("mcp_temp_dir unavailable: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| format!("current_exe unavailable: {e}"))?;
    let mut env = serde_json::json!({"CC_SESSION_ID": tracking_id});
    if is_jarvis {
        env["CC_JARVIS"] = serde_json::json!("1");
    }
    // Floors Claude Code's own client-side MCP idle timeout (default 1800s for
    // stdio servers) at this relay's window so the CLI doesn't abort a pending
    // AUQ/permission card early. See mcp::server::RELAY_TIMEOUT_SECS.
    // Requires Claude Code v2.1.203+; older clients ignore the unknown field.
    let mut servers = connectors;
    servers.insert(
        "cc_conductor".into(),
        serde_json::json!({
            "command": exe.to_string_lossy(),
            "args": ["--mcp-permission"],
            "env": env,
            "timeout": 3_660_000_u64
        }),
    );
    let config = serde_json::json!({ "mcpServers": servers });
    let path = mcp_dir.join(format!("{turn_id}.json"));
    let body = serde_json::to_string(&config).map_err(|e| format!("serialize failed: {e}"))?;
    // Atomic tmp-then-rename: this file is handed straight to `claude` as
    // `--mcp-config`, and a torn write here is todo 907's failure mode (claude
    // dies on its first permission check with no useful stderr).
    crate::util::write_json_atomic(&path, &body)
        .map_err(|e| format!("write to {} failed: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Todo 907: this is the write whose silent failure meant `claude` was
    /// spawned with `--permission-prompt-tool` naming a tool no MCP server
    /// ever registered, dying on the first permission check with only a
    /// `claude stderr` line to explain why. Proves the happy path produces a
    /// well-formed, parseable config with the fields `claude` actually reads
    /// (`command`/`args`/`env`) - a regression here would reproduce exactly
    /// that failure shape.
    #[test]
    fn write_mcp_config_produces_a_parseable_server_entry() {
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", dir.path());

        let path = write_mcp_config("turn-1", "sess-1", false, Default::default()).expect("write must succeed");
        std::env::remove_var("CC_DATA_DIR");

        let raw = std::fs::read_to_string(&path).expect("config file must exist on disk");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("must be valid JSON");
        let server = &parsed["mcpServers"]["cc_conductor"];
        assert!(server["command"].as_str().unwrap_or("").len() > 0, "command must be set");
        assert_eq!(server["args"], serde_json::json!(["--mcp-permission"]));
        assert_eq!(server["env"]["CC_SESSION_ID"], serde_json::json!("sess-1"));
        assert!(server["env"].get("CC_JARVIS").is_none(), "non-jarvis session must not set CC_JARVIS");
        // write_json_atomic must have renamed its tmp sibling away.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn write_mcp_config_sets_cc_jarvis_for_the_jarvis_session() {
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", dir.path());

        let path = write_mcp_config("turn-2", "sess-2", true, Default::default()).expect("write must succeed");
        std::env::remove_var("CC_DATA_DIR");

        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["mcpServers"]["cc_conductor"]["env"]["CC_JARVIS"], serde_json::json!("1"));
    }

    #[test]
    fn write_mcp_config_keeps_cc_conductor_beside_connector_entries() {
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", dir.path());

        let mut connectors = serde_json::Map::new();
        connectors.insert(
            "claude_ai_Google_Drive".into(),
            serde_json::json!({"type": "claudeai-proxy", "url": "https://d.example", "id": "mcpsrv_a"}),
        );
        let path = write_mcp_config("turn-3", "sess-3", false, connectors).expect("write must succeed");
        std::env::remove_var("CC_DATA_DIR");

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["cc_conductor"]["args"], serde_json::json!(["--mcp-permission"]));
        assert_eq!(parsed["mcpServers"]["claude_ai_Google_Drive"]["type"], serde_json::json!("claudeai-proxy"));
    }
}
