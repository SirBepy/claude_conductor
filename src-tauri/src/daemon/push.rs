//! Web Push notifications (ai_todo 119): buzz the phone when a chat blocks on a
//! user prompt (permission / AskUserQuestion) AND the PC has been idle past a
//! threshold. The point is "Joe walked away, Claude is now stuck waiting on
//! him" - so he gets pulled back.
//!
//! Crypto is handled by `web-push-native` (RFC8291 payload encryption + RFC8292
//! VAPID); it produces an `http::Request` and we POST it with the app's existing
//! rustls `reqwest` client - no second TLS stack. Everything here is
//! best-effort: a push failure never touches the chat/prompt path.
//!
//! Persistence: VAPID keypair in `<app_data>/push-vapid.json` (generated once),
//! subscriptions in `<app_data>/push-subscriptions.json`. The daemon is the sole
//! writer of both.
//!
//! The Android app gets native FCM instead: its shell hands the daemon an opaque
//! relay handle + secret (`register_fcm_handle`), persisted in
//! `<app_data>/push-fcm-handles.json`, and the daemon POSTs `{handle, secret,
//! chatId, chatName?}` to the relay, which holds the Firebase credentials.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::json;
use web_push_native::{
    jwt_simple::algorithms::ES256KeyPair, p256::PublicKey, Auth, WebPushBuilder,
};

/// Only notify once the PC has been idle this long (user stepped away).
const IDLE_THRESHOLD_SECS: u64 = 180;

/// VAPID requires a contact (RFC8292); push services use it to reach the app
/// owner about abuse. Joe is the sole user.
const VAPID_CONTACT: &str = "mailto:tecnomon99@gmail.com";

/// Oldest subscriptions are evicted past this. The handler cannot tell which
/// device token enrolled a subscription, so the bound is global rather than
/// per device; one person's phones and browsers fit well inside it.
const MAX_SUBSCRIPTIONS: usize = 20;

/// Real push endpoints and keys are far shorter; the cap stops a token holder
/// from stuffing megabytes into a file that is rewritten on every insert.
const MAX_ENDPOINT_LEN: usize = 2048;
const MAX_KEY_LEN: usize = 256;

/// Real handles are short opaque tokens; the caps stop a token holder from
/// stuffing megabytes into a file that is rewritten on every insert.
const MAX_FCM_HANDLES: usize = 20;
const MAX_HANDLE_LEN: usize = 64;
const MAX_SECRET_LEN: usize = 128;

/// The relay that turns our POST into an FCM message.
pub const DEFAULT_RELAY_BASE: &str =
    "https://europe-west1-claude-conductor-62582.cloudfunctions.net/relay";

/// A slow relay must not pile up tasks behind each blocked prompt.
const RELAY_TIMEOUT_SECS: u64 = 10;

/// Body used when the user turned "show chat name" off.
const GENERIC_BODY: &str = "A chat is waiting on you";

/// The Android shell's relay registration, as `ConductorPush.getHandle()` returns it.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct FcmHandle {
    pub handle: String,
    pub secret: String,
    /// The paired phone (device registry id) that enrolled this handle, so revoking
    /// that device can drop it. Never read from RPC params: only
    /// `register_fcm_handle_for_device` sets it, from the authenticated connection.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// What the relay said about one handle.
#[derive(Debug, PartialEq)]
enum RelayOutcome {
    Delivered,
    /// 404 handle gone, 401 bad secret: the handle can never work again.
    Prune,
    /// 429 and every other status: keep the handle, try on the next prompt.
    Keep,
}

/// A browser PushSubscription as the Push API serializes it (`subscription.toJSON()`).
#[derive(Serialize, Deserialize, Clone)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: SubKeys,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SubKeys {
    /// UA public key, base64url (uncompressed P-256 point).
    pub p256dh: String,
    /// 16-byte auth secret, base64url.
    pub auth: String,
}

pub struct PushManager {
    app_data: PathBuf,
    vapid: ES256KeyPair,
    /// VAPID public key as the browser `applicationServerKey` (base64url SEC1).
    vapid_public_b64: String,
    subs: Mutex<Vec<PushSubscription>>,
    fcm_handles: Mutex<Vec<FcmHandle>>,
    /// Relay base URL without a trailing slash; a field so tests can aim it at a mock.
    relay_base: String,
    http: reqwest::Client,
    /// session_id -> last prompt id we fired for, so a re-registered prompt
    /// (same id) can't double-buzz. A genuinely new prompt has a new id.
    last_fired: Mutex<HashMap<String, String>>,
}

