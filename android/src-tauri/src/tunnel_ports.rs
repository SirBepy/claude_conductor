//! The loopback port scheme of the tunnel: which port a paired PC gets, how it is
//! bound, which ports the navigation guard accepts, and the journal port beside it.

use iroh::EndpointId;
use log::{error, warn};
use tokio::net::TcpListener;

use crate::iroh_tunnel::Tunnel;

/// Each paired PC gets its own loopback origin, so a different endpoint (a
/// stranger's QR) never serves a page at the origin holding another PC's
/// `rc_token`. The port is a function of the endpoint id, never ephemeral:
/// the token lives in that origin's localStorage, so a rotating port would
/// force a re-pair every launch.
const DERIVED_PORT_BASE: u16 = 27200;
const DERIVED_PORT_SPAN: u16 = 1000;
/// Bind attempts before giving up; each one the next port in the range.
const PORT_PROBES: u16 = 8;

/// The single fixed port every PC used before per-endpoint ports. The shell
/// asks for it (`legacy`) only for the PC paired back then, so that PC's
/// `rc_token` survives the upgrade without a re-pair.
pub const LEGACY_LOOPBACK_PORT: u16 = 27184;

/// The first port tried for `id`. Only two bytes feed it, but hashing every
/// byte would move each already-paired PC to a new origin and drop its
/// rc_token (a forced re-pair), while the 1000-port span leaves collision
/// grinding cheap either way.
pub fn derived_port(id: &EndpointId) -> u16 {
    let b = id.as_bytes();
    DERIVED_PORT_BASE + u16::from_le_bytes([b[0], b[1]]) % DERIVED_PORT_SPAN
}

/// Ports to try, in order: a collision moves to the next port in the range,
/// so a given id lands on the same port whenever the same ports are free.
pub(crate) fn port_candidates(id: &EndpointId, legacy: bool) -> Vec<u16> {
    // The legacy PC's rc_token lives only in the 27184 origin, so a failed
    // bind there must surface as an error: a derived port would silently
    // present a fresh origin with no token.
    if legacy {
        return vec![LEGACY_LOOPBACK_PORT];
    }
    let first = derived_port(id) - DERIVED_PORT_BASE;
    (0..PORT_PROBES).map(|i| DERIVED_PORT_BASE + (first + i) % DERIVED_PORT_SPAN).collect()
}

/// Loopback ports with a live tunnel behind them, read by the shell's
/// navigation guard: no other loopback port is a page the app may load.
pub(crate) static LIVE_PORTS: std::sync::LazyLock<std::sync::RwLock<std::collections::HashSet<u16>>> =
    std::sync::LazyLock::new(Default::default);

pub fn is_tunnel_port(port: u16) -> bool {
    LIVE_PORTS.read().is_ok_and(|ports| ports.contains(&port))
}

#[cfg(test)]
pub fn mark_live_for_test(port: u16) {
    LIVE_PORTS.write().expect("live ports").insert(port);
}

/// Binds the first free port of `candidates`.
pub(crate) async fn bind_loopback(candidates: &[u16]) -> Result<(TcpListener, u16), String> {
    let mut last = String::from("no candidate ports");
    for &port in candidates {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok((l, port)),
            Err(e) => {
                warn!("loopback bind failed at port {port}: {e}");
                last = format!("loopback bind failed at port {port}: {e}");
            }
        }
    }
    error!("{}", last);
    Err(last)
}

/// Binds the journal port, the main port + 1, for the page to read the journal
/// on. A fetch on the main port rides the WebView's reused keep-alive connections,
/// which are spliced to the PC, so only a port of its own is reliable. A failure
/// is journaled and the tunnel carries on without it.
pub(crate) async fn bind_journal_listener(main_port: u16, tunnel: &Tunnel) -> Option<TcpListener> {
    let bound = match main_port.checked_add(1) {
        Some(port) => TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("port {port}: {e}")),
        None => Err("no port above the main one".to_string()),
    };
    match bound {
        Ok(listener) => Some(listener),
        Err(reason) => {
            warn!("journal port unavailable: {reason}");
            tunnel.note("journal_port", &format!("unavailable {reason}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::id;

    #[test]
    fn each_endpoint_id_gets_its_own_stable_port_in_range() {
        let (a, b) = (id(1), id(2));
        assert_eq!(derived_port(&a), derived_port(&a), "same id, same port across launches");
        assert_ne!(derived_port(&a), derived_port(&b), "these two ids must not share an origin");
        for p in [derived_port(&a), derived_port(&b)] {
            assert!((DERIVED_PORT_BASE..DERIVED_PORT_BASE + DERIVED_PORT_SPAN).contains(&p));
            assert_ne!(p, LEGACY_LOOPBACK_PORT);
        }
    }

    #[test]
    fn collisions_probe_forward_deterministically_and_legacy_binds_only_the_old_port() {
        let a = id(3);
        let c = port_candidates(&a, false);
        assert_eq!(c.len(), PORT_PROBES as usize);
        assert_eq!(c[0], derived_port(&a));
        assert_eq!(c, port_candidates(&a, false));
        // No derived fallback: it would be a fresh origin without the token.
        assert_eq!(port_candidates(&a, true), vec![LEGACY_LOOPBACK_PORT]);
    }

    #[tokio::test]
    async fn a_taken_port_falls_through_to_the_next_candidate() {
        let held = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let taken = held.local_addr().expect("addr").port();
        let free = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let next = free.local_addr().expect("addr").port();
        drop(free);
        let (_l, port) = bind_loopback(&[taken, next]).await.expect("falls through");
        assert_eq!(port, next);
    }
}
