//! Linear's client: the GraphQL call, one issue's summary, and a workspace's
//! team keys (the id prefixes the renderer links).

use super::{http, token_for, TicketSummary, TrackerKind, CACHES};

pub(super) async fn linear_query(token: &str, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let resp = http()
        .post("https://api.linear.app/graphql")
        .header("Authorization", token)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Linear returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = body.pointer("/errors/0/message").and_then(|m| m.as_str()) {
        return Err(err.to_string());
    }
    Ok(body["data"].clone())
}

pub(super) async fn linear_team_keys(workspace: &str) -> Vec<String> {
    if let Some(keys) = CACHES.lock().unwrap().linear_keys.get(workspace) {
        return keys.clone();
    }
    let Ok(token) = token_for(TrackerKind::Linear) else { return vec![] };
    let Ok(data) = linear_query(&token, "{ teams { nodes { key } } }", serde_json::json!({})).await else {
        return vec![];
    };
    let keys: Vec<String> = data
        .pointer("/teams/nodes")
        .and_then(|n| n.as_array())
        .map(|a| a.iter().filter_map(|t| t["key"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    CACHES.lock().unwrap().linear_keys.insert(workspace.to_string(), keys.clone());
    keys
}

pub(super) fn linear_summary(issue: &serde_json::Value) -> Result<TicketSummary, String> {
    if issue.is_null() {
        return Err("no such issue".into());
    }
    let label = issue.pointer("/labels/nodes/0/name").and_then(|l| l.as_str());
    Ok(TicketSummary {
        id: issue["identifier"].as_str().unwrap_or_default().to_string(),
        title: issue["title"].as_str().unwrap_or_default().to_string(),
        state: issue.pointer("/state/name").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
        owner: issue.pointer("/assignee/name").and_then(|a| a.as_str()).map(str::to_string),
        ticket_type: label.unwrap_or("issue").to_string(),
        url: issue["url"].as_str().unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_issue_maps_and_a_missing_issue_errors() {
        let issue = serde_json::json!({
            "identifier": "MOB-12", "title": "Crash", "url": "https://linear.app/revaire/issue/MOB-12",
            "state": { "name": "Todo" }, "assignee": null, "labels": { "nodes": [{ "name": "Bug" }] }
        });
        let s = linear_summary(&issue).unwrap();
        assert_eq!((s.id.as_str(), s.state.as_str(), s.ticket_type.as_str()), ("MOB-12", "Todo", "Bug"));
        assert_eq!(s.owner, None);
        assert!(linear_summary(&serde_json::Value::Null).is_err());
    }
}
