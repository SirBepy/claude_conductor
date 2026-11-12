//! The token file and the refresh that keeps its entries usable.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
// Refresh a little early so a token never expires between the check and the
// child's first request.
const EXPIRY_SLACK_SECS: i64 = 60;

/// Serializes every load-modify-save of the token file: a refresh and a
/// finished sign-in must not overwrite each other's write.
pub(super) static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize, Deserialize, Clone, Default)]
pub(super) struct Entry {
    pub(super) client_id: String,
    pub(super) token_endpoint: String,
    pub(super) access_token: String,
    #[serde(default)]
    pub(super) refresh_token: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    pub(super) expires_at: i64,
}

// Manual so a stray `{:?}` in a log line cannot print either token.
impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Entry")
            .field("client_id", &self.client_id)
            .field("token_endpoint", &self.token_endpoint)
            .field("access_token", &"<redacted>")
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "<redacted>"))
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

pub(super) type Store = HashMap<String, Entry>;

pub(crate) fn store_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("mcp-oauth.json"))
}

pub(super) fn load(path: &Path) -> Store {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub(super) fn save(path: &Path, store: &Store) -> Result<(), String> {
    let body = serde_json::to_string(store).map_err(|e| e.to_string())?;
    crate::util::write_json_atomic(path, &body).map_err(|e| e.to_string())
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub(super) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().map_err(|e| e.to_string())
}

/// Whether a usable sign-in exists for `mcp_url`: a refresh token can always
/// be exchanged, so an expired access token alone still counts.
pub(crate) fn signed_in(path: &Path, mcp_url: &str) -> bool {
    load(path).get(mcp_url).is_some_and(|e| e.refresh_token.is_some() || e.expires_at > now())
}

/// A bearer token for `mcp_url`, refreshed when near expiry. `None` when the
/// user never signed in, or the grant was refused (which also signs them out).
pub(crate) async fn access_token(path: &Path, mcp_url: &str) -> Option<String> {
    let fresh = |e: &Entry| e.expires_at - now() > EXPIRY_SLACK_SECS;
    let entry = load(path).get(mcp_url).cloned()?;
    if fresh(&entry) {
        return Some(entry.access_token);
    }
    let _one_at_a_time = REFRESH_LOCK.lock().await;
    // Another caller may have refreshed while this one waited.
    let entry = load(path).get(mcp_url).cloned()?;
    if fresh(&entry) {
        return Some(entry.access_token);
    }
    let refresh = entry.refresh_token.clone()?;
    let res = client().ok()?
        .post(&entry.token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", entry.client_id.as_str()),
            ("resource", mcp_url),
        ])
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            log::warn!("mcp oauth: refresh for {mcp_url} failed to reach the server: {e}");
            return None;
        }
    };
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let mut store = load(path);
    if status.is_success() {
        let updated = entry_from_token(&entry.client_id, &entry.token_endpoint, &body, entry.refresh_token.clone())?;
        let token = updated.access_token.clone();
        store.insert(mcp_url.to_string(), updated);
        save(path, &store).ok()?;
        return Some(token);
    }
    // A refused grant (revoked, expired, replayed) is final: keep nothing
    // that would be retried every turn.
    if status.as_u16() == 400 || status.as_u16() == 401 {
        log::warn!("mcp oauth: refresh for {mcp_url} refused ({status}); signed out");
        store.remove(mcp_url);
        let _ = save(path, &store);
    }
    None
}

pub(super) fn entry_from_token(client_id: &str, token_endpoint: &str, body: &Value, old_refresh: Option<String>) -> Option<Entry> {
    let access = body.get("access_token")?.as_str()?.to_string();
    let expires_in = body.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    Some(Entry {
        client_id: client_id.to_string(),
        token_endpoint: token_endpoint.to_string(),
        access_token: access,
        refresh_token: body.get("refresh_token").and_then(Value::as_str).map(str::to_string).or(old_refresh),
        expires_at: now() + expires_in,
    })
}

#[cfg(test)]
pub(crate) fn seed_for_test(path: &Path, mcp_url: &str, token: &str) {
    let mut store = load(path);
    store.insert(
        mcp_url.to_string(),
        Entry { client_id: "c".into(), token_endpoint: String::new(), access_token: token.into(), refresh_token: None, expires_at: now() + 3600 },
    );
    save(path, &store).unwrap();
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{fake_server, tmp};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn debug_output_redacts_both_tokens() {
        let (access, refresh) = ("value-one-xyz", "value-two-xyz");
        let entry = Entry {
            client_id: "cid".into(),
            token_endpoint: "https://m.example/token".into(),
            access_token: access.into(),
            refresh_token: Some(refresh.into()),
            expires_at: 5,
        };
        let shown = format!("{:?}", entry);
        assert!(!shown.contains(access) && !shown.contains(refresh), "{shown}");
        assert!(shown.contains("cid"), "{shown}");
    }

    #[tokio::test]
    async fn two_callers_with_an_expired_token_refresh_once_and_both_get_the_new_token() {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = fake_server(hits.clone(), |_, _| {
            (200, r#"{"access_token":"new-a","refresh_token":"new-r","expires_in":3600}"#.into())
        })
        .await;
        let (_d, path) = tmp();
        let mut store = Store::new();
        store.insert(
            "https://m.example/mcp".into(),
            Entry { client_id: "c".into(), token_endpoint: format!("{base}/oauth/token"), access_token: "old".into(), refresh_token: Some("old-r".into()), expires_at: 1 },
        );
        save(&path, &store).unwrap();
        let (a, b) = tokio::join!(access_token(&path, "https://m.example/mcp"), access_token(&path, "https://m.example/mcp"));
        assert_eq!((a.as_deref(), b.as_deref()), (Some("new-a"), Some("new-a")));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "a second refresh would replay the rotated token and revoke the grant");
        assert_eq!(load(&path)["https://m.example/mcp"].refresh_token.as_deref(), Some("new-r"));
    }

    #[tokio::test]
    async fn a_refused_refresh_signs_the_server_out() {
        let base = fake_server(Arc::new(AtomicUsize::new(0)), |_, _| (400, r#"{"error":"invalid_grant"}"#.into())).await;
        let (_d, path) = tmp();
        let mut store = Store::new();
        store.insert(
            "u".into(),
            Entry { client_id: "c".into(), token_endpoint: format!("{base}/oauth/token"), access_token: "old".into(), refresh_token: Some("r".into()), expires_at: 1 },
        );
        save(&path, &store).unwrap();
        assert_eq!(access_token(&path, "u").await, None);
        assert!(!signed_in(&path, "u"));
    }
}
