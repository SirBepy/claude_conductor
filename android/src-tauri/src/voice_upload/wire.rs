//! The JSON the uploader trades with `VoiceUploadPlugin.kt`, kept apart from the
//! Android-only glue so both directions are tested on the host.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::engine::{Auth, Awaiting, Job, Mark};

/// `{"jobs":[{id,path,sizeBytes,sha256?,recordedAtMs,durationMs}]}`. A row that is
/// missing `id`, `path` or `sizeBytes` is skipped, never guessed at.
pub(crate) fn parse_claim(reply: &Value) -> Vec<Job> {
    let Some(rows) = reply["jobs"].as_array() else { return Vec::new() };
    rows.iter()
        .filter_map(|r| {
            Some(Job {
                id: r["id"].as_str().filter(|s| !s.is_empty())?.to_string(),
                path: PathBuf::from(r["path"].as_str().filter(|s| !s.is_empty())?),
                size_bytes: r["sizeBytes"].as_u64().filter(|n| *n > 0)?,
                sha256: r["sha256"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
                recorded_at_ms: r["recordedAtMs"].as_u64().unwrap_or(0),
                duration_ms: r["durationMs"].as_u64().unwrap_or(0),
            })
        })
        .collect()
}

/// `{"rows":[{id,sha256}]}`: uploaded recordings waiting to hear of their
/// transcript. A row with no id or hash is skipped (nothing to ask the PC with).
pub(crate) fn parse_awaiting(reply: &Value) -> Vec<Awaiting> {
    let Some(rows) = reply["rows"].as_array() else { return Vec::new() };
    rows.iter()
        .filter_map(|r| {
            Some(Awaiting {
                id: r["id"].as_str().filter(|s| !s.is_empty())?.to_string(),
                sha256: r["sha256"].as_str().filter(|s| !s.is_empty())?.to_string(),
            })
        })
        .collect()
}

/// `{"token":"...","port":40123}`, or `{}` while no login has been captured yet.
pub(crate) fn parse_auth(reply: &Value) -> Option<Auth> {
    let token = reply["token"].as_str().filter(|t| !t.is_empty())?.to_string();
    let port = u16::try_from(reply["port"].as_u64()?).ok().filter(|p| *p != 0)?;
    Some(Auth { port, token })
}

pub(crate) fn mark_payload(id: &str, mark: &Mark) -> Value {
    match mark {
        Mark::Uploading { bytes } => json!({"id": id, "state": "uploading", "bytes": bytes}),
        Mark::Queued => json!({"id": id, "state": "queued"}),
        Mark::Uploaded => json!({"id": id, "state": "uploaded"}),
        Mark::Transcribed => json!({"id": id, "state": "transcribed"}),
        Mark::Failed(why) => json!({"id": id, "state": "failed", "error": why}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_reply_becomes_jobs_and_skips_rows_it_cannot_use() {
        let reply = json!({"jobs": [
            {"id": "a", "path": "/data/x.opus", "sizeBytes": 10, "sha256": "ab", "recordedAtMs": 5, "durationMs": 7},
            {"id": "b", "path": "/data/y.opus", "sizeBytes": 3, "sha256": null},
            {"id": "", "path": "/data/z.opus", "sizeBytes": 3},
            {"id": "c", "sizeBytes": 3},
            {"id": "d", "path": "/data/w.opus", "sizeBytes": 0},
        ]});
        let jobs = parse_claim(&reply);
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0], Job { id: "a".into(), path: "/data/x.opus".into(), size_bytes: 10, sha256: Some("ab".into()), recorded_at_ms: 5, duration_ms: 7 });
        assert_eq!(jobs[1].sha256, None);
        assert!(parse_claim(&json!({})).is_empty());
    }

    #[test]
    fn awaiting_rows_need_an_id_and_a_hash() {
        let reply = json!({"rows": [
            {"id": "a", "sha256": "ab"}, {"id": "b", "sha256": null}, {"id": "", "sha256": "cd"}, {"sha256": "ef"},
        ]});
        assert_eq!(parse_awaiting(&reply), vec![Awaiting { id: "a".into(), sha256: "ab".into() }]);
        assert!(parse_awaiting(&json!({})).is_empty());
    }

    #[test]
    fn a_login_needs_both_a_token_and_a_valid_port() {
        assert_eq!(parse_auth(&json!({"token": "t", "port": 40123})), Some(Auth { port: 40123, token: "t".into() }));
        assert_eq!(parse_auth(&json!({})), None);
        assert_eq!(parse_auth(&json!({"token": "", "port": 4})), None);
        assert_eq!(parse_auth(&json!({"token": "t", "port": 70000})), None);
        assert_eq!(parse_auth(&json!({"token": "t", "port": 0})), None);
    }

    #[test]
    fn marks_carry_the_state_name_the_kotlin_side_reads() {
        assert_eq!(mark_payload("r", &Mark::Uploading { bytes: 9 }), json!({"id": "r", "state": "uploading", "bytes": 9}));
        assert_eq!(mark_payload("r", &Mark::Queued)["state"], "queued");
        assert_eq!(mark_payload("r", &Mark::Uploaded)["state"], "uploaded");
        assert_eq!(mark_payload("r", &Mark::Transcribed), json!({"id": "r", "state": "transcribed"}));
        assert_eq!(mark_payload("r", &Mark::Failed("x".into())), json!({"id": "r", "state": "failed", "error": "x"}));
    }
}
