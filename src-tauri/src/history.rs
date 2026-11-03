//! Append-only JSONL history of usage snapshots, with age-based pruning.

use crate::types::UsageSnapshot;
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

const MAX_AGE_DAYS: i64 = 90;

/// Append a snapshot as a single JSON line.
pub fn append(path: &Path, snapshot: &UsageSnapshot) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {parent:?}"))?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("opening {path:?}"))?;
    let line = serde_json::to_string(snapshot).context("serializing snapshot")?;
    writeln!(f, "{line}").context("writing snapshot line")?;
    Ok(())
}

/// Load all snapshots from disk, skipping any lines that fail to parse
/// (with a log warning). Returns oldest first.
pub fn load_all(path: &Path) -> Result<Vec<UsageSnapshot>> {
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e).context("opening history file"),
    };
    let mut out = Vec::new();
    for (idx, line) in BufReader::new(f).lines().enumerate() {
        let raw = line.with_context(|| format!("reading line {idx}"))?;
        if raw.trim().is_empty() { continue; }
        match serde_json::from_str::<UsageSnapshot>(&raw) {
            Ok(snap) => out.push(snap),
            Err(e) => log::warn!("history line {idx} skipped: {e}"),
        }
    }
    Ok(out)
}

/// Delete snapshots older than MAX_AGE_DAYS by rewriting the file.
pub fn prune(path: &Path) -> Result<()> {
    let snapshots = load_all(path)?;
    let cutoff = Utc::now() - Duration::days(MAX_AGE_DAYS);
    let kept: Vec<_> = snapshots
        .into_iter()
        .filter(|s| {
            match DateTime::parse_from_rfc3339(&s.captured_at) {
                Ok(ts) => ts.with_timezone(&Utc) > cutoff,
                Err(_) => true, // keep unparseable rather than lose data
            }
        })
        .collect();
    let raw: String = kept
        .iter()
        .map(|s| serde_json::to_string(s).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let raw = if raw.is_empty() { String::new() } else { format!("{raw}\n") };
    std::fs::write(path, raw).context("rewriting history after prune")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{UsageSnapshot, WindowUsage};
    use tempfile::tempdir;

    fn snap(captured_at: &str) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: captured_at.into(),
            five_hour: WindowUsage { utilization: 1.0, resets_at: "x".into() },
            five_hour_limited: true,
            seven_day: WindowUsage { utilization: 2.0, resets_at: "y".into() },
            extra_usage: None,
            account_id: None,
        }
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        assert!(load_all(&dir.path().join("nope.jsonl")).unwrap().is_empty());
    }

    #[test]
    fn append_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        append(&p, &snap("2026-04-19T10:00:00Z")).unwrap();
        append(&p, &snap("2026-04-19T11:00:00Z")).unwrap();
        let back = load_all(&p).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].captured_at, "2026-04-19T10:00:00Z");
    }

    #[test]
    fn load_skips_corrupt_lines() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        let good = serde_json::to_string(&snap("2026-04-19T10:00:00Z")).unwrap();
        std::fs::write(&p, format!("{good}\n{{not json\n{good}\n")).unwrap();
        let back = load_all(&p).unwrap();
        assert_eq!(back.len(), 2);
    }

    #[test]
    fn prune_drops_old_snapshots() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        let old = (Utc::now() - Duration::days(120)).to_rfc3339();
        let recent = Utc::now().to_rfc3339();
        append(&p, &snap(&old)).unwrap();
        append(&p, &snap(&recent)).unwrap();
        prune(&p).unwrap();
        let back = load_all(&p).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].captured_at, recent);
    }
}
