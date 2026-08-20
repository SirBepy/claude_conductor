//! Connection bootstrap + schema for the consolidated companion store.
//!
//! All three datasets share one shape: an `id`, a unix-second `timestamp`
//! (extracted from the wrapped struct's RFC3339 field at insert time), and a
//! `data` TEXT column holding the original Rust struct as a JSON blob. Storing
//! blobs keeps existing serde code untouched and makes struct evolution a
//! no-op for the schema.

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

/// Current schema version, mirrored into `PRAGMA user_version` by
/// [`run_migrations`]. Bump alongside any structural change and add the
/// matching branch to `run_migrations`.
pub const SCHEMA_VERSION: i64 = 3;

/// Opens (creating if absent) the SQLite database at `path` and ensures the
/// schema is present. The parent directory must already exist.
pub fn open_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL lets the app and the daemon read/write concurrently without blocking
    // each other on a single writer lock; the 5s busy_timeout makes a contended
    // write wait-and-retry instead of failing immediately with SQLITE_BUSY.
    // Set on every open so both processes coordinate on the same journal mode.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Creates the dataset tables and their indexes. Idempotent:
/// safe to call on every open. Does NOT stamp `user_version` - that happens
/// in [`run_migrations`], which must run AFTER this so it can still see the
/// pre-migration version and decide what needs to change (stamping it here
/// would make every existing DB look already-migrated on next open).
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS usage_snapshots (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_snapshots(timestamp);

        CREATE TABLE IF NOT EXISTS token_records (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_token_ts ON token_records(timestamp);

        CREATE TABLE IF NOT EXISTS skill_events (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          data      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skill_ts ON skill_events(timestamp);

        CREATE TABLE IF NOT EXISTS skipped_questions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          timestamp  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skipped_q_session ON skipped_questions(session_id);
        "#,
    )?;
    Ok(())
}

/// Reads back the stored schema version.
pub fn schema_version(conn: &Connection) -> Result<i64> {
    let v: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(v)
}

/// Returns true if `table` already has a column named `column` (used to make
/// `ALTER TABLE ... ADD COLUMN` idempotent - SQLite has no
/// `ADD COLUMN IF NOT EXISTS`).
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let found = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == column);
    Ok(found)
}

/// Applies forward migrations for every version between the DB's current
/// `user_version` and [`SCHEMA_VERSION`], then stamps the new version. Must
/// run after [`init_schema`] on every open (fresh DBs start at version 0 and
/// walk the same branches, so a brand-new table also gets its v2 column added
/// via the idempotent [`has_column`] check - harmless, but keeps one code
/// path instead of two).
pub fn run_migrations(conn: &Connection) -> Result<()> {
    let current = schema_version(conn)?;

    if current < 2 {
        // v2: multi-account milestone 03 - usage_snapshots gains a nullable
        // account_id column (NULL = legacy single-cookie history).
        if !has_column(conn, "usage_snapshots", "account_id")? {
            conn.execute("ALTER TABLE usage_snapshots ADD COLUMN account_id TEXT", [])?;
        }
    }

    // v3 (skipped_questions) needs no branch here: it is a brand-new table, so
    // init_schema's CREATE TABLE IF NOT EXISTS already covers pre-v3 DBs.

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_db_gets_account_id_column_and_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        run_migrations(&conn).unwrap();
        assert!(has_column(&conn, "usage_snapshots", "account_id").unwrap());
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn pre_v2_db_migrates_additively_without_losing_data() {
        // Simulate a pre-multi-account DB: schema created, user_version left
        // at 1 (the old init_schema behavior), one row already inserted.
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.pragma_update(None, "user_version", 1i64).unwrap();
        conn.execute(
            "INSERT INTO usage_snapshots (timestamp, data) VALUES (?1, ?2)",
            rusqlite::params![1_700_000_000i64, "{}"],
        ).unwrap();

        run_migrations(&conn).unwrap();

        assert!(has_column(&conn, "usage_snapshots", "account_id").unwrap());
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "existing row must survive the additive migration");
        let account_id: Option<String> = conn
            .query_row("SELECT account_id FROM usage_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(account_id, None, "pre-existing rows stay NULL = legacy");
    }

    #[test]
    fn run_migrations_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        run_migrations(&conn).unwrap();
        // Running it again (e.g. a second app open against the same file)
        // must not error, and must not attempt a duplicate ALTER TABLE.
        run_migrations(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn open_db_end_to_end_via_public_api() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let conn = open_db(&path).unwrap();
        run_migrations(&conn).unwrap();
        assert!(has_column(&conn, "usage_snapshots", "account_id").unwrap());
    }
}
