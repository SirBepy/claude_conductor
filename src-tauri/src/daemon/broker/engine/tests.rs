use super::transport::net_error;
use super::*;
use crate::daemon::broker::store::testing::MemSecrets;
use std::sync::mpsc;

struct AllowAll;
impl Policy for AllowAll {
    fn decide(&self, _: &PolicyRequest<'_>) -> PolicyDecision {
        PolicyDecision::Allow { require_owner: false }
    }
}

/// A store whose read of one name stops until the test lets it go, so a test can change the store
/// while a snapshot of it is half taken.
struct GatedSecrets {
    inner: MemSecrets,
    gate: &'static str,
    reached: Mutex<Option<mpsc::Sender<()>>>,
    go: Mutex<Option<mpsc::Receiver<()>>>,
}

impl SecretSource for GatedSecrets {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let value = self.inner.get(name);
        if name == self.gate {
            if let (Some(tx), Some(rx)) = (self.reached.lock().unwrap().take(), self.go.lock().unwrap().take()) {
                tx.send(()).unwrap();
                rx.recv().unwrap();
            }
        }
        value
    }
    fn put(&self, name: &str, value: &str) -> Result<(), String> {
        self.inner.put(name, value)
    }
    fn can_rotate(&self) -> bool {
        self.inner.can_rotate()
    }
}

fn engine_over(secrets: Arc<dyn SecretSource>, dir: &std::path::Path) -> Engine {
    engine_over_table(ServiceTable::production(), secrets, dir)
}

fn engine_over_table(table: ServiceTable, secrets: Arc<dyn SecretSource>, dir: &std::path::Path) -> Engine {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    Engine::with_client(table, secrets, Arc::new(AllowAll), AuditLog::new(dir.join("audit.jsonl")), Limits::default(), client)
}

#[test]
fn a_snapshot_read_before_a_card_stored_a_token_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let (reached_tx, reached_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel();
    let secrets = Arc::new(GatedSecrets {
        inner: MemSecrets::with(&[("SHORTCUT_API_TOKEN", "old-shortcut")]),
        // The registry is read in order: the Linear key is read before the last entry stops, so the
        // half-taken snapshot holds no Linear key by the time the card stores one.
        gate: crate::api_keys::REGISTRY.last().unwrap().env_name,
        reached: Mutex::new(Some(reached_tx)),
        go: Mutex::new(Some(go_rx)),
    });
    let engine = Arc::new(engine_over(secrets.clone(), dir.path()));
    let reader = { let e = engine.clone(); std::thread::spawn(move || e.stored_secret_values()) };
    reached_rx.recv().unwrap();
    // The replace card stores a new token and clears the engine's memory of the store.
    secrets.inner.map.lock().unwrap().insert("LINEAR_API_KEY".into(), "new-linear".into());
    engine.invalidate_stored();
    go_tx.send(()).unwrap();
    reader.join().unwrap();
    let after = engine.stored_secret_values();
    assert!(after.iter().any(|v| v == "new-linear"), "the older snapshot was cached over the card's write: {after:?}");
}

#[tokio::test]
async fn a_rotated_refresh_token_clears_the_stored_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = mockito::Server::new_async().await;
    let mut table = ServiceTable::production();
    table = table.with_base_url(Service::Hubstaff, &server.url()).with_token_url(Service::Hubstaff, &format!("{}/access_tokens", server.url()));
    let secrets = Arc::new(MemSecrets::with(&[("HUBSTAFF_REFRESH_TOKEN", "rt-1")]));
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let engine = Engine::with_client(table, secrets, Arc::new(AllowAll), AuditLog::new(dir.path().join("audit.jsonl")), Limits::default(), client);
    let _t = server.mock("POST", "/access_tokens").with_status(200).with_body(r#"{"access_token":"at-1","refresh_token":"rt-2","expires_in":3600}"#).create_async().await;
    let _a = server.mock("GET", "/v2/users/me").with_status(200).with_body("{}").create_async().await;
    engine.stored_secret_values();
    assert!(engine.stored.lock().unwrap().is_some());
    engine.call(BrokerRequest::new("s", "hubstaff", "GET", "/v2/users/me", None)).await.unwrap();
    // The store now holds rt-2; the snapshot taken before is gone.
    assert!(engine.stored.lock().unwrap().is_none());
    // The tokens just cached are mirrored for other services' masks, and the card's forget drops both.
    assert_eq!(engine.memory_secrets.lock().unwrap().get(&Service::Hubstaff).map(|v| v.len()), Some(2));
    engine.forget_service(Service::Hubstaff).await;
    assert!(engine.memory_secrets.lock().unwrap().is_empty() && engine.tokens.lock().await.is_empty());
}

