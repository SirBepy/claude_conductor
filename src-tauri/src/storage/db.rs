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
pub const SCHEMA_VERSION: i64 = 4;

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
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT NOT NULL,
          timestamp   INTEGER NOT NULL,
          question_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_skipped_q_session ON skipped_questions(session_id);
        "#,
    )?;
    Ok(())
}

/// Runs a `TRUNCATE`-mode WAL checkpoint, returning SQLite's own
/// `(busy, log_frames, checkpointed_frames)` triple (see
/// https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).
///
/// Todo 881: `journal_mode=WAL`'s default `wal_autocheckpoint` (1000 pages,
/// ~4MB) only runs a PASSIVE checkpoint opportunistically after a commit, and
/// PASSIVE can never truncate the WAL file back down - only TRUNCATE can, and
/// only when it can momentarily see no other connection's snapshot still
/// pinned to an older WAL position. The app and the daemon each hold their
/// own long-lived connection to the same `companion.db` (`state.db` here,
/// `AppState`'s own on the app side), so with both routinely mid-read/write
/// there was rarely a truncation-eligible instant - measured on Joe's machine
/// 2026-09-10: `companion.db` 35MB, `companion.db-wal` 58MB and still growing
/// after 15+ hours with zero truncation. `TRUNCATE` never errors when it
/// can't get that exclusive instant - it silently degrades to a PASSIVE
/// checkpoint (`busy=1` in the return triple) - so callers can run this on a
/// plain interval with no risk of failing a call or blocking a concurrent
/// writer past `busy_timeout`.
pub fn checkpoint_truncate(conn: &Connection) -> Result<(i64, i64, i64)> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .map_err(Into::into)
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

    if current < 4 {
        // v4: a skip mark names the card it dismissed. Pre-v4 rows keep NULL
        // and fall back to the timestamp heuristic, which mis-attributes once
        // two question cards are open at once.
        if !has_column(conn, "skipped_questions", "question_id")? {
            conn.execute("ALTER TABLE skipped_questions ADD COLUMN question_id TEXT", [])?;
        }
    }

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

    // Todo 881: proves checkpoint_truncate actually shrinks a real WAL file
    // (an in-memory connection never grows one, so this needs a real path,
    // same as open_db_end_to_end_via_public_api above).
    #[test]
    fn checkpoint_truncate_shrinks_the_wal_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let wal_path = dir.path().join("test.db-wal");
        let conn = open_db(&path).unwrap();
        run_migrations(&conn).unwrap();

        for i in 0..500 {
            conn.execute(
                "INSERT INTO token_records (timestamp, data) VALUES (?1, ?2)",
                rusqlite::params![i, "{\"padding\":\"0123456789abcdef0123456789abcdef\"}"],
            )
            .unwrap();
        }
        let wal_size_before = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        assert!(wal_size_before > 0, "the inserts above must have grown a real WAL file");

        // Not asserting on `checkpointed_frames` here: with no other connection
        // contending, SQLite's own default `wal_autocheckpoint` (1000 pages) may
        // already have passively flushed everything into the main db file by the
        // time this explicit call runs, leaving 0 frames still pending - that is
        // exactly the passive-checkpoint behavior this fix works around, since a
        // PASSIVE checkpoint never shrinks the WAL FILE's on-disk size, only
        // TRUNCATE does (see checkpoint_truncate's doc). The property that
        // actually matters is asserted below: the file shrinks.
        let (busy, _log_frames, _checkpointed_frames) = checkpoint_truncate(&conn).unwrap();
        assert_eq!(busy, 0, "no other connection is open, so TRUNCATE must fully complete");

        let wal_size_after = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        assert_eq!(wal_size_after, 0, "a fully-completed TRUNCATE resets the WAL file to zero bytes");
    }
}
