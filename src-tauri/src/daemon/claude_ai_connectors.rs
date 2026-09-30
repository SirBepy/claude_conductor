//! The account's claude.ai connectors (Google Drive, Claude Docs, ...) as
//! `--mcp-config` entries, for projects with `claude_ai_connectors` on.
//!
//! Chats run `--strict-mcp-config`, which drops claude.ai connectors along
//! with the local user-scope servers. The CLI still honours a
//! `claudeai-proxy` entry passed explicitly in `--mcp-config` (verified
//! 2026-09-30 against CLI 2.1.278: a strict-mode `claude -p` listed the 11
//! Google Drive tools as connected), so re-adding just these keeps figma /
//! mobbin, whose failed auth took MCP init down in todo 867, out.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LIST_URL: &str = "https://api.anthropic.com/v1/mcp_servers?limit=1000";
// The beta the CLI itself sends for this endpoint (grep -a of claude.exe).
const LIST_BETA: &str = "mcp-servers-2025-12-04,oauth-2025-04-20";
// A process spawns per turn, so without a cache every turn pays a round trip.
const CACHE_TTL: Duration = Duration::from_secs(600);

static CACHE: Mutex<Option<HashMap<PathBuf, (Instant, Map<String, Value>)>>> = Mutex::new(None);

/// Server entries for the account whose profile lives at `config_dir`. Any
/// failure returns an empty map: a missing connector must never block a
/// spawn, and the failure is not cached so the next turn retries.
pub(crate) async fn servers_for(config_dir: &Path) -> Map<String, Value> {
    if let Some((at, servers)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(config_dir)) {
        if at.elapsed() < CACHE_TTL {
            return servers.clone();
        }
    }
    match fetch(config_dir).await {
        Ok(servers) => {
            CACHE
                .lock()
                .unwrap()
                .get_or_insert_with(HashMap::new)
                .insert(config_dir.to_path_buf(), (Instant::now(), servers.clone()));
            servers
        }
        Err(e) => {
            log::warn!("daemon: claude.ai connectors unavailable this turn: {e}");
            Map::new()
        }
    }
}

async fn fetch(config_dir: &Path) -> anyhow::Result<Map<String, Value>> {
    let token = crate::accounts::identity::read_access_token(config_dir)
        .ok_or_else(|| anyhow::anyhow!("no OAuth token in credentials"))?;
    let body: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?
        .get(LIST_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", LIST_BETA)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(to_servers(&body))
}

/// Keys match the CLI's own naming (`claude_ai_Google_Drive`), so tool names
/// come out as the `mcp__claude_ai_Google_Drive__*` that skills expect.
fn to_servers(body: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(items) = body.get("data").and_then(Value::as_array) else { return out };
    for item in items {
        if item.get("eligible").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let (Some(id), Some(url), Some(name)) = (
            item.get("id").and_then(Value::as_str),
            item.get("url").and_then(Value::as_str),
            item.get("display_name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let key: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        out.insert(
            format!("claude_ai_{key}"),
            json!({"type": "claudeai-proxy", "url": url, "id": id}),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_eligible_connectors_to_proxy_entries_named_like_the_cli() {
        let body = json!({"data": [
            {"id": "mcpsrv_a", "display_name": "Google Drive", "url": "https://drive.example/mcp", "eligible": true},
            {"id": "mcpsrv_b", "display_name": "Not Connected", "url": "https://x.example/mcp", "eligible": false},
            {"id": "mcpsrv_c", "display_name": "Missing Url", "eligible": true}
        ]});
        let servers = to_servers(&body);
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers["claude_ai_Google_Drive"],
            json!({"type": "claudeai-proxy", "url": "https://drive.example/mcp", "id": "mcpsrv_a"})
        );
    }

    #[test]
    fn a_malformed_body_yields_no_servers() {
        assert!(to_servers(&json!({"error": "nope"})).is_empty());
    }
}