impl PushManager {
    /// Load (or generate) the VAPID key and the stored subscriptions. Sync file
    /// IO, called once at daemon startup.
    pub fn load(app_data: PathBuf) -> Arc<Self> {
        Self::load_with_relay(app_data, DEFAULT_RELAY_BASE)
    }

    pub fn load_with_relay(app_data: PathBuf, relay_base: &str) -> Arc<Self> {
        let vapid = load_or_create_vapid(&app_data);
        let vapid_public_b64 = vapid_public_key_b64(&vapid);
        let subs = load_subs(&app_data);
        let fcm_handles = load_fcm_handles(&app_data);
        Arc::new(Self {
            app_data,
            vapid,
            vapid_public_b64,
            subs: Mutex::new(subs),
            fcm_handles: Mutex::new(fcm_handles),
            relay_base: relay_base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(RELAY_TIMEOUT_SECS))
                .build()
                .unwrap_or_default(),
            last_fired: Mutex::new(HashMap::new()),
        })
    }

    pub fn vapid_public(&self) -> &str {
        &self.vapid_public_b64
    }

    /// Register a subscription (dedup by endpoint) and persist. `false` when
    /// the subscription is oversized and was refused. Past `MAX_SUBSCRIPTIONS`
    /// the oldest entries are dropped.
    pub fn subscribe(&self, sub: PushSubscription) -> bool {
        if sub.endpoint.len() > MAX_ENDPOINT_LEN
            || sub.keys.p256dh.len() > MAX_KEY_LEN
            || sub.keys.auth.len() > MAX_KEY_LEN
        {
            log::warn!("[push] refused an oversized subscription");
            return false;
        }
        let snapshot = {
            let mut subs = self.subs.lock().unwrap();
            subs.retain(|s| s.endpoint != sub.endpoint);
            subs.push(sub);
            if subs.len() > MAX_SUBSCRIPTIONS {
                let excess = subs.len() - MAX_SUBSCRIPTIONS;
                subs.drain(..excess);
                log::warn!("[push] subscription cap hit, evicted {excess} oldest");
            }
            subs.clone()
        };
        self.persist(&snapshot);
        true
    }

    /// Drop a subscription by endpoint and persist.
    pub fn unsubscribe(&self, endpoint: &str) {
        let snapshot = {
            let mut subs = self.subs.lock().unwrap();
            subs.retain(|s| s.endpoint != endpoint);
            subs.clone()
        };
        self.persist(&snapshot);
    }

    /// Register an Android relay handle (dedup by handle, newest last) and
    /// persist. `false` when empty or oversized and refused.
    pub fn register_fcm_handle(&self, mut h: FcmHandle) -> bool {
        h.device_id = None; // params are untrusted; see `register_fcm_handle_for_device`
        if h.handle.is_empty()
            || h.secret.is_empty()
            || h.handle.len() > MAX_HANDLE_LEN
            || h.secret.len() > MAX_SECRET_LEN
        {
            log::warn!("[push] refused an empty or oversized FCM handle");
            return false;
        }
        let snapshot = {
            let mut hs = self.fcm_handles.lock().unwrap();
            hs.retain(|x| x.handle != h.handle);
            hs.push(h);
            if hs.len() > MAX_FCM_HANDLES {
                let excess = hs.len() - MAX_FCM_HANDLES;
                hs.drain(..excess);
                log::warn!("[push] FCM handle cap hit, evicted {excess} oldest");
            }
            hs.clone()
        };
        self.persist_fcm(&snapshot);
        true
    }

    /// Register a handle on behalf of an authenticated paired device, so
    /// `unregister_fcm_handles_for_device` can find it when that device is revoked.
    pub fn register_fcm_handle_for_device(&self, h: FcmHandle, device_id: &str) -> bool {
        let handle = h.handle.clone();
        if !self.register_fcm_handle(h) {
            return false;
        }
        let snapshot = {
            let mut hs = self.fcm_handles.lock().unwrap();
            if let Some(x) = hs.iter_mut().find(|x| x.handle == handle) {
                x.device_id = Some(device_id.to_string());
            }
            hs.clone()
        };
        self.persist_fcm(&snapshot);
        true
    }

    /// Drop every handle a revoked/unpaired device enrolled and persist. Legacy
    /// handles with no recorded device stay until a relay 404 prunes them.
    pub fn unregister_fcm_handles_for_device(&self, device_id: &str) -> usize {
        let (removed, snapshot) = {
            let mut hs = self.fcm_handles.lock().unwrap();
            let before = hs.len();
            hs.retain(|x| x.device_id.as_deref() != Some(device_id));
            (before - hs.len(), hs.clone())
        };
        if removed > 0 {
            self.persist_fcm(&snapshot);
        }
        removed
    }

    /// Drop an FCM handle by value and persist.
    pub fn unregister_fcm_handle(&self, handle: &str) {
        let snapshot = {
            let mut hs = self.fcm_handles.lock().unwrap();
            hs.retain(|x| x.handle != handle);
            hs.clone()
        };
        self.persist_fcm(&snapshot);
    }

    /// Fire a "Claude is blocked on you" push if the PC is idle and we haven't
    /// already fired for this exact prompt. Best-effort; swallows all errors.
    pub async fn maybe_notify_blocked(
        self: Arc<Self>,
        session_id: Option<String>,
        session_name: String,
        prompt_id: String,
        show_chat_name: bool,
    ) {
        if crate::daemon::idle::idle_secs() < IDLE_THRESHOLD_SECS {
            return; // Joe is at the desk - the in-app card already surfaces it.
        }
        if let Some(sid) = &session_id {
            let mut lf = self.last_fired.lock().unwrap();
            if lf.get(sid).map(|p| p == &prompt_id).unwrap_or(false) {
                return; // already buzzed for this prompt
            }
            lf.insert(sid.clone(), prompt_id.clone());
        }

        self.notify_all(session_id.as_deref(), &session_name, show_chat_name).await;
    }

    /// The relay and Web Push go out side by side: a relay that is slow or
    /// down (10s timeout per handle) must never hold back the Web Push.
    async fn notify_all(&self, session_id: Option<&str>, name: &str, show_chat_name: bool) {
        tokio::join!(
            self.notify_fcm(session_id, name, show_chat_name),
            self.notify_web_push(session_id, name, show_chat_name),
        );
    }

    async fn notify_web_push(&self, session_id: Option<&str>, name: &str, show_chat_name: bool) {
        let subs = self.subs.lock().unwrap().clone();
        if subs.is_empty() {
            return;
        }
        let payload = web_push_payload(session_id, name, show_chat_name);
        let results = futures_util::future::join_all(subs.iter().map(|sub| self.send_one(sub, &payload))).await;

        let mut dead: Vec<String> = Vec::new();
        for (sub, result) in subs.iter().zip(results) {
            match result {
                Ok(true) => {}
                Ok(false) => dead.push(sub.endpoint.clone()), // expired -> prune
                Err(e) => log::debug!("[push] send to {} failed: {e}", sub.endpoint),
            }
        }
        if !dead.is_empty() {
            let snapshot = {
                let mut subs = self.subs.lock().unwrap();
                subs.retain(|s| !dead.contains(&s.endpoint));
                subs.clone()
            };
            self.persist(&snapshot);
            log::info!("[push] pruned {} expired subscription(s)", dead.len());
        }
    }

    /// POST one relay request per stored handle, all at once, pruning the ones
    /// the relay rejects for good. Transient failures keep the handle. Skipped
    /// without a session id: the notification tap needs a chat to open.
    async fn notify_fcm(&self, session_id: Option<&str>, name: &str, show_chat_name: bool) {
        let Some(chat_id) = session_id else { return };
        let handles = self.fcm_handles.lock().unwrap().clone();
        if handles.is_empty() {
            return;
        }
        let bodies: Vec<_> = handles.iter().map(|h| fcm_payload(h, chat_id, name, show_chat_name)).collect();
        let results = futures_util::future::join_all(bodies.iter().map(|b| self.send_relay(b))).await;
        let mut dead: Vec<String> = Vec::new();
        for (h, result) in handles.iter().zip(results) {
            match result {
                Ok(RelayOutcome::Prune) => dead.push(h.handle.clone()),
                Ok(RelayOutcome::Delivered | RelayOutcome::Keep) => {}
                Err(e) => log::debug!("[push] relay send failed: {e}"),
            }
        }
        if !dead.is_empty() {
            let snapshot = {
                let mut hs = self.fcm_handles.lock().unwrap();
                hs.retain(|x| !dead.contains(&x.handle));
                hs.clone()
            };
            self.persist_fcm(&snapshot);
            log::info!("[push] pruned {} dead FCM handle(s)", dead.len());
        }
    }

    async fn send_relay(&self, body: &serde_json::Value) -> anyhow::Result<RelayOutcome> {
        let resp = self
            .http
            .post(format!("{}/send", self.relay_base))
            .json(body)
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status == 401 || status == 404 {
            let error = resp.json::<serde_json::Value>().await.ok().and_then(|b| b["error"].as_str().map(str::to_string));
            return Ok(relay_rejection(status, error.as_deref()));
        }
        Ok(match status {
            204 => RelayOutcome::Delivered,
            429 => {
                log::debug!("[push] relay rate limited this handle");
                RelayOutcome::Keep
            }
            other => {
                log::debug!("[push] relay answered {other}");
                RelayOutcome::Keep
            }
        })
    }

    /// Send one encrypted push. `Ok(true)` delivered, `Ok(false)` the
    /// subscription is gone (404/410 -> prune it), `Err` transient.
    async fn send_one(&self, sub: &PushSubscription, payload: &[u8]) -> anyhow::Result<bool> {
        let p256dh = Base64UrlUnpadded::decode_vec(&sub.keys.p256dh)
            .map_err(|e| anyhow::anyhow!("bad p256dh: {e}"))?;
        let auth_bytes = Base64UrlUnpadded::decode_vec(&sub.keys.auth)
            .map_err(|e| anyhow::anyhow!("bad auth: {e}"))?;
        if auth_bytes.len() != 16 {
            anyhow::bail!("auth secret must be 16 bytes, got {}", auth_bytes.len());
        }
        let builder = WebPushBuilder::new(
            sub.endpoint.parse()?,
            PublicKey::from_sec1_bytes(&p256dh)?,
            Auth::clone_from_slice(&auth_bytes),
        )
        .with_vapid(&self.vapid, VAPID_CONTACT);
        let request = builder.build(payload.to_vec())?;

        let resp = self
            .http
            .post(request.uri().to_string())
            .headers(request.headers().clone())
            .body(request.body().clone())
            .send()
            .await?;
        let status = resp.status().as_u16();
        Ok(status != 404 && status != 410)
    }

    fn persist_fcm(&self, handles: &[FcmHandle]) {
        match serde_json::to_string(handles) {
            Ok(json) => {
                if let Err(e) = crate::util::write_json_atomic(&fcm_path(&self.app_data), &json) {
                    log::warn!("[push] persist FCM handles failed: {e}");
                }
            }
            Err(e) => log::warn!("[push] serialize FCM handles failed: {e}"),
        }
    }

    fn persist(&self, subs: &[PushSubscription]) {
        let path = subs_path(&self.app_data);
        match serde_json::to_string(subs) {
            Ok(json) => {
                if let Err(e) = crate::util::write_json_atomic(&path, &json) {
                    log::warn!("[push] persist subscriptions failed: {e}");
                }
            }
            Err(e) => log::warn!("[push] serialize subscriptions failed: {e}"),
        }
    }
}

