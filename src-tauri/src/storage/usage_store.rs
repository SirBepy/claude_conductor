//! CRUD for the `usage_snapshots` table.
//!
//! The index `timestamp` is derived from `UsageSnapshot::captured_at` (RFC3339)
//! parsed to unix seconds; the full snapshot is stored as a JSON blob.

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::types::usage::UsageSnapshot;

/// Parses an RFC3339 timestamp string into unix seconds.
pub(crate) fn rfc3339_to_unix(s: &str) -> Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(s)
        .with_context(|| format!("invalid RFC3339 timestamp: {s:?}"))?
        .timestamp())
}

/// Inserts one snapshot. The `timestamp` column comes from `captured_at`; the
/// `account_id` column mirrors `snapshot.account_id` (NULL for the legacy
/// single-cookie poll) so per-account queries don't need to deserialize every
/// row's JSON blob just to filter.
pub fn insert_snapshot(conn: &Connection, snapshot: &UsageSnapshot) -> Result<()> {
    let ts = rfc3339_to_unix(&snapshot.captured_at)?;
    let data = serde_json::to_string(snapshot)?;
    conn.execute(
        "INSERT INTO usage_snapshots (timestamp, data, account_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![ts, data, snapshot.account_id],
    )?;
    Ok(())
}

/// Returns snapshots with `timestamp >= since` (unix seconds), newest first,
/// capped at `limit`. Pass `limit = -1` for no cap. `account_id`: `None`
/// returns every snapshot regardless of account (preserves the pre-milestone-
/// 03 behavior for existing callers); `Some(id)` filters to that account only.
pub fn get_snapshots(
    conn: &Connection,
    since: i64,
    limit: i64,
    account_id: Option<&str>,
) -> Result<Vec<UsageSnapshot>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM usage_snapshots \
         WHERE timestamp >= ?1 AND (?2 IS NULL OR account_id = ?2) \
         ORDER BY timestamp DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(rusqlite::params![since, account_id, limit], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<UsageSnapshot>(&data?)?);
    }
    Ok(out)
}

/// Returns snapshots with `timestamp >= since` (unix seconds) in ascending
/// order, optionally filtered to one account. Inclusive on purpose: an
/// incremental reader re-reads its cursor's second and dedupes, because a
/// strict `>` would skip a row inserted later within that same second.
pub fn get_snapshots_since(
    conn: &Connection,
    since: i64,
    account_id: Option<&str>,
) -> Result<Vec<UsageSnapshot>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM usage_snapshots \
         WHERE timestamp >= ?1 AND (?2 IS NULL OR account_id = ?2) \
         ORDER BY timestamp ASC, id ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![since, account_id], |row| {
        let data: String = row.get(0)?;
        Ok(data)
    })?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str::<UsageSnapshot>(&data?)?);
    }
    Ok(out)
}

/// Returns every snapshot in ascending timestamp order, tagged with `account_id`.
pub fn get_all_snapshots(conn: &Connection) -> Result<Vec<UsageSnapshot>> {
    get_snapshots_since(conn, 0, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::{init_schema, run_migrations};
    use crate::types::usage::WindowUsage;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn snap(captured_at: &str, account_id: Option<&str>) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: captured_at.into(),
            five_hour: WindowUsage { utilization: 1.0, resets_at: "x".into() },
            seven_day: WindowUsage { utilization: 2.0, resets_at: "y".into() },
            extra_usage: None,
            account_id: account_id.map(str::to_string),
        }
    }

    #[test]
    fn insert_tags_account_id_and_round_trips() {
        let conn = test_conn();
        insert_snapshot(&conn, &snap("2026-07-01T00:00:00Z", Some("acct-1"))).unwrap();
        let stored: Option<String> = conn
            .query_row("SELECT account_id FROM usage_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored.as_deref(), Some("acct-1"));

        let all = get_all_snapshots(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].account_id.as_deref(), Some("acct-1"));
    }

    #[test]
    fn insert_legacy_snapshot_leaves_account_id_null() {
        let conn = test_conn();
        insert_snapshot(&conn, &snap("2026-07-01T00:00:00Z", None)).unwrap();
        let stored: Option<String> = conn
            .query_row("SELECT account_id FROM usage_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, None);
    }

    #[test]
    fn get_snapshots_no_filter_returns_every_account() {
        let conn = test_conn();
        insert_snapshot(&conn, &snap("2026-07-01T00:00:00Z", Some("a"))).unwrap();
        insert_snapshot(&conn, &snap("2026-07-01T00:01:00Z", Some("b"))).unwrap();
        insert_snapshot(&conn, &snap("2026-07-01T00:02:00Z", None)).unwrap();

        let all = get_snapshots(&conn, 0, -1, None).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn get_snapshots_filters_to_one_account() {
        let conn = test_conn();
        insert_snapshot(&conn, &snap("2026-07-01T00:00:00Z", Some("a"))).unwrap();
        insert_snapshot(&conn, &snap("2026-07-01T00:01:00Z", Some("b"))).unwrap();
        insert_snapshot(&conn, &snap("2026-07-01T00:02:00Z", None)).unwrap();

        let only_a = get_snapshots(&conn, 0, -1, Some("a")).unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].account_id.as_deref(), Some("a"));
    }

    #[test]
    fn get_snapshots_since_is_inclusive_ascending_and_account_scoped() {
        let conn = test_conn();
        insert_snapshot(&conn, &snap("2026-07-01T00:00:00Z", Some("a"))).unwrap();
        insert_snapshot(&conn, &snap("2026-07-01T00:01:00Z", Some("b"))).unwrap();
        insert_snapshot(&conn, &snap("2026-07-01T00:02:00Z", Some("a"))).unwrap();
        let cursor = rfc3339_to_unix("2026-07-01T00:01:00Z").unwrap();

        let tail = get_snapshots_since(&conn, cursor, None).unwrap();
        let stamps: Vec<_> = tail.iter().map(|s| s.captured_at.as_str()).collect();
        assert_eq!(stamps, ["2026-07-01T00:01:00Z", "2026-07-01T00:02:00Z"]);

        let tail_a = get_snapshots_since(&conn, cursor, Some("a")).unwrap();
        assert_eq!(tail_a.len(), 1);
        assert_eq!(tail_a[0].captured_at, "2026-07-01T00:02:00Z");
    }
}
