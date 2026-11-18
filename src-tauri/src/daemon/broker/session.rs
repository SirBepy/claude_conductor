//! Per-session broker tokens: what a chat's `CC_BROKER_TOKEN` is and how the
//! daemon checks it.
//!
//! A token is `ccb1.<session>.<role>.<services>.<epoch>.<mac>` where `mac` is
//! HMAC-SHA256 over the five fields before it, keyed by a random per-process
//! daemon key that is never written anywhere. The fields are not secret; the
//! mac is what makes them unforgeable, so no other credential works here: not
//! the daemon's own token file (`remote-access-token.txt`), not another
//! session's token, not a token whose fields were edited.
//!
//! Stability: the token is a pure function of (key, claims, epoch), so the
//! per-turn respawn, which mints again from the same inputs, hands the chat the
//! same value for as long as its binding does not change. Revocation: closing a
//! chat bumps its epoch and drops its claims, which kills every token already
//! issued for it; a later resume mints under the new epoch, so an old copy of
//! the token never works again. The key lives in memory only, so a daemon
//! restart invalidates every token, and the next spawn of each chat issues a
//! new one (a chat's `claude` child dies with the daemon).

use super::binding::normalize;
use super::engine::BrokerRequest;
use super::services::Service;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

/// Env var the chat's child process carries.
pub const ENV_NAME: &str = "CC_BROKER_TOKEN";

const VERSION: &str = "ccb1";
/// A real token is about 150 bytes; anything longer is not one.
const MAX_TOKEN_LEN: usize = 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// A main or plain chat (autopilot is a flag on one, not a role).
    Chat,
    /// A hidden sub of a main chat.
    Sub,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Chat => "chat",
            Role::Sub => "sub",
        }
    }

    fn parse(s: &str) -> Option<Role> {
        [Role::Chat, Role::Sub].into_iter().find(|r| r.name() == s)
    }
}

/// What a verified token says about its holder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionClaims {
    pub session_id: String,
    pub role: Role,
    /// Sorted by name, no repeats.
    pub services: Vec<Service>,
}

impl SessionClaims {
    pub fn new(session_id: &str, role: Role, services: Vec<Service>) -> Self {
        Self { session_id: session_id.to_string(), role, services: normalize(services) }
    }

    /// A call carrying this session's id and bound set, so the engine refuses a
    /// service outside it. A front builds every chat-originated request here.
    pub fn request(&self, service: &str, method: &str, path: &str, body: Option<serde_json::Value>) -> BrokerRequest {
        let mut req = BrokerRequest::new(&self.session_id, service, method, path, body);
        req.bound_services = Some(self.services.clone());
        req
    }

    fn services_field(&self) -> String {
        if self.services.is_empty() {
            "-".to_string()
        } else {
            self.services.iter().map(|s| s.name()).collect::<Vec<_>>().join(",")
        }
    }
}

/// A minted token. `Debug` never prints it, and the one way to read it is
/// [`BrokerToken::expose`], which `lifecycle::broker_env::apply` calls once to set the env var.
pub struct BrokerToken(String);

impl BrokerToken {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for BrokerToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BrokerToken(redacted)")
    }
}

/// Why a presented token was refused. The reason is for tests and the log; a
/// front tells the chat only [`TokenError::message`], so a probe learns nothing
/// about which check failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    BadSignature,
    /// Signed by this daemon, but the session was closed or its binding changed.
    Revoked,
    /// A valid token, but for another session than the channel it arrived on names.
    WrongSession,
}

impl TokenError {
    pub fn message(self) -> &'static str {
        "the broker token is missing, malformed, revoked or not from this session"
    }
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

struct Entry {
    epoch: u64,
    /// What the latest mint recorded; `None` once revoked.
    claims: Option<SessionClaims>,
}

pub struct BrokerSessions {
    key: [u8; 32],
    entries: Mutex<HashMap<String, Entry>>,
}

impl Default for BrokerSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl BrokerSessions {
    pub fn new() -> Self {
        use rand::RngCore;
        let mut key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        Self { key, entries: Mutex::new(HashMap::new()) }
    }