/// A 401/404 prunes a handle only when the relay itself says the handle is
/// gone. A bare 404 from a moved or misrouted relay URL must not wipe every
/// phone's enrolment.
fn relay_rejection(status: u16, error: Option<&str>) -> RelayOutcome {
    match (status, error) {
        (404, Some("unknown handle" | "token no longer valid")) | (401, Some("bad secret")) => RelayOutcome::Prune,
        _ => {
            log::debug!("[push] relay answered {status} {error:?}");
            RelayOutcome::Keep
        }
    }
}

/// The Web Push payload; a generic body when the user hides chat names.
fn web_push_payload(session_id: Option<&str>, name: &str, show_chat_name: bool) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "title": "Claude needs your input",
        "body": if show_chat_name { name } else { GENERIC_BODY },
        // Same session collapses to one banner (renotify re-alerts).
        "tag": session_id.unwrap_or("claude-blocked"),
        "url": "/",
    }))
    .unwrap_or_default()
}

/// The relay request body. `chatName` is left out entirely (not null) when
/// hidden, so the relay's own default text applies.
fn fcm_payload(h: &FcmHandle, chat_id: &str, name: &str, show_chat_name: bool) -> serde_json::Value {
    let mut body = json!({
        "handle": h.handle,
        "secret": h.secret,
        "chatId": chat_id,
    });
    if show_chat_name {
        body["chatName"] = json!(name);
    }
    body
}

