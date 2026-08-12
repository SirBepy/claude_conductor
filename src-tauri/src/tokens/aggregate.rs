use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use std::path::Path;
use super::record::TokenRecord;

pub fn load_history(path: &Path) -> Vec<TokenRecord> {
    let Ok(raw) = std::fs::read_to_string(path) else { return vec![] };
    if raw.trim().is_empty() { return vec![] }
    let Ok(parsed) = serde_json::from_str::<Vec<TokenRecord>>(&raw) else { return vec![] };
    parsed.into_iter().filter(|r| !r.session_id.is_empty()).collect()
}

pub fn save_history(path: &Path, history: &[TokenRecord]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(history).context("serialising token history")?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Append a session to disk, idempotent on `session_id`. Returns the updated
/// list so callers can emit it to the webview.
pub fn append_session(path: &Path, mut record: TokenRecord) -> Result<Vec<TokenRecord>> {
    let mut history = load_history(path);
    if history.iter().any(|r| r.session_id == record.session_id) {
        return Ok(history);
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if record.started_at.is_empty() { record.started_at = now.clone() }
    if record.last_active_at.is_empty() { record.last_active_at = now.clone() }
    if record.recorded_at.is_empty() { record.recorded_at = now }
    history.push(record);
    save_history(path, &history)?;
    Ok(history)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::record::TokenRecord;
    use tempfile::tempdir;

    #[test]
    fn load_save_history_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("token-history.json");
        let rec = TokenRecord {
            session_id: "S1".into(),
            cwd: Some("C:\\proj".into()),
            date: "2026-04-20".into(),
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_creation_tokens: 4,
            turns: 5,
            started_at: "2026-04-20T10:00:00Z".into(),
            last_active_at: "2026-04-20T10:30:00Z".into(),
            recorded_at: "2026-04-20T10:31:00Z".into(),
            live: None,
            merged_subagents: None,
            kind: None,
        };
        save_history(&path, std::slice::from_ref(&rec)).unwrap();
        let back = load_history(&path);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].session_id, "S1");
        assert_eq!(back[0].turns, 5);
    }

    #[test]
    fn load_history_returns_empty_for_missing_or_corrupt() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert!(load_history(&missing).is_empty());

        let corrupt = dir.path().join("c.json");
        std::fs::write(&corrupt, "{ this is not valid json").unwrap();
        assert!(load_history(&corrupt).is_empty());
    }

    #[test]
    fn append_session_is_idempotent_on_session_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("h.json");
        let rec = TokenRecord {
            session_id: "S1".into(),
            date: "2026-04-20".into(),
            input_tokens: 1,
            ..Default::default()
        };
        append_session(&path, rec.clone()).unwrap();
        append_session(&path, rec.clone()).unwrap();
        let h = load_history(&path);
        assert_eq!(h.len(), 1, "duplicate append should be a no-op");
    }
}