    #[cfg(test)]
    fn with_key(key: [u8; 32]) -> Self {
        Self { key, entries: Mutex::new(HashMap::new()) }
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn mac(&self, session: &str, role: &str, services: &str, epoch: u64) -> String {
        let msg = format!("{VERSION}\0{session}\0{role}\0{services}\0{epoch}");
        hex(&hmac_sha256(&self.key, msg.as_bytes()))
    }

    /// Issues the token for a launch and records its claims as the session's
    /// current ones. Called at every spawn, so a changed binding replaces the
    /// previous token's claims (the old value stops verifying).
    pub fn mint(&self, claims: SessionClaims) -> BrokerToken {
        let mut entries = self.entries();
        let entry = entries.entry(claims.session_id.clone()).or_insert(Entry { epoch: 0, claims: None });
        entry.claims = Some(claims.clone());
        let (role, services, epoch) = (claims.role.name(), claims.services_field(), entry.epoch);
        let mac = self.mac(&claims.session_id, role, &services, epoch);
        BrokerToken(format!("{VERSION}.{}.{role}.{services}.{epoch}.{mac}", claims.session_id))
    }

    /// The claims a presented token proves, or why it does not.
    pub fn verify(&self, presented: &str) -> Result<SessionClaims, TokenError> {
        if presented.len() > MAX_TOKEN_LEN {
            return Err(TokenError::Malformed);
        }
        let parts: Vec<&str> = presented.split('.').collect();
        let [version, session, role, services, epoch, mac] = parts[..] else {
            return Err(TokenError::Malformed);
        };
        if version != VERSION || session.is_empty() || mac.len() != 64 {
            return Err(TokenError::Malformed);
        }
        let epoch_text = epoch;
        let epoch: u64 = epoch.parse().map_err(|_| TokenError::Malformed)?;
        // One spelling per token (`+0` and `00` parse to 0): a front that keys a cache or a
        // rate limit on the string must not see several strings for one token.
        if epoch.to_string() != epoch_text {
            return Err(TokenError::Malformed);
        }
        // Compared before any field is interpreted, so an edited field fails here.
        let expected = self.mac(session, role, services, epoch);
        if !constant_time_eq(expected.as_bytes(), mac.as_bytes()) {
            return Err(TokenError::BadSignature);
        }
        let role = Role::parse(role).ok_or(TokenError::Malformed)?;
        let services: Vec<Service> = if services == "-" {
            Vec::new()
        } else {
            services.split(',').map(|n| Service::parse(n).filter(|s| s.name() == n).ok_or(TokenError::Malformed)).collect::<Result<_, _>>()?
        };
        let claims = SessionClaims::new(session, role, services);
        let entries = self.entries();
        match entries.get(session) {
            Some(e) if e.epoch == epoch && e.claims.as_ref() == Some(&claims) => Ok(claims),
            _ => Err(TokenError::Revoked),
        }
    }

    /// [`verify`](Self::verify) for a front that already knows the caller's
    /// session from its own channel (a hook or MCP child): a token that is valid
    /// but belongs to another session is refused as well.
    pub fn verify_for(&self, presented: &str, session_id: &str) -> Result<SessionClaims, TokenError> {
        let claims = self.verify(presented)?;
        if claims.session_id == session_id {
            Ok(claims)
        } else {
            Err(TokenError::WrongSession)
        }
    }

    /// Kills every token issued for the session so far. A later `mint` (a
    /// resume) issues under the next epoch.
    pub fn revoke(&self, session_id: &str) {
        let mut entries = self.entries();
        let entry = entries.entry(session_id.to_string()).or_insert(Entry { epoch: 0, claims: None });
        entry.epoch += 1;
        entry.claims = None;
    }

    /// The claims the session was last launched with, if it has not been revoked
    /// since. For an in-daemon front that already knows the caller's session id
    /// from its own channel (the MCP tools) and needs its bound set.
    pub fn current(&self, session_id: &str) -> Option<SessionClaims> {
        self.entries().get(session_id).and_then(|e| e.claims.clone())
    }
}

/// HMAC-SHA256 (RFC 2104) from the `sha2` already in the tree.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// No early exit on the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> BrokerSessions {
        BrokerSessions::with_key([7u8; 32])
    }

    fn claims(id: &str, services: &[Service]) -> SessionClaims {
        SessionClaims::new(id, Role::Chat, services.to_vec())
    }

    // RFC 4231 test cases 1, 2 and 6 (a key longer than the block size).
    #[test]
    fn hmac_matches_the_rfc_4231_vectors() {
        assert_eq!(hex(&hmac_sha256(&[0x0b; 20], b"Hi There")), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        assert_eq!(hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        assert_eq!(
            hex(&hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn a_minted_token_verifies_to_its_claims() {
        let s = sessions();
        let c = claims("sess-a", &[Service::Shortcut, Service::Figma]);
        let t = s.mint(c.clone());
        assert_eq!(s.verify(t.expose()), Ok(c));
    }

    #[test]
    fn the_token_is_stable_across_respawns_and_changes_with_the_binding() {
        let s = sessions();
        let a = s.mint(claims("sess-a", &[Service::Figma, Service::Shortcut]));
        let again = s.mint(claims("sess-a", &[Service::Shortcut, Service::Figma, Service::Figma]));
        assert_eq!(a.expose(), again.expose(), "per-turn respawn: same inputs, same token");
        let wider = s.mint(claims("sess-a", &[Service::Figma, Service::Shortcut, Service::Linear]));
        assert_ne!(a.expose(), wider.expose());
        assert_eq!(s.verify(a.expose()), Err(TokenError::Revoked), "the old binding no longer verifies");
        assert!(s.verify(wider.expose()).is_ok());
    }

    #[test]
    fn another_sessions_token_is_not_this_sessions_token() {
        let s = sessions();
        let a = s.mint(claims("sess-a", &[Service::Figma]));
        let b = s.mint(claims("sess-b", &[Service::Figma]));
        assert_eq!(s.verify(a.expose()).unwrap().session_id, "sess-a");
        assert_eq!(s.verify(b.expose()).unwrap().session_id, "sess-b");
        // Swapping the session field of A's token for B's id breaks the mac.
        let swapped = a.expose().replace("sess-a", "sess-b");
        assert_eq!(s.verify(&swapped), Err(TokenError::BadSignature));
        // Splicing B's mac onto A's fields breaks it too.
        let a_fields = a.expose().rsplit_once('.').unwrap().0;
        let b_mac = b.expose().rsplit_once('.').unwrap().1;
        assert_eq!(s.verify(&format!("{a_fields}.{b_mac}")), Err(TokenError::BadSignature));
    }

    #[test]
    fn widening_the_bound_services_or_the_role_in_a_token_is_refused() {
        let s = sessions();
        let t = s.mint(claims("sess-a", &[Service::Figma]));
        let widened = t.expose().replace(".figma.", ".figma,linear.");
        assert_eq!(s.verify(&widened), Err(TokenError::BadSignature));
        let as_sub = t.expose().replace(".chat.", ".sub.");
        assert_eq!(s.verify(&as_sub), Err(TokenError::BadSignature));
    }

    #[test]
    fn a_token_from_another_daemon_key_is_refused() {
        let theirs = BrokerSessions::with_key([9u8; 32]);
        let t = theirs.mint(claims("sess-a", &[Service::Figma]));
        let s = sessions();
        s.mint(claims("sess-a", &[Service::Figma]));
        assert_eq!(s.verify(t.expose()), Err(TokenError::BadSignature));
    }

    #[test]
    fn a_revoked_token_is_refused_and_stays_refused_after_the_chat_resumes() {
        let s = sessions();
        let c = claims("sess-a", &[Service::Figma]);
        let old = s.mint(c.clone());
        s.revoke("sess-a");
        assert_eq!(s.verify(old.expose()), Err(TokenError::Revoked));
        assert_eq!(s.current("sess-a"), None);
        let resumed = s.mint(c.clone());
        assert_ne!(old.expose(), resumed.expose(), "a resume issues under a new epoch");
        assert_eq!(s.verify(old.expose()), Err(TokenError::Revoked), "the closed chat's copy never works again");
        assert_eq!(s.verify(resumed.expose()), Ok(c.clone()));
        assert_eq!(s.current("sess-a"), Some(c));
    }

    #[test]
    fn a_valid_token_presented_for_another_session_is_refused() {
        let s = sessions();
        let a = s.mint(claims("sess-a", &[Service::Figma]));
        s.mint(claims("sess-b", &[Service::Figma]));
        assert!(s.verify_for(a.expose(), "sess-a").is_ok());
        assert_eq!(s.verify_for(a.expose(), "sess-b"), Err(TokenError::WrongSession));
    }

    #[test]
    fn revoking_one_session_leaves_another_alone() {
        let s = sessions();
        let a = s.mint(claims("sess-a", &[Service::Figma]));
        let b = s.mint(claims("sess-b", &[Service::Figma]));
        s.revoke("sess-a");
        assert!(s.verify(a.expose()).is_err());
        assert!(s.verify(b.expose()).is_ok());
    }

    #[test]
    fn the_daemon_token_file_and_other_credentials_do_not_verify() {
        let s = sessions();
        s.mint(claims("sess-a", &[Service::Figma]));
        let dir = tempfile::tempdir().unwrap();
        // The file the daemon hands the phone/remote surface (`remote-access-token.txt`).
        let file = dir.path().join("remote-access-token.txt");
        std::fs::write(&file, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n").unwrap();
        let contents = std::fs::read_to_string(&file).unwrap();
        for presented in [contents.as_str(), contents.trim(), "", "ccb1", "sess-a", "ccb1.sess-a.chat.figma.0.", "Bearer abc"] {
            assert!(s.verify(presented).is_err(), "{presented:?} must not verify");
        }
        // Right shape, all-zero mac.
        assert_eq!(s.verify(&format!("ccb1.sess-a.chat.figma.0.{}", "0".repeat(64))), Err(TokenError::BadSignature));
        // Oversized and non-ASCII input.
        assert_eq!(s.verify(&"a".repeat(5000)), Err(TokenError::Malformed));
        assert!(s.verify("ccb1.sess-ä.chat.figma.0.é").is_err());
    }

    #[test]
    fn a_token_signed_for_a_session_the_daemon_never_minted_is_refused() {
        // A mac that is valid for the key but names a session with no entry
        // (a daemon restart keeps no entries, and the key changes with it).
        let s = sessions();
        let forged = format!("ccb1.ghost.chat.-.0.{}", s.mac("ghost", "chat", "-", 0));
        assert_eq!(s.verify(&forged), Err(TokenError::Revoked));
    }

    #[test]
    fn only_the_canonical_spelling_of_a_token_verifies() {
        let s = sessions();
        let t = s.mint(claims("sess-a", &[Service::Figma]));
        assert!(s.verify(t.expose()).is_ok());
        let (head, mac) = t.expose().rsplit_once('.').unwrap();
        let head = head.strip_suffix(".0").unwrap();
        for epoch in ["+0", "00", "000", "0x0", " 0", "0 "] {
            assert_eq!(s.verify(&format!("{head}.{epoch}.{mac}")), Err(TokenError::Malformed), "epoch {epoch:?}");
        }
        assert!(s.verify(&format!("{head}.0.{}", mac.to_uppercase())).is_err());
    }

    #[test]
    fn a_token_with_no_services_round_trips_and_binds_nothing() {
        let s = sessions();
        let t = s.mint(claims("sess-a", &[]));
        assert!(s.verify(t.expose()).unwrap().services.is_empty());
    }

    #[test]
    fn debug_never_prints_the_token() {
        let s = sessions();
        let t = s.mint(claims("sess-a", &[Service::Figma]));
        let shown = format!("{t:?} {:?}", Some(&t));
        assert!(!shown.contains(t.expose()) && !shown.contains("sess-a"), "{shown}");
    }

    #[test]
    fn a_request_built_from_claims_carries_the_session_and_the_bound_set() {
        let c = claims("sess-a", &[Service::Shortcut]);
        let r = c.request("linear", "GET", "/graphql", None);
        assert_eq!(r.session, "sess-a");
        assert_eq!(r.bound_services, Some(vec![Service::Shortcut]));
    }
}
