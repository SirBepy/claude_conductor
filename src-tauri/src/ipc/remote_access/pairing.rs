//! Pairing-code minting and pairing-URL construction for the QR flow.

use crate::util::{sha256_hex, to_hex};

/// Mint a fresh pairing code, write hash + TTL to remote-pairing.json,
/// return the plaintext code. TTL: 2 minutes.
pub(super) fn do_mint_pairing_code(app_data: &std::path::Path) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let code: String = to_hex(&bytes);
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + 120;
    let body = serde_json::json!({ "code_hash": sha256_hex(&code), "expires_at": expires_at });
    let json = serde_json::to_string_pretty(&body).unwrap_or_default();
    crate::util::write_json_atomic(&app_data.join("remote-pairing.json"), &json)
        .map_err(|e| e.to_string())?;
    Ok(code)
}

/// Pure URL construction so it unit-tests without a daemon or disk. The iroh
/// endpoint id is the only address: the phone and `pair_machine` both dial it
/// through n0's address lookup, so no host or port travels in the link.
pub(super) fn build_pairing_url(iroh_id: Option<&str>, code: &str) -> Result<String, String> {
    match iroh_id {
        Some(id) => Ok(format!("conductor://pair?iroh={id}&pair={code}")),
        None => Err("this machine's iroh id isn't ready yet - wait for the daemon to finish starting".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn mint_pairing_code_writes_hash_and_ttl() {
        let dir = tempdir().unwrap();
        let code = do_mint_pairing_code(dir.path()).unwrap();
        assert_eq!(code.len(), 64);
        let raw = std::fs::read_to_string(dir.path().join("remote-pairing.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["code_hash"].as_str().unwrap(), sha256_hex(&code));
        let expires_at = v["expires_at"].as_u64().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(expires_at > now);
        assert!(expires_at <= now + 120);
    }

    #[test]
    fn build_pairing_url_iroh_only_matches_android_contract() {
        assert_eq!(
            build_pairing_url(Some("deadbeef"), "abc123").unwrap(),
            "conductor://pair?iroh=deadbeef&pair=abc123"
        );
    }

    #[test]
    fn build_pairing_url_errs_without_an_iroh_id() {
        assert!(build_pairing_url(None, "abc123").is_err());
    }
}
