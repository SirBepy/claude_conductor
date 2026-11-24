use super::*;
use chrono::{TimeZone, Utc};

/// Fixed once per run but near the real clock: `file_buckets` skips a file whose
/// mtime (real) is older than the window, so a made-up "now" would skip every file.
fn now() -> i64 {
    static NOW: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *NOW.get_or_init(|| Utc::now().timestamp())
}

fn ts(t: i64) -> String {
    Utc.timestamp_opt(t, 0).unwrap().to_rfc3339()
}

fn turn(t: i64, input: u64, output: u64) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"{}","message":{{"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}}}}"#,
        ts(t)
    )
}

fn write(dir: &Path, rel: &str, lines: &[String]) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, lines.join("\n")).unwrap();
}

fn set(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

#[test]
fn only_the_accounts_own_sessions_count_even_in_a_shared_projects_tree() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "proj/mine.jsonl", &[turn(now() - 60, 10, 20)]);
    write(dir.path(), "proj/theirs.jsonl", &[turn(now() - 60, 1000, 2000)]);
    write(dir.path(), "other-proj/mine.jsonl", &[turn(now() - 90, 5, 5)]);
    let got = scan(dir.path(), &set(&["mine"]), now(), now() - 3600);
    assert_eq!(got.five_hour.input, 15);
    assert_eq!(got.five_hour.output, 25);
    assert_eq!(got.five_hour.cache_read, 4);
    assert_eq!(got.five_hour.cache_creation, 2);
    assert_eq!(got.five_hour.turns, 2);
    assert_eq!(got.five_hour.total(), 15 + 25 + 4 + 2);
}

#[test]
fn a_sessions_subagent_transcripts_are_included() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "proj/mine.jsonl", &[turn(now() - 60, 10, 0)]);
    write(dir.path(), "proj/mine/subagents/agent-1.jsonl", &[turn(now() - 60, 7, 0)]);
    write(dir.path(), "proj/theirs/subagents/agent-2.jsonl", &[turn(now() - 60, 900, 0)]);
    assert_eq!(scan(dir.path(), &set(&["mine"]), now(), now() - 3600).seven_day.input, 17);
}

#[test]
fn windows_cut_at_5h_today_and_7d() {
    let dir = tempfile::tempdir().unwrap();
    let today_start = now() - 10 * 3600;
    write(
        dir.path(),
        "p/s.jsonl",
        &[
            turn(now() - 3600, 1, 0),             // inside 5h, today
            turn(now() - 6 * 3600, 10, 0),        // outside 5h, today
            turn(now() - 12 * 3600, 100, 0),      // outside today, inside 7d
            turn(now() - 8 * 86_400, 1000, 0),    // outside 7d
        ],
    );
    let got = scan(dir.path(), &set(&["s"]), now(), today_start);
    assert_eq!(got.five_hour.input, 1);
    assert_eq!(got.today.input, 11);
    assert_eq!(got.seven_day.input, 111);
}

#[test]
fn no_sessions_or_no_directory_is_zero_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "p/s.jsonl", &[turn(now() - 60, 5, 5)]);
    assert_eq!(scan(dir.path(), &HashSet::new(), now(), 0), AccountTokens::default());
    assert_eq!(scan(&dir.path().join("missing"), &set(&["s"]), now(), 0), AccountTokens::default());
}

#[test]
fn lines_without_a_timestamp_or_usage_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "p/s.jsonl",
        &[
            r#"{"type":"assistant","message":{"usage":{"input_tokens":50}}}"#.to_string(),
            format!(r#"{{"type":"assistant","timestamp":"{}","message":{{}}}}"#, ts(now() - 5)),
            r#"{"type":"user","message":{"content":"hi"}}"#.to_string(),
            "not json".to_string(),
            turn(now() - 5, 3, 0),
        ],
    );
    let got = scan(dir.path(), &set(&["s"]), now(), 0);
    assert_eq!((got.five_hour.input, got.five_hour.turns), (3, 1));
}

#[test]
fn a_transcript_that_grew_is_read_again() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "p/s.jsonl", &[turn(now() - 60, 1, 0)]);
    assert_eq!(scan(dir.path(), &set(&["s"]), now(), 0).five_hour.input, 1);
    write(dir.path(), "p/s.jsonl", &[turn(now() - 60, 1, 0), turn(now() - 30, 4, 0)]);
    assert_eq!(scan(dir.path(), &set(&["s"]), now(), 0).five_hour.input, 5, "the length changed, so the cache entry is stale");
}
