//! CRUD for the `skipped_questions` table.
//!
//! A Skip never reaches Claude's transcript JSONL, so this table is its only
//! durable trace. `timestamp` is unix ms, matching `chat::parser`'s events.

use anyhow::Result;
use rusqlite::Connection;

/// One recorded skip. `question_id` is the dismissed card's tool_use id, NULL
/// on pre-v4 rows - the frontend falls back to the timestamp heuristic there,
/// which mis-attributes once two cards are open at once.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SkipMark {
    pub timestamp: i64,
    pub question_id: Option<String>,
}

/// Records one skip for `session_id` at `timestamp` (unix ms).
pub fn insert_skip(
    conn: &Connection,
    session_id: &str,
    timestamp: i64,
    question_id: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO skipped_questions (session_id, timestamp, question_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![session_id, timestamp, question_id],
    )?;
    Ok(())
}

/// Skip marks for one session, oldest first. An unknown session id is not
/// an error - it returns an empty vec, same as a session that never skipped.
pub fn get_skips(conn: &Connection, session_id: &str) -> Result<Vec<SkipMark>> {
    let mut stmt = conn.prepare(
        "SELECT timestamp, question_id FROM skipped_questions WHERE session_id = ?1 ORDER BY timestamp ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SkipMark { timestamp: row.get(0)?, question_id: row.get(1)? })
    })?;
    let mut out = Vec::new();
    for mark in rows {
        out.push(mark?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageManager;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::db::init_schema(&conn).unwrap();
        crate::storage::db::run_migrations(&conn).unwrap();
        conn
    }

    fn stamps(marks: &[SkipMark]) -> Vec<i64> {
        marks.iter().map(|m| m.timestamp).collect()
    }

    #[test]
    fn skip_is_recorded_and_survives_a_store_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.db");
        {
            let mgr = StorageManager::open(&path).unwrap();
            insert_skip(mgr.conn(), "sess-a", 1_700_000_000_000, Some("q-1")).unwrap();
            insert_skip(mgr.conn(), "sess-a", 1_700_000_005_000, Some("q-2")).unwrap();
        }
        let reopened = StorageManager::open(&path).unwrap();
        let marks = get_skips(reopened.conn(), "sess-a").unwrap();
        assert_eq!(stamps(&marks), vec![1_700_000_000_000, 1_700_000_005_000]);
        assert_eq!(
            marks.iter().map(|m| m.question_id.as_deref()).collect::<Vec<_>>(),
            vec![Some("q-1"), Some("q-2")],
        );
    }

    #[test]
    fn a_session_with_no_skip_record_reads_empty() {
        let conn = mem();
        insert_skip(&conn, "sess-a", 1_700_000_000_000, Some("q-1")).unwrap();
        assert!(get_skips(&conn, "sess-b").unwrap().is_empty());
    }

    #[test]
    fn an_unknown_session_id_does_not_panic() {
        let conn = mem();
        assert!(get_skips(&conn, "").unwrap().is_empty());
        assert!(get_skips(&conn, "no-such-session-'; DROP TABLE skipped_questions--")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn skips_come_back_oldest_first_regardless_of_insert_order() {
        let conn = mem();
        insert_skip(&conn, "s", 300, Some("c")).unwrap();
        insert_skip(&conn, "s", 100, Some("a")).unwrap();
        insert_skip(&conn, "s", 200, Some("b")).unwrap();
        assert_eq!(stamps(&get_skips(&conn, "s").unwrap()), vec![100, 200, 300]);
    }

    /// A pre-v4 row carries no card id; it must still read back rather than
    /// failing the whole session's lookup.
    #[test]
    fn a_legacy_row_without_a_question_id_reads_back_as_none() {
        let conn = mem();
        insert_skip(&conn, "s", 100, None).unwrap();
        let marks = get_skips(&conn, "s").unwrap();
        assert_eq!(marks, vec![SkipMark { timestamp: 100, question_id: None }]);
    }
}
