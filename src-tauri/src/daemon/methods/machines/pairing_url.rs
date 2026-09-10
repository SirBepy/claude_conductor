//! Pairing-URL parsing and reach-decision logic, split out of
//! `methods/machines.rs` (todo 914). Pure and unit-testable without a
//! network or a daemon. Named `pairing_url` rather than `url` so this
//! module's own use of the external `url` crate (`url::Url::parse`) stays
//! unambiguous.

/// The three URL shapes `build_pairing_url` (`ipc::remote_access`) mints,
/// plus a plain `http://host:port/?pair=code` for a same-LAN direct pair.
#[derive(Debug, PartialEq)]
pub(crate) struct ParsedPairing {
    pub code: String,
    pub iroh_id: Option<String>,
    /// Origin (`scheme://host[:port]`) to reach the peer directly. `None`
    /// for `conductor://` links, which carry no usable host.
    pub direct_url: Option<String>,
}

/// How `pair_machine` will physically reach the peer it just parsed a
/// pairing URL for - decided before any network call, so it's unit-testable
/// on its own. Mirrors `peer_client::reach_url`'s branch order (direct wins,
/// iroh is the fallback), but works off `ParsedPairing` since pairing hasn't
/// stored a `PeerMachine` yet.
#[derive(Debug, PartialEq)]
pub(crate) enum ReachDecision {
    Direct(String),
    Iroh(String),
    Neither,
}

pub(crate) fn decide_reach(parsed: &ParsedPairing) -> ReachDecision {
    if let Some(direct) = &parsed.direct_url {
        ReachDecision::Direct(direct.clone())
    } else if let Some(id) = &parsed.iroh_id {
        ReachDecision::Iroh(id.clone())
    } else {
        ReachDecision::Neither
    }
}

/// Pure URL parsing so this is unit-testable without a network or a daemon.
pub(crate) fn parse_pairing_url(raw: &str) -> Result<ParsedPairing, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid pairing url: {e}"))?;
    let mut code = None;
    let mut iroh_id = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "pair" => code = Some(v.into_owned()),
            "iroh" => iroh_id = Some(v.into_owned()),
            _ => {}
        }
    }
    let code = code.ok_or_else(|| "pairing url is missing a pair= code".to_string())?;
    let direct_url = match parsed.scheme() {
        "http" | "https" => {
            let host = parsed.host_str().ok_or_else(|| "pairing url has no host".to_string())?;
            match parsed.port() {
                Some(port) => Some(format!("{}://{}:{}", parsed.scheme(), host, port)),
                None => Some(format!("{}://{}", parsed.scheme(), host)),
            }
        }
        _ => None,
    };
    Ok(ParsedPairing { code, iroh_id, direct_url })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_pairing_url ──────────────────────────────────────────────────

    #[test]
    fn parses_tailscale_plus_iroh_shape() {
        let p = parse_pairing_url("https://box.tailnet.ts.net/?pair=abc123&iroh=deadbeef").unwrap();
        assert_eq!(p.code, "abc123");
        assert_eq!(p.iroh_id.as_deref(), Some("deadbeef"));
        assert_eq!(p.direct_url.as_deref(), Some("https://box.tailnet.ts.net"));
    }

    #[test]
    fn parses_tailscale_only_shape() {
        let p = parse_pairing_url("https://box.tailnet.ts.net/?pair=abc123").unwrap();
        assert_eq!(p.code, "abc123");
        assert_eq!(p.iroh_id, None);
        assert_eq!(p.direct_url.as_deref(), Some("https://box.tailnet.ts.net"));
    }

    #[test]
    fn parses_conductor_scheme_iroh_only_shape() {
        let p = parse_pairing_url("conductor://pair?iroh=deadbeef&pair=abc123").unwrap();
        assert_eq!(p.code, "abc123");
        assert_eq!(p.iroh_id.as_deref(), Some("deadbeef"));
        assert_eq!(p.direct_url, None, "conductor:// carries no usable host");
    }

    #[test]
    fn parses_plain_local_http_shape() {
        let p = parse_pairing_url("http://127.0.0.1:27291/?pair=someothercode").unwrap();
        assert_eq!(p.code, "someothercode");
        assert_eq!(p.iroh_id, None);
        assert_eq!(p.direct_url.as_deref(), Some("http://127.0.0.1:27291"));
    }

    #[test]
    fn rejects_garbage_urls() {
        assert!(parse_pairing_url("not a url").is_err());
        assert!(parse_pairing_url("https://box.tailnet.ts.net/").is_err(), "no pair= code");
    }

    // ── decide_reach ────────────────────────────────────────────────────

    #[test]
    fn decide_reach_prefers_direct_url() {
        let parsed = parse_pairing_url("https://box.tailnet.ts.net/?pair=abc123&iroh=deadbeef").unwrap();
        assert_eq!(decide_reach(&parsed), ReachDecision::Direct("https://box.tailnet.ts.net".into()));
    }

    #[test]
    fn decide_reach_falls_back_to_iroh_for_a_conductor_scheme_link() {
        let parsed = parse_pairing_url("conductor://pair?iroh=deadbeef&pair=abc123").unwrap();
        assert_eq!(decide_reach(&parsed), ReachDecision::Iroh("deadbeef".into()));
    }

    #[test]
    fn decide_reach_neither_when_a_plain_conductor_link_carries_no_iroh_id() {
        let parsed = ParsedPairing { code: "abc123".into(), iroh_id: None, direct_url: None };
        assert_eq!(decide_reach(&parsed), ReachDecision::Neither);
    }
}
