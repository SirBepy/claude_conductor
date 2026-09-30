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

/// Pure URL construction so the four branches unit-test without tailscale, a
/// daemon or disk. The `conductor://` form is the android client's fallback
/// for when tailscale is down, which is the whole point of the iroh tunnel.
pub(super) fn build_pairing_url(
    dnsname: Option<&str>,
    iroh_id: Option<&str>,
    code: &str,
) -> Result<String, String> {
    match (dnsname, iroh_id) {
        (Some(d), Some(id)) => Ok(format!("https://{d}/?pair={code}&iroh={id}")),
        (Some(d), None) => Ok(format!("https://{d}/?pair={code}")),
        (None, Some(id)) => Ok(format!("conductor://pair?iroh={id}&pair={code}")),
        (None, None) => {
            Err("neither tailscale nor iroh is available (run `tailscale up`, or wait for the daemon to finish starting)".to_string())
        }
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
    fn build_pairing_url_tailscale_only_is_byte_identical_to_before_iroh() {
        assert_eq!(
            build_pairing_url(Some("box.tailnet.ts.net"), None, "abc123").unwrap(),
            "https://box.tailnet.ts.net/?pair=abc123"
        );
    }

    #[test]
    fn build_pairing_url_tailscale_and_iroh_matches_android_contract() {
        assert_eq!(
            build_pairing_url(Some("box.tailnet.ts.net"), Some("deadbeef"), "abc123").unwrap(),
            "https://box.tailnet.ts.net/?pair=abc123&iroh=deadbeef"
        );
    }

    #[test]
    fn build_pairing_url_iroh_only_matches_android_contract() {
        assert_eq!(
            build_pairing_url(None, Some("deadbeef"), "abc123").unwrap(),
            "conductor://pair?iroh=deadbeef&pair=abc123"
        );
    }

    #[test]
    fn build_pairing_url_errs_when_neither_transport_is_available() {
        assert!(build_pairing_url(None, None, "abc123").is_err());
    }
}