#[tokio::test]
async fn forgetting_a_service_drops_its_mirror_only_once_it_holds_the_token_cache() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(engine_over(Arc::new(MemSecrets::default()), dir.path()));
    engine.memory_secrets.lock().unwrap().insert(Service::Hubstaff, vec!["at".into(), "rt".into()]);
    // A refresh in flight holds the cache; a forget that clears the mirror before it has the cache
    // would let that refresh cache a token the mirror then lacks.
    let refreshing = engine.tokens.lock().await;
    let forgetting = { let e = engine.clone(); tokio::spawn(async move { e.forget_service(Service::Hubstaff).await }) };
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(engine.memory_secrets.lock().unwrap().contains_key(&Service::Hubstaff), "the mirror was cleared without the token cache");
    drop(refreshing);
    forgetting.await.unwrap();
    assert!(engine.memory_secrets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_call_to_another_service_does_not_wait_on_a_hubstaff_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = mockito::Server::new_async().await;
    let table = ServiceTable::production().with_base_url(Service::Shortcut, &server.url());
    let secrets = Arc::new(MemSecrets::with(&[("SHORTCUT_API_TOKEN", "sc-1")]));
    let engine = engine_over_table(table, secrets, dir.path());
    let _m = server.mock("GET", "/api/v3/stories/1").with_status(200).with_body("{}").create_async().await;
    // A Hubstaff refresh holds the token cache across its request to the token endpoint.
    let _refreshing = engine.tokens.lock().await;
    let call = engine.call(BrokerRequest::new("s", "shortcut", "GET", "/api/v3/stories/1", None));
    let done = tokio::time::timeout(Duration::from_secs(5), call).await;
    assert!(done.is_ok(), "a Shortcut call stalled behind the Hubstaff token cache");
}

#[test]
fn a_later_failure_keeps_the_unstored_token_note_in_the_audit_reason() {
    let mut ctx = Ctx {
        service: "hubstaff".into(),
        method: "GET".into(),
        path: "/v2/users/me".into(),
        status: None,
        outcome: "error",
        reason: None,
        notes: vec!["rotated refresh token was not stored; held in memory".into()],
        req_bytes: 0,
        resp_bytes: 0,
        masker: None,
        unmasked: false,
    };
    ctx.fail("error", "upstream_timeout", "timed out", None);
    let reason = ctx.audit_reason().unwrap();
    assert!(reason.starts_with("upstream_timeout: timed out"), "{reason}");
    assert!(reason.contains("not stored"), "{reason}");
}

// The engine's masker would hide a URL that leaked into the error text, so
// this checks the raw text `net_error` builds, before any masking.
#[tokio::test]
async fn net_error_text_never_carries_the_request_url() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let err = client.get("http://127.0.0.1:1/1/cards?key=URLCANARY1&token=URLCANARY2").send().await.unwrap_err();
    assert!(err.to_string().contains("URLCANARY1"), "reqwest no longer prints the URL, so this test proves nothing");
    let SendError::Net { message, .. } = net_error(err) else { panic!("expected a net error") };
    assert!(!message.contains("URLCANARY"), "{message}");
}
