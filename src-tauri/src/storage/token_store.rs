//! CRUD for the `token_records` table.
//!
//! The index `timestamp` is derived from `TokenRecord::recorded_at` (RFC3339)
//! parsed to unix seconds; the full record is stored as a JSON blob.

use anyhow::Result;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

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

/// Writes each `records` entry whose `session_id` is in `dirty`, replacing that
/// session's row. Scoped to `dirty` because the daemon's Stop hook writes this
/// table concurrently: a wholesale rewrite would drop rows landed since the read.
pub fn upsert_records(
    conn: &mut Connection,
    records: &[TokenRecord],
    dirty: &HashSet<String>,
) -> Result<usize> {
    if dirty.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let mut written = 0usize;
    {
        let mut del = tx.prepare("DELETE FROM token_records WHERE data LIKE ?1")?;
        let mut ins = tx.prepare("INSERT INTO token_records (timestamp, data) VALUES (?1, ?2)")?;
        for record in records.iter().filter(|r| dirty.contains(&r.session_id)) {
            del.execute(rusqlite::params![like_pattern(&record.session_id)])?;
            let ts = rfc3339_to_unix(&record.recorded_at)?;
            let data = serde_json::to_string(record)?;
            ins.execute(rusqlite::params![ts, data])?;
            written += 1;
        }
    }
    tx.commit()?;
    Ok(written)
}

/// Total tokens across all four counters - the ranking key `dedupe_records`
/// uses to pick which duplicate row to keep.
fn total_tokens(r: &TokenRecord) -> u128 {
    r.input_tokens as u128
        + r.output_tokens as u128
        + r.cache_read_tokens as u128
        + r.cache_creation_tokens as u128
}

/// Collapses the table to one row per `session_id`, keeping the highest
/// [`total_tokens`]. Highest-total, not newest: a transcript can grow between
/// writes, so the fullest duplicate is the true record. Ties keep the lowest
/// rowid, so repeat runs are stable no-ops.
pub fn dedupe_records(conn: &mut Connection) -> Result<usize> {
    let mut best: HashMap<String, (i64, u128)> = HashMap::new();
    let mut losers: Vec<i64> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT rowid, data FROM token_records")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            let data: String = row.get(1)?;
            // An unparseable blob can't be ranked, so leave it rather than guess.
            let Ok(record) = serde_json::from_str::<TokenRecord>(&data) else { continue };
            let total = total_tokens(&record);
            match best.get(&record.session_id) {
                Some(&(_, prev_total)) if prev_total >= total => losers.push(rowid),
                Some(&(prev_rowid, _)) => {
                    losers.push(prev_rowid);
                    best.insert(record.session_id, (rowid, total));
                }
                None => {
                    best.insert(record.session_id, (rowid, total));
                }
            }
        }
    }
    if losers.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    {
        let mut del = tx.prepare("DELETE FROM token_records WHERE rowid = ?1")?;
        for rowid in &losers {
            del.execute(rusqlite::params![rowid])?;
        }
    }
    tx.commit()?;
    Ok(losers.len())
}

/// Cheap existence check, without deserializing the table (records are
/// one-per-session JSON blobs, no dedicated column).
pub fn token_record_exists(conn: &Connection, session_id: &str) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT 1 FROM token_records WHERE data LIKE ?1 LIMIT 1")?;
    Ok(stmt.exists(rusqlite::params![like_pattern(session_id)])?)
}

/// LIKE pattern matching one session's blob. Key on disk is `sessionId`
/// (`TokenRecord`'s `#[serde(rename_all = "camelCase")]`), not `session_id`.
fn like_pattern(session_id: &str) -> String {
    format!("%\"sessionId\":\"{session_id}\"%")
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
            kind: None,
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
    fn dedupe_keeps_the_highest_token_total_per_session() {
        let mut conn = test_conn();
        let mut small = record("sess-1");
        small.input_tokens = 10;
        let mut big = record("sess-1");
        big.input_tokens = 999;
        let mut mid = record("sess-1");
        mid.input_tokens = 100;
        // Highest sits in the middle, so neither "first" nor "last" passes by luck.
        insert_token_record(&conn, &small).unwrap();
        insert_token_record(&conn, &big).unwrap();
        insert_token_record(&conn, &mid).unwrap();
        insert_token_record(&conn, &record("sess-2")).unwrap();

        assert_eq!(dedupe_records(&mut conn).unwrap(), 2);

        let left = get_token_records(&conn, 0).unwrap();
        assert_eq!(left.len(), 2);
        let kept = left.iter().find(|r| r.session_id == "sess-1").unwrap();
        assert_eq!(kept.input_tokens, 999);
        assert!(left.iter().any(|r| r.session_id == "sess-2"));
    }

    #[test]
    fn dedupe_is_a_stable_no_op_on_an_already_clean_table() {
        let mut conn = test_conn();
        insert_token_record(&conn, &record("sess-1")).unwrap();
        insert_token_record(&conn, &record("sess-2")).unwrap();

        assert_eq!(dedupe_records(&mut conn).unwrap(), 0);
        // Identical totals must not ping-pong between rows on repeat runs.
        insert_token_record(&conn, &record("sess-1")).unwrap();
        assert_eq!(dedupe_records(&mut conn).unwrap(), 1);
        assert_eq!(dedupe_records(&mut conn).unwrap(), 0);
        assert_eq!(get_token_records(&conn, 0).unwrap().len(), 2);
    }

    #[test]
    fn exists_does_not_match_a_different_session() {
        let conn = test_conn();
        insert_token_record(&conn, &record("sess-1")).unwrap();
        assert!(!token_record_exists(&conn, "sess-12").unwrap());
        assert!(!token_record_exists(&conn, "sess-").unwrap());
    }
}
