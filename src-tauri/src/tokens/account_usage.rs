//! "Tokens Conductor ran on this account": the fallback figure every Endpoint
//! account shows, whatever its provider does or does not report. Summed on read
//! from the account's own transcripts, with no new persistence (the transcripts
//! already are the persisted record).
//!
//! An account's `<config_dir>/projects` is a junction onto the one shared
//! `~/.claude/projects`, so the directory cannot tell accounts apart. The
//! account of a transcript comes from `chat_config` (the account each session
//! was spawned under), keyed by the transcript's session id. A session with no
//! recorded account counts for no account.
//!
//! This is what Conductor ran, never the plan's true remaining amount: usage
//! from the provider's own site or another tool is not in it.

use super::walker::walk_jsonl;
use crate::accounts::Account;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const BUCKET_SECS: i64 = 60;
const FIVE_HOURS: i64 = 5 * 3600;
const SEVEN_DAYS: i64 = 7 * 86_400;

/// Summed assistant-turn usage over one window.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TokenSums {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    #[ts(type = "number")]
    pub cache_creation: u64,
    #[ts(type = "number")]
    pub turns: u64,
}

impl TokenSums {
    /// Everything the provider counted going in or out.
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }

    fn add(&mut self, b: &[u64; 5]) {
        self.input += b[0];
        self.output += b[1];
        self.cache_read += b[2];
        self.cache_creation += b[3];
        self.turns += b[4];
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AccountTokens {
    pub account_id: String,
    pub five_hour: TokenSums,
    pub today: TokenSums,
    pub seven_day: TokenSums,
}

/// `[input, output, cache_read, cache_creation, turns]` per minute.
type Buckets = HashMap<i64, [u64; 5]>;
type FileCache = HashMap<PathBuf, (SystemTime, u64, Arc<Buckets>)>;

/// Per-file minute buckets keyed on the file's mtime and length, so a read
/// re-parses only a transcript that grew. In memory only.
static CACHE: OnceLock<Mutex<FileCache>> = OnceLock::new();

fn file_buckets(path: &Path, cutoff: i64) -> Option<Arc<Buckets>> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    // A file untouched since before the oldest window cannot hold a turn inside it.
    if mtime.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as i64 + BUCKET_SECS < cutoff {
        return None;
    }
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, len, b)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        if *t == mtime && *len == meta.len() {
            return Some(b.clone());
        }
    }
    let mut buckets = Buckets::new();
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(|r| r.ok()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(usage) = v.get("message").and_then(|m| m.get("usage")).or_else(|| v.get("usage")) else { continue };
        let Some(ts) = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp())
        else {
            continue;
        };
        let get = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        let b = buckets.entry(ts - ts.rem_euclid(BUCKET_SECS)).or_default();
        b[0] += get("input_tokens");
        b[1] += get("output_tokens");
        b[2] += get("cache_read_input_tokens");
        b[3] += get("cache_creation_input_tokens");
        b[4] += 1;
    }
    let buckets = Arc::new(buckets);
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf(), (mtime, meta.len(), buckets.clone()));
    Some(buckets)
}

/// The transcript files under `projects_dir` that belong to `sessions`: a
/// top-level `<session id>.jsonl`, plus everything under a `<session id>/`
/// directory (its subagent transcripts).
fn session_files(projects_dir: &Path, sessions: &HashSet<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(projects_dir) else { return out };
    for project in projects.flatten().filter(|p| p.path().is_dir()) {
        let Ok(entries) = std::fs::read_dir(project.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if sessions.contains(&name) {
                    out.extend(walk_jsonl(&path));
                }
            } else if let Some(sid) = name.strip_suffix(".jsonl") {
                if sessions.contains(sid) {
                    out.push(path);
                }
            }
        }
    }
    out
}

/// 5h, today and 7-day sums over the transcripts of `sessions` under
/// `projects_dir`. `now` and `today_start` are unix seconds (the local day's
/// start is the caller's call, so a test can pin it).
pub fn scan(projects_dir: &Path, sessions: &HashSet<String>, now: i64, today_start: i64) -> AccountTokens {
    let mut out = AccountTokens::default();
    if sessions.is_empty() {
        return out;
    }
    let cutoff = now - SEVEN_DAYS;
    for path in session_files(projects_dir, sessions) {
        let Some(buckets) = file_buckets(&path, cutoff) else { continue };
        for (start, b) in buckets.iter() {
            // A bucket is dated by its first second, so a turn counts from its own minute.
            if *start < cutoff || *start > now {
                continue;
            }
            out.seven_day.add(b);
            if *start >= today_start {
                out.today.add(b);
            }
            if *start >= now - FIVE_HOURS {
                out.five_hour.add(b);
            }
        }
    }
    out
}

/// Every session id `chat_config` recorded under `account_id`.
pub fn sessions_of(account_id: &str) -> HashSet<String> {
    crate::sessions::chat_config::session_ids_for_account(account_id)
}

/// `account`'s token sums as of now.
pub fn account_tokens(account: &Account) -> AccountTokens {
    let now = chrono::Utc::now().timestamp();
    let today_start = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).earliest())
        .map(|d| d.timestamp())
        .unwrap_or(now - 86_400);
    let mut sums = scan(&account.config_dir.join("projects"), &sessions_of(&account.id), now, today_start);
    sums.account_id = account.id.clone();
    sums
}

#[cfg(test)]
mod tests;
