//! Shortcut's client: one story fetch, plus the workflow-state and member names a
//! story carries only as ids.

use super::{http, TicketSummary, CACHES};
use std::collections::HashMap;

pub(super) async fn shortcut_get(token: &str, path: &str) -> Result<serde_json::Value, String> {
    let resp = http()
        .get(format!("https://api.app.shortcut.com/api/v3/{path}"))
        .header("Shortcut-Token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Shortcut returned {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub(super) async fn shortcut_names(token: &str, workspace: &str) -> Result<(), String> {
    let have = {
        let c = CACHES.lock().unwrap();
        c.sc_states.contains_key(workspace) && c.sc_members.contains_key(workspace)
    };
    if have {
        return Ok(());
    }
    let workflows = shortcut_get(token, "workflows").await?;
    let members = shortcut_get(token, "members").await?;
    let states: HashMap<i64, String> = workflows
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|w| w["states"].as_array().cloned().unwrap_or_default())
        .filter_map(|s| Some((s["id"].as_i64()?, s["name"].as_str()?.to_string())))
        .collect();
    let people: HashMap<String, String> = members
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m["id"].as_str()?.to_string(), m.pointer("/profile/name")?.as_str()?.to_string())))
        .collect();
    let mut c = CACHES.lock().unwrap();
    c.sc_states.insert(workspace.to_string(), states);
    c.sc_members.insert(workspace.to_string(), people);
    Ok(())
}

pub(super) fn shortcut_summary(story: &serde_json::Value, workspace: &str) -> Result<TicketSummary, String> {
    let id = story["id"].as_i64().ok_or("story has no id")?;
    let c = CACHES.lock().unwrap();
    let state = story["workflow_state_id"]
        .as_i64()
        .and_then(|s| c.sc_states.get(workspace)?.get(&s).cloned())
        .unwrap_or_default();
    let owner = story["owner_ids"]
        .as_array()
        .and_then(|o| o.first()?.as_str())
        .and_then(|o| c.sc_members.get(workspace)?.get(o).cloned());
    Ok(TicketSummary {
        id: format!("sc-{id}"),
        title: story["name"].as_str().unwrap_or_default().to_string(),
        state,
        owner,
        ticket_type: story["story_type"].as_str().unwrap_or("story").to_string(),
        url: story["app_url"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://app.shortcut.com/{workspace}/story/{id}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_story_maps_state_and_owner_names_from_the_caches() {
        {
            let mut c = CACHES.lock().unwrap();
            c.sc_states.insert("ws-test".into(), HashMap::from([(7, "In Review".to_string())]));
            c.sc_members.insert("ws-test".into(), HashMap::from([("u1".to_string(), "Joe".to_string())]));
        }
        let story = serde_json::json!({
            "id": 55411, "name": "Fix DOB", "story_type": "bug", "workflow_state_id": 7,
            "owner_ids": ["u1"], "app_url": "https://app.shortcut.com/ws-test/story/55411"
        });
        let s = shortcut_summary(&story, "ws-test").unwrap();
        assert_eq!(s.id, "sc-55411");
        assert_eq!(s.state, "In Review");
        assert_eq!(s.owner.as_deref(), Some("Joe"));
        assert_eq!(s.ticket_type, "bug");
    }
}
