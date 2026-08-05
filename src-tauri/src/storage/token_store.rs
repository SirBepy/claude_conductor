//! CRUD for the `token_records` table.
//!
//! The index `timestamp` is derived from `TokenRecord::recorded_at` (RFC3339)
//! parsed to unix seconds; the full record is stored as a JSON blob.

use anyhow::Result;
use rusqlite::Connection;

use super::usage_store::rfc3339_to_unix;
use crate::tokens::record::TokenRecord;

/// Inserts one token record. The `timestamp` column comes from `recorded_at`.
pub fn insert_token_record(conn: &Connection, record: &TokenRecord) -> Result<()> {
    let ts = rfc3339_to_unix(&record.recorded_at)?;
    let data = serde_json::to_string(record)?;
    conn.execute(
        "INSERT INTO token_records (timestamp, data) VALUES (?1, ?2)",
        rusqlite::params![ts, data],
    )?;
    Ok(())
}

/// Returns token records with `timestamp >= since` (unix seconds), newest first.
pub fn get_token_records(conn: &Connection, since: i64) -> Result<Vec<TokenRecord>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM token_records WHERE timestamp >= ?1 ORDER BY timestamp DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![since], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<TokenRecord>(&data?)?);
    }
    Ok(out)
}

/// Cheap existence check for a `session_id`, without deserializing the table
/// (records are one-per-session JSON blobs, no dedicated column). Key on
/// disk is `sessionId` (`TokenRecord`'s `#[serde(rename_all = "camelCase")]`),
/// not `session_id`.
pub fn token_record_exists(conn: &Connection, session_id: &str) -> Result<bool> {
    let pattern = format!("%\"sessionId\":\"{session_id}\"%");
    let mut stmt = conn.prepare("SELECT 1 FROM token_records WHERE data LIKE ?1 LIMIT 1")?;
    Ok(stmt.exists(rusqlite::params![pattern])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::init_schema;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn record(session_id: &str) -> TokenRecord {
        TokenRecord {
            session_id: session_id.into(),
            cwd: None,
            date: "2026-08-05".into(),
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            turns: 1,
            started_at: "2026-08-05T00:00:00Z".into(),
            last_active_at: "2026-08-05T00:00:00Z".into(),
            recorded_at: "2026-08-05T00:00:00Z".into(),
            live: None,
            merged_subagents: None,
        }
    }

    #[test]
    fn exists_is_false_until_inserted() {
        let conn = test_conn();
        assert!(!token_record_exists(&conn, "sess-1").unwrap());
        insert_token_record(&conn, &record("sess-1")).unwrap();
        assert!(token_record_exists(&conn, "sess-1").unwrap());
    }

    #[test]
    fn exists_does_not_match_a_different_session() {
        let conn = test_conn();
        insert_token_record(&conn, &record("sess-1")).unwrap();
        assert!(!token_record_exists(&conn, "sess-12").unwrap());
        assert!(!token_record_exists(&conn, "sess-").unwrap());
    }
}