fn fcm_path(app_data: &Path) -> PathBuf {
    app_data.join("push-fcm-handles.json")
}

fn load_fcm_handles(app_data: &Path) -> Vec<FcmHandle> {
    std::fs::read_to_string(fcm_path(app_data))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<FcmHandle>>(&raw).ok())
        .unwrap_or_default()
}

fn vapid_path(app_data: &Path) -> PathBuf {
    app_data.join("push-vapid.json")
}
fn subs_path(app_data: &Path) -> PathBuf {
    app_data.join("push-subscriptions.json")
}

fn load_or_create_vapid(app_data: &Path) -> ES256KeyPair {
    if let Ok(raw) = std::fs::read_to_string(vapid_path(app_data)) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(b64) = v.get("vapid").and_then(|x| x.as_str()) {
                if let Ok(bytes) = Base64UrlUnpadded::decode_vec(b64) {
                    if let Ok(kp) = ES256KeyPair::from_bytes(&bytes) {
                        return kp;
                    }
                }
            }
        }
        log::warn!("[push] push-vapid.json unreadable; regenerating (existing phone subs will need re-enable)");
    }
    let kp = ES256KeyPair::generate();
    let b64 = Base64UrlUnpadded::encode_string(&kp.to_bytes());
    let _ = crate::util::write_json_atomic(
        &vapid_path(app_data),
        &serde_json::to_string(&json!({ "vapid": b64 })).unwrap_or_default(),
    );
    kp
}

