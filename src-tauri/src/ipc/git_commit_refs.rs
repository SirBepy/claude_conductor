//! Resolves hex words a chat message mentions (`8a180b5`) to real commits in
//! the session's repo, so the renderer only turns an actual commit into a link.
//! One `git log --no-walk` spawn per call, however many candidates it carries.

use super::git::run_git;

/// A message can carry a pile of hex-looking tokens (hashes, ids); cap one
/// call so a pathological message can't build an unbounded argv.
const MAX_CANDIDATES: usize = 64;

#[derive(serde::Serialize, ts_rs::TS, Debug, PartialEq)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CommitRef {
    /// The candidate exactly as the caller sent it (lowercased), so the
    /// frontend can map a result back onto the span it came from.
    pub query: String,
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    /// Author date, strict ISO 8601.
    pub date: String,
}

fn is_sha_candidate(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

/// Pairs each query with the logged commit whose full sha it prefixes. A query
/// git dropped (missing, ambiguous, or naming a tree/blob) simply has no match.
fn parse_log(queries: &[String], raw: &str) -> Vec<CommitRef> {
    let commits: Vec<[&str; 5]> = raw
        .split(RECORD)
        .filter_map(|rec| {
            let mut f = rec.trim_start_matches(['\n', '\r']).splitn(5, FIELD);
            Some([f.next()?, f.next()?, f.next()?, f.next()?, f.next().unwrap_or("")])
        })
        .filter(|c| !c[0].is_empty())
        .collect();
    queries
        .iter()
        .filter_map(|q| {
            let c = commits.iter().find(|c| c[0].starts_with(q.as_str()))?;
            Some(CommitRef {
                query: q.clone(),
                sha: c[0].to_string(),
                subject: c[1].to_string(),
                author: c[2].to_string(),
                date: c[3].to_string(),
                body: c[4].trim().to_string(),
            })
        })
        .collect()
}

/// Returns the candidates that name a commit in `cwd`'s repo. Non-hex or
/// out-of-length candidates are dropped before git sees them, which is also
/// what keeps an option-like string out of the argv. Not a repo, or no
/// candidate resolving, is an empty list rather than an error.
#[tauri::command]
pub async fn resolve_commit_refs(cwd: String, candidates: Vec<String>) -> Result<Vec<CommitRef>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut queries: Vec<String> = Vec::new();
        for c in candidates {
            let c = c.to_ascii_lowercase();
            if is_sha_candidate(&c) && !queries.contains(&c) {
                queries.push(c);
            }
            if queries.len() == MAX_CANDIDATES {
                break;
            }
        }
        if queries.is_empty() {
            return Ok(vec![]);
        }
        // `^{commit}` makes a tree/blob id fail to peel instead of printing a
        // non-commit; `--ignore-missing` skips unknown ids instead of failing
        // the whole call. Git still exits 0 when some inputs are dropped.
        let revs: Vec<String> = queries.iter().map(|q| format!("{q}^{{commit}}")).collect();
        let format = "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e";
        let mut args: Vec<&str> = vec!["log", "--no-walk=unsorted", "--ignore-missing", format];
        args.extend(revs.iter().map(String::as_str));
        match run_git(&cwd, &args) {
            Ok(raw) => Ok(parse_log(&queries, &raw)),
            Err(_) => Ok(vec![]),
        }
    })
    .await
    .map_err(|e| format!("resolve_commit_refs join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(sha: &str, subject: &str, body: &str) -> String {
        format!("{sha}{FIELD}{subject}{FIELD}Joe{FIELD}2026-09-30T10:00:00+02:00{FIELD}{body}{RECORD}\n")
    }

    #[test]
    fn candidate_filter_accepts_only_lowercase_hex_of_sha_length() {
        assert!(is_sha_candidate("8a180b5"));
        assert!(is_sha_candidate(&"a".repeat(40)));
        for bad in ["8a180b", &"a".repeat(41), "8A180B5", "8a180g5", "--output", "-8a180b5"] {
            assert!(!is_sha_candidate(bad), "accepted {bad:?}");
        }
    }

    #[test]
    fn each_query_maps_to_the_commit_it_prefixes() {
        let raw = format!(
            "{}{}",
            rec("469a502f3deb62e698f7f834819b130691262681", "FIX: one", ""),
            rec("f561da0463647781eed99b30f1a10499653bd80f", "VERSION: two", "line a\nline b\n"),
        );
        let queries = vec!["f561da04".to_string(), "469a502".to_string(), "deadbee".to_string()];
        let out = parse_log(&queries, &raw);
        assert_eq!(out.len(), 2, "the unresolved query has no row");
        assert_eq!(out[0].query, "f561da04");
        assert_eq!(out[0].subject, "VERSION: two");
        assert_eq!(out[0].body, "line a\nline b");
        assert_eq!(out[1].sha, "469a502f3deb62e698f7f834819b130691262681");
        assert_eq!(out[1].author, "Joe");
    }

    #[test]
    fn empty_log_output_resolves_nothing() {
        assert!(parse_log(&["8a180b5".to_string()], "").is_empty());
    }

    #[tokio::test]
    async fn resolves_head_in_this_repo_and_drops_junk() {
        let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();
        let head = run_git(&cwd, &["rev-parse", "HEAD"]).unwrap();
        let short = head[..9].to_string();
        let out = resolve_commit_refs(cwd, vec![short.to_uppercase(), "0000000".into(), "--all".into()])
            .await
            .unwrap();
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].sha, head);
        assert_eq!(out[0].query, short);
    }

    #[tokio::test]
    async fn a_non_repo_cwd_is_an_empty_list_not_an_error() {
        let dir = std::env::temp_dir();
        let out = resolve_commit_refs(dir.to_string_lossy().to_string(), vec!["8a180b5".into()]).await;
        assert_eq!(out, Ok(vec![]));
    }
}
