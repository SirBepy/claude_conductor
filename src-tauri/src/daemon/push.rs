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
    http: reqwest::Client,
    /// session_id -> last prompt id we fired for, so a re-registered prompt
    /// (same id) can't double-buzz. A genuinely new prompt has a new id.
    last_fired: Mutex<HashMap<String, String>>,
}

impl PushManager {
    /// Load (or generate) the VAPID key and the stored subscriptions. Sync file
    /// IO, called once at daemon startup.
    pub fn load(app_data: PathBuf) -> Arc<Self> {
        let vapid = load_or_create_vapid(&app_data);
        let vapid_public_b64 = vapid_public_key_b64(&vapid);
        let subs = load_subs(&app_data);
        Arc::new(Self {
            app_data,
            vapid,
            vapid_public_b64,
            subs: Mutex::new(subs),
            http: reqwest::Client::new(),
            last_fired: Mutex::new(HashMap::new()),
        })
    }

    pub fn vapid_public(&self) -> &str {
        &self.vapid_public_b64
    }

    /// Register a subscription (dedup by endpoint) and persist.
    pub fn subscribe(&self, sub: PushSubscription) {
        let snapshot = {
            let mut subs = self.subs.lock().unwrap();
            subs.retain(|s| s.endpoint != sub.endpoint);
            subs.push(sub);
            subs.clone()
        };
        self.persist(&snapshot);
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

    /// Fire a "Claude is blocked on you" push if the PC is idle and we haven't
    /// already fired for this exact prompt. Best-effort; swallows all errors.
    pub async fn maybe_notify_blocked(
        self: Arc<Self>,
        session_id: Option<String>,
        session_name: String,
        prompt_id: String,
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

        let subs = self.subs.lock().unwrap().clone();
        if subs.is_empty() {
            return;
        }
        let payload = serde_json::to_vec(&json!({
            "title": "Claude needs your input",
            "body": session_name,
            // Same session collapses to one banner (renotify re-alerts).
            "tag": session_id.clone().unwrap_or_else(|| "claude-blocked".into()),
            "url": "/",
        }))
        .unwrap_or_default();

        let mut dead: Vec<String> = Vec::new();
        for sub in &subs {
            match self.send_one(sub, &payload).await {
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
