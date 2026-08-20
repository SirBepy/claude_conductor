//! CRUD for the `skipped_questions` table.
//!
//! A Skip never reaches Claude's transcript JSONL, so this table is its only
//! durable trace. `timestamp` is unix ms, matching `chat::parser`'s events.

use anyhow::Result;
use rusqlite::Connection;

/// Records one skip for `session_id` at `timestamp` (unix ms).
pub fn insert_skip(conn: &Connection, session_id: &str, timestamp: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO skipped_questions (session_id, timestamp) VALUES (?1, ?2)",
        rusqlite::params![session_id, timestamp],
    )?;
    Ok(())
}

/// Skip timestamps for one session, oldest first. An unknown session id is not
/// an error - it returns an empty vec, same as a session that never skipped.
pub fn get_skips(conn: &Connection, session_id: &str) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT timestamp FROM skipped_questions WHERE session_id = ?1 ORDER BY timestamp ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| row.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for ts in rows {
        out.push(ts?);
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

    #[test]
    fn skip_is_recorded_and_survives_a_store_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.db");
        {
            let mgr = StorageManager::open(&path).unwrap();
            insert_skip(mgr.conn(), "sess-a", 1_700_000_000_000).unwrap();
            insert_skip(mgr.conn(), "sess-a", 1_700_000_005_000).unwrap();
        }
        let reopened = StorageManager::open(&path).unwrap();
        assert_eq!(
            get_skips(reopened.conn(), "sess-a").unwrap(),
            vec![1_700_000_000_000, 1_700_000_005_000],
        );
    }

    #[test]
    fn a_session_with_no_skip_record_reads_empty() {
        let conn = mem();
        insert_skip(&conn, "sess-a", 1_700_000_000_000).unwrap();
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
        insert_skip(&conn, "s", 300).unwrap();
        insert_skip(&conn, "s", 100).unwrap();
        insert_skip(&conn, "s", 200).unwrap();
        assert_eq!(get_skips(&conn, "s").unwrap(), vec![100, 200, 300]);
    }
}