/// The browser `applicationServerKey` is the uncompressed SEC1 P-256 point
/// (65 bytes, 0x04-prefixed) as base64url. `ES256PublicKey::to_bytes()` is
/// COMPRESSED (33 bytes) which browsers reject, so reach the inner P256 key via
/// the keypair-like trait and take its uncompressed encoding.
fn vapid_public_key_b64(kp: &ES256KeyPair) -> String {
    use web_push_native::jwt_simple::algorithms::ECDSAP256PublicKeyLike;
    let es_pub = kp.public_key();
    let bytes = es_pub.public_key().to_bytes_uncompressed();
    Base64UrlUnpadded::encode_string(&bytes)
}

fn load_subs(app_data: &Path) -> Vec<PushSubscription> {
    std::fs::read_to_string(subs_path(app_data))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<PushSubscription>>(&raw).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(endpoint: &str) -> PushSubscription {
        PushSubscription {
            endpoint: endpoint.to_string(),
            keys: SubKeys { p256dh: "x".into(), auth: "y".into() },
        }
    }

    #[test]
    fn subscribe_dedups_by_endpoint_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        pm.subscribe(sub("https://fcm/a"));
        pm.subscribe(sub("https://fcm/b"));
        pm.subscribe(sub("https://fcm/a")); // duplicate endpoint
        assert_eq!(pm.subs.lock().unwrap().len(), 2);

        // Persisted and reloaded identically.
        let pm2 = PushManager::load(dir.path().to_path_buf());
        assert_eq!(pm2.subs.lock().unwrap().len(), 2);
    }

    #[test]
    fn subscribe_caps_the_store_and_evicts_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        for i in 0..(MAX_SUBSCRIPTIONS + 5) {
            assert!(pm.subscribe(sub(&format!("https://fcm/{i}"))));
        }
        let subs = pm.subs.lock().unwrap();
        assert_eq!(subs.len(), MAX_SUBSCRIPTIONS);
        assert_eq!(subs[0].endpoint, "https://fcm/5", "oldest five evicted");
        assert_eq!(subs.last().unwrap().endpoint, format!("https://fcm/{}", MAX_SUBSCRIPTIONS + 4));
        drop(subs);
        let reloaded = PushManager::load(dir.path().to_path_buf());
        assert_eq!(reloaded.subs.lock().unwrap().len(), MAX_SUBSCRIPTIONS, "cap holds on disk too");
    }

    #[test]
    fn subscribe_refuses_oversized_fields() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        assert!(!pm.subscribe(sub(&"e".repeat(MAX_ENDPOINT_LEN + 1))));
        let mut big_key = sub("https://fcm/a");
        big_key.keys.p256dh = "k".repeat(MAX_KEY_LEN + 1);
        assert!(!pm.subscribe(big_key));
        assert!(pm.subs.lock().unwrap().is_empty());
    }

    #[test]
    fn unsubscribe_removes_by_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        pm.subscribe(sub("https://fcm/a"));
        pm.subscribe(sub("https://fcm/b"));
        pm.unsubscribe("https://fcm/a");
        let subs = pm.subs.lock().unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].endpoint, "https://fcm/b");
    }

    fn handle(h: &str) -> FcmHandle {
        FcmHandle { handle: h.into(), secret: "dummy-secret".into(), device_id: None }
    }

    #[test]
    fn fcm_handles_dedup_cap_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        assert!(pm.register_fcm_handle(handle("a")));
        assert!(pm.register_fcm_handle(handle("b")));
        assert!(pm.register_fcm_handle(handle("a"))); // duplicate handle
        assert_eq!(pm.fcm_handles.lock().unwrap().len(), 2);

        let pm2 = PushManager::load(dir.path().to_path_buf());
        assert_eq!(pm2.fcm_handles.lock().unwrap().len(), 2, "persisted");

        for i in 0..(MAX_FCM_HANDLES + 5) {
            assert!(pm.register_fcm_handle(handle(&format!("h{i}"))));
        }
        let hs = pm.fcm_handles.lock().unwrap();
        assert_eq!(hs.len(), MAX_FCM_HANDLES);
        assert_eq!(hs.last().unwrap().handle, format!("h{}", MAX_FCM_HANDLES + 4));
        assert!(!hs.iter().any(|x| x.handle == "a"), "oldest evicted");
    }

    #[test]
    fn revoking_a_device_drops_only_its_handles() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        assert!(pm.register_fcm_handle_for_device(handle("a1"), "dev-a"));
        assert!(pm.register_fcm_handle_for_device(handle("a2"), "dev-a"));
        assert!(pm.register_fcm_handle_for_device(handle("b1"), "dev-b"));
        // A client-claimed device id in params must not survive plain registration.
        let mut forged = handle("f1");
        forged.device_id = Some("dev-b".into());
        assert!(pm.register_fcm_handle(forged));
        assert_eq!(pm.unregister_fcm_handles_for_device("dev-a"), 2);
        let left: Vec<String> = pm.fcm_handles.lock().unwrap().iter().map(|x| x.handle.clone()).collect();
        assert_eq!(left, vec!["b1".to_string(), "f1".to_string()]);
        assert_eq!(load_fcm_handles(dir.path()).len(), 2, "removal persisted");
        assert_eq!(pm.unregister_fcm_handles_for_device("dev-b"), 1, "forged id was not kept");
        assert_eq!(pm.unregister_fcm_handles_for_device("nobody"), 0);
    }

    #[test]
    fn fcm_handles_refuse_oversized_or_empty_and_unregister() {
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load(dir.path().to_path_buf());
        assert!(!pm.register_fcm_handle(handle(&"h".repeat(MAX_HANDLE_LEN + 1))));
        assert!(!pm.register_fcm_handle(FcmHandle {
            handle: "a".into(),
            secret: "s".repeat(MAX_SECRET_LEN + 1),
            device_id: None,
        }));
        assert!(!pm.register_fcm_handle(handle("")));
        assert!(pm.fcm_handles.lock().unwrap().is_empty());
        pm.register_fcm_handle(handle("a"));
        pm.unregister_fcm_handle("a");
        assert!(pm.fcm_handles.lock().unwrap().is_empty());
        assert!(load_fcm_handles(dir.path()).is_empty(), "removal persisted");
    }

    #[test]
    fn payloads_omit_the_chat_name_when_hidden() {
        let h = handle("a");
        let shown = fcm_payload(&h, "sid", "My chat", true);
        assert_eq!(shown["chatName"], "My chat");
        assert_eq!(shown["chatId"], "sid");
        let hidden = fcm_payload(&h, "sid", "My chat", false);
        assert!(hidden.get("chatName").is_none());

        let web: serde_json::Value =
            serde_json::from_slice(&web_push_payload(Some("sid"), "My chat", true)).unwrap();
        assert_eq!(web["body"], "My chat");
        let web: serde_json::Value =
            serde_json::from_slice(&web_push_payload(Some("sid"), "My chat", false)).unwrap();
        assert_eq!(web["body"], GENERIC_BODY);
        assert!(!web.to_string().contains("My chat"));
    }

    /// Handle count after one relay call answered with `status`.
    async fn handles_left_after(status: usize, error: &str) -> usize {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/send")
            .match_body(mockito::Matcher::PartialJson(
                json!({"handle": "a", "secret": "dummy-secret", "chatId": "sid"}),
            ))
            .with_status(status)
            .with_body(if error.is_empty() { String::new() } else { json!({ "error": error }).to_string() })
            .expect(1)
            .create_async()
            .await;
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load_with_relay(dir.path().to_path_buf(), &server.url());
        pm.register_fcm_handle(handle("a"));
        pm.notify_fcm(Some("sid"), "My chat", true).await;
        mock.assert_async().await;
        let in_memory = pm.fcm_handles.lock().unwrap().len();
        assert_eq!(in_memory, load_fcm_handles(dir.path()).len(), "memory and disk agree");
        in_memory
    }

    #[tokio::test]
    async fn relay_prunes_on_its_own_handle_gone_replies() {
        assert_eq!(handles_left_after(404, "unknown handle").await, 0);
        assert_eq!(handles_left_after(404, "token no longer valid").await, 0);
        assert_eq!(handles_left_after(401, "bad secret").await, 0);
    }

    #[tokio::test]
    async fn a_404_that_is_not_the_relay_saying_so_keeps_the_handle() {
        assert_eq!(handles_left_after(404, "").await, 1);
        assert_eq!(handles_left_after(404, "not found").await, 1);
    }

    #[tokio::test]
    async fn relay_keeps_on_204_429_and_500() {
        for s in [204, 429, 500] {
            assert_eq!(handles_left_after(s, "").await, 1, "status {s}");
        }
    }

    /// A relay that accepts and never answers (until the client's 10s timeout)
    /// must not hold back the Web Push.
    #[tokio::test]
    async fn web_push_goes_out_while_the_relay_hangs() {
        let hung = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay = format!("http://{}", hung.local_addr().unwrap());
        let holder = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = hung.accept().await {
                held.push(sock);
            }
        });
        let mut wp = mockito::Server::new_async().await;
        let web_push = wp.mock("POST", "/wp").with_status(201).expect(1).create_async().await;

        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load_with_relay(dir.path().to_path_buf(), &relay);
        pm.register_fcm_handle(handle("a"));
        pm.subscribe(PushSubscription {
            endpoint: format!("{}/wp", wp.url()),
            keys: SubKeys {
                p256dh: vapid_public_key_b64(&ES256KeyPair::generate()),
                auth: Base64UrlUnpadded::encode_string(&[7u8; 16]),
            },
        });
        let sending = {
            let pm = pm.clone();
            tokio::spawn(async move { pm.notify_all(Some("sid"), "My chat", true).await })
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !web_push.matched_async().await {
            assert!(std::time::Instant::now() < deadline, "Web Push waited on the hung relay");
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(!sending.is_finished(), "the relay request is still hanging");
        sending.abort();
        holder.abort();
    }

    #[tokio::test]
    async fn relay_request_has_no_chat_name_when_hidden() {
        let mut server = mockito::Server::new_async().await;
        // The regex crate has no lookahead, so absence is asserted as "the
        // mock for a body containing chatName is never hit".
        let with_name = server
            .mock("POST", "/send")
            .match_body(mockito::Matcher::Regex("chatName".into()))
            .with_status(500)
            .expect(0)
            .create_async()
            .await;
        let mock = server.mock("POST", "/send").with_status(204).expect(1).create_async().await;
        let dir = tempfile::tempdir().unwrap();
        let pm = PushManager::load_with_relay(dir.path().to_path_buf(), &server.url());
        pm.register_fcm_handle(handle("a"));
        pm.notify_fcm(Some("sid"), "Secret chat", false).await;
        with_name.assert_async().await;
        mock.assert_async().await;
    }

    #[test]
    fn vapid_key_persists_across_loads() {
        let dir = tempfile::tempdir().unwrap();
        let a = PushManager::load(dir.path().to_path_buf());
        let b = PushManager::load(dir.path().to_path_buf());
        // Same key file -> same public key (not regenerated).
        assert_eq!(a.vapid_public(), b.vapid_public());
        assert!(!a.vapid_public().is_empty());
    }
}
