    use super::*;
    use crate::forward::JOURNAL_PORT_HEAD_TIMEOUT;
    use crate::quiet_watch::QUIET_DEAD_TICKS;
    use crate::test_support::*;
    use crate::tunnel_ports::is_tunnel_port;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// Pins the wire byte value, since src-tauri has its own copy of this
    /// constant in a separate cargo workspace with no shared crate.
    #[test]
    fn alpn_matches_desktop_copy() {
        assert_eq!(ALPN, b"conductor/remote/0");
    }

    #[tokio::test]
    async fn shutdown_frees_the_port_and_revokes_navigation() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let running = RunningTunnel::spawn(listener, port, Arc::new(Tunnel::new(client, server, minimal_rebuild())));
        assert!(is_tunnel_port(port));
        running.shutdown().await;
        assert!(!is_tunnel_port(port));
        let mut rebound = false;
        for _ in 0..50 {
            if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
                rebound = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(rebound, "old listener still holds the port");
    }

    #[test]
    fn only_a_long_wall_clock_gap_counts_as_a_resume() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert!(!is_resume_gap(t0, t0 + WATCHDOG_TICK));
        assert!(!is_resume_gap(t0, t0 + RESUME_GAP));
        assert!(is_resume_gap(t0, t0 + RESUME_GAP + Duration::from_secs(1)));
        // A wall clock stepped backwards is not a resume.
        assert!(!is_resume_gap(t0, t0 - Duration::from_secs(60)));
    }

    /// A dead endpoint fails the first dial at once. The retry must run on a
    /// freshly bound one, or a flapped relay path keeps timing out until the
    /// tunnel is rebuilt by hand.
    #[tokio::test]
    async fn a_failed_dial_is_retried_on_a_freshly_bound_endpoint() {
        let (server, accepted) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let tunnel = Arc::new(Tunnel::new(dead, server, rebuild));
        tokio::spawn(accept_loop(listener, tunnel.clone()));
        ping(port).await;
        assert_eq!(rebinds.load(Ordering::SeqCst), 1, "one rebind for the one failed dial");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    /// With every attempt failing, the caller gets an error rather than a hang,
    /// and the call binds exactly one replacement endpoint: the retry stays on it
    /// instead of throwing away a relay connection that is already warming up.
    #[tokio::test]
    async fn every_dial_failing_surfaces_an_error_after_exactly_one_rebind() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        // The replacement is closed too, so attempt 2 fails as well.
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                let e = Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string())?;
                e.close().await;
                Ok(e)
            })
        });
        let tunnel = Tunnel::new(dead, server, rebuild);
        assert!(tunnel.connection().await.is_err());
        assert_eq!(rebinds.load(Ordering::SeqCst), 1);
    }

    /// A tunnel whose every dial fails, counting rebinds.
    fn dead_tunnel(server: EndpointAddr, dead: Endpoint, rebinds: Arc<AtomicUsize>) -> Arc<Tunnel> {
        let rebuild: Rebuild = Box::new(move || {
            rebinds.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                let e = Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string())?;
                e.close().await;
                Ok(e)
            })
        });
        Arc::new(Tunnel::new(dead, server, rebuild))
    }

    /// Sockets queued behind a failed dial share its failure: one dial-and-rebind
    /// cycle in total, not one per queued socket.
    #[tokio::test]
    async fn callers_queued_behind_a_failed_dial_share_its_failure() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = dead_tunnel(server, dead, rebinds.clone());
        let (a, b, c, d, e) = tokio::join!(
            tunnel.connection(),
            tunnel.connection(),
            tunnel.connection(),
            tunnel.connection(),
            tunnel.connection()
        );
        for r in [a, b, c, d, e] {
            assert!(r.is_err());
        }
        assert_eq!(rebinds.load(Ordering::SeqCst), 1, "one cycle for all five callers");
    }

    /// A caller arriving after the failure finished is not served the stale error;
    /// its dial starts on a fresh endpoint, because the failed call left the old
    /// one suspect.
    #[tokio::test]
    async fn a_caller_arriving_after_a_failure_dials_again() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = dead_tunnel(server, dead, rebinds.clone());
        assert!(tunnel.connection().await.is_err());
        let after_first = rebinds.load(Ordering::SeqCst);
        assert!(tunnel.connection().await.is_err());
        assert_eq!(rebinds.load(Ordering::SeqCst), after_first + 1, "a later call must dial for itself, on a fresh endpoint");
    }

    #[test]
    fn stop_gap_reports_only_a_long_forward_step_of_the_wall_clock() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(stop_gap(t0, t0 + STOP_TICK), None, "two ticks 250ms apart");
        assert_eq!(stop_gap(t0, t0 + Duration::from_secs(6)), Some(Duration::from_secs(6)));
        assert_eq!(stop_gap(t0, t0 - Duration::from_secs(60)), None, "a clock stepping backwards");
    }

    #[test]
    fn the_dial_address_carries_the_remembered_relay_only_when_there_is_one() {
        let remote = EndpointAddr::new(id(7));
        assert_eq!(build_dial_addr(&remote, None), remote, "no hint dials the bare address");
        let relay: RelayUrl = "https://relay.example.com./".parse().unwrap();
        let hinted = build_dial_addr(&remote, Some(relay.clone()));
        assert_eq!(hinted.id, remote.id);
        assert!(hinted.relay_urls().any(|u| *u == relay), "{hinted:?}");
        assert_eq!(relay_of(&[(true, TransportAddr::Relay(relay.clone()))]), Some(relay));
        assert_eq!(relay_of(&[(true, TransportAddr::Ip("10.0.0.1:1".parse().unwrap()))]), None);
    }

    /// A relay hint that leads nowhere must not strand a dial whose direct
    /// address is good. Only checked here with `Minimal` endpoints (no relay
    /// transport), so it shows the hint does no harm, not that iroh falls back
    /// to its address lookup, which needs a relay and DNS.
    #[tokio::test]
    async fn a_wrong_relay_hint_does_not_stop_a_dial_with_a_good_direct_address() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        *tunnel.relay_hint.lock().unwrap() = Some("https://wrong-relay.invalid./".parse().unwrap());
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    /// A dial the phone slept through is abandoned when the wall clock shows it,
    /// not when the (monotonic, paused during sleep) attempt timeout runs out.
    #[tokio::test]
    async fn a_dial_that_slept_is_abandoned_at_once_and_restarted_on_a_fresh_endpoint() {
        use std::sync::atomic::AtomicBool;
        let (server, accepted) = pong_server().await;
        let port = local_v4_port(&server);
        let open = Arc::new(AtomicBool::new(false));
        let front = udp_gate(std::net::SocketAddr::from(([127, 0, 0, 1], port)), open.clone()).await;
        let remote = EndpointAddr::new(server.id).with_ip_addr(front);
        let offset = Arc::new(AtomicU64::new(0));
        let o = offset.clone();
        let ran_at: Arc<std::sync::Mutex<Option<Instant>>> = Default::default();
        let (gate, ran) = (open.clone(), ran_at.clone());
        let rebuild: Rebuild = Box::new(move || {
            // The PC answers again once the fresh endpoint exists.
            gate.store(true, Ordering::SeqCst);
            *ran.lock().unwrap() = Some(Instant::now());
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        });
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let mut tunnel = Tunnel::new(client, remote, rebuild);
        tunnel.clock = Arc::new(move || SystemTime::now() + Duration::from_secs(o.load(Ordering::SeqCst)));
        let tunnel = Arc::new(tunnel);
        let first_id = tunnel.endpoint().id();
        let t = tunnel.clone();
        let call = tokio::spawn(async move { t.connection().await.map(|c| c.stable_id()) });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(ran_at.lock().unwrap().is_none(), "the dial is still waiting on the silent PC");
        let jumped = Instant::now();
        offset.store(3600, Ordering::SeqCst);
        let mut ran_after = None;
        while jumped.elapsed() < Duration::from_secs(3) {
            if let Some(at) = *ran_at.lock().unwrap() {
                ran_after = Some(at - jumped);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ran_after = ran_after.expect("the rebuild never ran after the clock jump");
        assert!(ran_after < Duration::from_millis(1500), "restart took {ran_after:?}, the attempt timeout is {ATTEMPT_TIMEOUT:?}");
        tokio::time::timeout(Duration::from_secs(8), call).await.expect("dial finished").expect("join").expect("connected");
        // The server counts a connection a moment after the client sees it open.
        for _ in 0..50 {
            if accepted.load(Ordering::SeqCst) >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(accepted.load(Ordering::SeqCst) >= 1, "the PC never saw the connection");
        assert_ne!(tunnel.endpoint().id(), first_id, "the dial that followed the stop ran on the fresh endpoint");
        assert_eq!(tunnel.take_resume(), None, "the stop was consumed by the dial, nobody reports it again");
    }

    /// A rebuild closure that binds a working endpoint and counts its runs.
    fn counting_rebuild(counter: Arc<AtomicUsize>) -> Rebuild {
        Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        })
    }

    /// Time spent inside `connection()` must never read as a wake-up: a dial that
    /// slept leaves `last_alive` far in the past, and the next caller would close
    /// the connection that dial just made.
    #[tokio::test]
    async fn time_spent_in_a_dial_never_reads_as_a_wake_up_afterwards() {
        let (server, accepted) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let handle: Arc<std::sync::OnceLock<Arc<Tunnel>>> = Arc::new(std::sync::OnceLock::new());
        let h = handle.clone();
        let rebuild: Rebuild = Box::new(move || {
            if let Some(t) = h.get() {
                t.last_alive.store(now_secs() - RESUME_GAP.as_secs() - 10, Ordering::SeqCst);
            }
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        });
        let tunnel = Arc::new(Tunnel::new(dead, server, rebuild));
        handle.set(tunnel.clone()).ok().expect("set once");
        let first = tunnel.connection().await.expect("attempt 2 succeeds on the rebuilt endpoint");
        let second = tunnel.connection().await.expect("cached");
        assert_eq!(first.stable_id(), second.stable_id());
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "the connection the slow dial made must be reused");
    }

    /// After a connection is lost the redial binds a fresh endpoint BEFORE any
    /// dial on the old one, which is likely still holding pre-sleep relay state.
    #[tokio::test]
    async fn a_lost_connection_is_redialed_on_a_fresh_endpoint_first() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = Tunnel::new(client, server, counting_rebuild(rebinds.clone()));
        tunnel.connection().await.expect("first dial");
        assert_eq!(rebinds.load(Ordering::SeqCst), 0, "the endpoint a tunnel is created with is already fresh");
        let id_before = tunnel.endpoint().id();
        stale(&tunnel);
        tunnel.connection().await.expect("redial");
        assert_eq!(rebinds.load(Ordering::SeqCst), 1, "one rebind, before the dial");
        assert_ne!(tunnel.endpoint().id(), id_before, "the redial runs on the fresh endpoint");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn the_first_ever_dial_binds_no_new_endpoint() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = Tunnel::new(client, server, counting_rebuild(rebinds.clone()));
        tunnel.connection().await.expect("first dial");
        assert_eq!(rebinds.load(Ordering::SeqCst), 0);
    }

    /// A rebind that fails leaves the old endpoint dialing, never a dead tunnel.
    #[tokio::test]
    async fn a_failed_rebind_falls_back_to_the_old_endpoint() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("no sockets".to_string()) })
        });
        let tunnel = Tunnel::new(client, server, rebuild);
        tunnel.connection().await.expect("first dial");
        stale(&tunnel);
        tunnel.connection().await.expect("redial on the old endpoint");
        assert_eq!(rebinds.load(Ordering::SeqCst), 1);
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn loopback_sockets_share_one_quic_connection() {
        let (server, accepted) = pong_server().await;
        let (_tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        ping(port).await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    fn stale(tunnel: &Tunnel) {
        tunnel.last_alive.store(now_secs() - RESUME_GAP.as_secs() - 10, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn take_resume_fires_once_per_gap() {
        let (server, _) = pong_server().await;
        let (tunnel, _) = tunnel_to(server).await;
        assert_eq!(tunnel.take_resume(), None, "a fresh tunnel is not a wake-up");
        stale(&tunnel);
        let gap = tunnel.take_resume().expect("a stale last_alive is a gap");
        assert!(gap >= RESUME_GAP.as_secs() + 10);
        assert_eq!(tunnel.take_resume(), None, "the gap is consumed by the first caller");
    }

    #[tokio::test]
    async fn a_stale_last_alive_makes_the_next_request_redial_instead_of_reusing() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        stale(&tunnel);
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "the cached connection must not outlive a wake-up");
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "the redialed connection is reused afterwards");
    }

    /// The deterministic half of the race fix: while another task holds the
    /// connection lock (a dial in progress), a watchdog tick must not consume
    /// the gap, or the dial's result could be closed by a late drop.
    #[tokio::test]
    async fn watchdog_tick_waits_for_the_lock_before_consuming_the_gap() {
        let (server, _) = pong_server().await;
        let (tunnel, _) = tunnel_to(server).await;
        stale(&tunnel);
        let held = tunnel.conn.lock().await;
        let blocked = tokio::time::timeout(Duration::from_millis(100), tunnel.watchdog_tick()).await;
        assert!(blocked.is_err(), "the tick must wait for the lock");
        assert!(tunnel.last_alive.load(Ordering::SeqCst) < now_secs() - RESUME_GAP.as_secs(), "gap consumed too early");
        drop(held);
        tunnel.watchdog_tick().await;
        assert!(tunnel.last_alive.load(Ordering::SeqCst) >= now_secs() - 1, "gap consumed once the lock is free");
    }

    #[tokio::test]
    async fn a_watchdog_tick_racing_a_request_never_closes_the_fresh_connection() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        stale(&tunnel);
        tokio::join!(ping(port), tunnel.watchdog_tick());
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "one redial for the one wake-up, then reuse");
    }

    #[test]
    fn path_summary_marks_the_selected_path_and_names_each_kind() {
        let ip: std::net::SocketAddr = "192.168.1.5:4000".parse().unwrap();
        let relay: iroh::RelayUrl = "https://relay.example.com./".parse().unwrap();
        let summary = path_summary(&[(true, TransportAddr::Ip(ip)), (false, TransportAddr::Relay(relay))]);
        assert!(summary.starts_with("*ip:192.168.1.5:4000"), "{summary}");
        assert!(summary.contains(",relay:"), "{summary}");
        assert_eq!(path_summary(&[]), "");
    }

    #[tokio::test]
    async fn remote_known_flips_after_the_first_dial() {
        let (server, _) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        assert!(!tunnel.remote_known().await, "no state before the first dial");
        ping(port).await;
        assert!(tunnel.remote_known().await, "iroh keeps the remote after a dial");
    }

    #[tokio::test]
    async fn a_tick_that_arrives_late_on_the_wall_clock_is_journaled_and_a_normal_one_is_not() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let offset = Arc::new(AtomicU64::new(0));
        let o = offset.clone();
        let (tunnel, _, journal) = private_tunnel(client, server, minimal_rebuild(), |t| {
            t.clock = Arc::new(move || SystemTime::now() + Duration::from_secs(o.load(Ordering::SeqCst)));
        })
        .await;
        let mut prev = (tunnel.clock)();
        tunnel.check_tick_late(&mut prev);
        assert!(!journal.snapshot_json(0).contains("tick_late"), "a normal tick is not late");
        offset.store(10, Ordering::SeqCst);
        tunnel.check_tick_late(&mut prev);
        let json = journal.snapshot_json(0);
        assert!(json.contains("\"k\":\"tick_late\",\"d\":\"late_ms=8"), "{json}");
        tunnel.check_tick_late(&mut prev);
        assert_eq!(journal.snapshot_json(0).matches("tick_late").count(), 1, "the jump is reported once");
    }

    #[tokio::test]
    async fn a_successful_dial_journals_dial_ok_and_a_failed_one_dial_fail() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (tunnel, _, journal) = private_tunnel(client, server.clone(), minimal_rebuild(), |_| {}).await;
        tunnel.connection().await.expect("dial");
        let json = journal.snapshot_json(0);
        assert!(json.contains("\"k\":\"dial_ok\""), "{json}");
        assert!(json.contains("attempt=1 warm=false hint=false resumed=false path="), "{json}");

        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebuild: Rebuild = Box::new(|| {
            Box::pin(async {
                let e = Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string())?;
                e.close().await;
                Ok(e)
            })
        });
        let (dead_tunnel, _, dead_journal) = private_tunnel(dead, server, rebuild, |_| {}).await;
        assert!(dead_tunnel.connection().await.is_err());
        let json = dead_journal.snapshot_json(0);
        assert!(json.contains("\"k\":\"dial_fail\",\"d\":\"attempt=1 "), "{json}");
        assert!(json.contains("\"k\":\"rebind\",\"d\":\"ok id="), "{json}");
        assert!(!json.contains("dial_ok"), "{json}");
    }

    #[tokio::test]
    async fn a_dropped_connection_and_its_resume_are_journaled() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (tunnel, _, journal) = private_tunnel(client, server, minimal_rebuild(), |_| {}).await;
        tunnel.connection().await.expect("first dial");
        stale(&tunnel);
        tunnel.connection().await.expect("redial");
        let json = journal.snapshot_json(0);
        assert!(json.contains("\"k\":\"resume\",\"d\":\"secs="), "{json}");
        assert!(json.contains("by=connection"), "{json}");
        assert!(json.contains("\"k\":\"drop\""), "{json}");
    }

    fn running_on(tunnel: Arc<Tunnel>, listener: TcpListener) -> RunningTunnel {
        let port = listener.local_addr().expect("addr").port();
        RunningTunnel::spawn(listener, port, tunnel)
    }

    /// A main listener whose port + 1 is free, with that neighbour bound as the journal listener.
    async fn listener_pair(tunnel: &Tunnel) -> (TcpListener, Option<TcpListener>) {
        for _ in 0..50 {
            let main = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
            let port = main.local_addr().expect("addr").port();
            if let Some(journal) = bind_journal_listener(port, tunnel).await {
                return (main, Some(journal));
            }
        }
        panic!("no free port pair");
    }

    #[tokio::test]
    async fn the_journal_port_answers_with_cors_for_the_tunnels_own_origin_and_never_dials() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let tunnel = Arc::new(Tunnel::new(client, server, minimal_rebuild()));
        let (main, journal) = listener_pair(&tunnel).await;
        let running = running_on_with_journal(tunnel, main, journal);
        let main_port = running.port;
        let journal_port = running.journal_port.expect("journal port");
        assert_eq!(journal_port, main_port + 1);
        assert!(!is_tunnel_port(journal_port), "the journal port is not a page the app may open");
        let reply = raw_exchange(journal_port, &[b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"]).await;
        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{reply}");
        assert!(reply.contains("Content-Type: application/json\r\n"), "{reply}");
        assert!(reply.contains("Cache-Control: no-store\r\n"), "{reply}");
        assert!(reply.contains(&format!("Access-Control-Allow-Origin: http://127.0.0.1:{main_port}\r\n")), "{reply}");
        assert!(reply.contains("Connection: close\r\n"), "{reply}");
        let body = reply.split("\r\n\r\n").nth(1).expect("body");
        assert!(body.starts_with("{\"v\":1"), "{body}");
        assert!(reply.contains(&format!("Content-Length: {}\r\n", body.len())), "{reply}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 0, "the journal port must not reach the PC");
        running.shutdown().await;
    }

    #[tokio::test]
    async fn the_journal_port_answers_any_method_and_drops_a_silent_client() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let tunnel = Arc::new(Tunnel::new(client, server, minimal_rebuild()));
        let (main, journal) = listener_pair(&tunnel).await;
        let running = running_on_with_journal(tunnel, main, journal);
        let journal_port = running.journal_port.expect("journal port");
        let reply = raw_exchange(journal_port, &[b"POST /x HTTP/1.1\r\nContent-Length: 0\r\n\r\n"]).await;
        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{reply}");
        let mut silent = TcpStream::connect(("127.0.0.1", journal_port)).await.expect("connect");
        let mut out = Vec::new();
        tokio::time::timeout(JOURNAL_PORT_HEAD_TIMEOUT + Duration::from_secs(3), silent.read_to_end(&mut out))
            .await
            .expect("a silent client must be dropped")
            .expect("read");
        assert!(out.is_empty(), "a silent client gets no reply");
        running.shutdown().await;
    }

    #[tokio::test]
    async fn shutting_down_frees_the_journal_port_too() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let tunnel = Arc::new(Tunnel::new(client, server, minimal_rebuild()));
        let (main, journal) = listener_pair(&tunnel).await;
        let running = running_on_with_journal(tunnel, main, journal);
        let journal_port = running.journal_port.expect("journal port");
        running.shutdown().await;
        let mut rebound = false;
        for _ in 0..50 {
            if TcpListener::bind(("127.0.0.1", journal_port)).await.is_ok() {
                rebound = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(rebound, "old journal listener still holds the port");
    }

    #[tokio::test]
    async fn a_taken_journal_port_is_journaled_and_the_tunnel_still_starts() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let journal = Arc::new(Journal::new());
        let mut tunnel = Tunnel::new(client, server, minimal_rebuild());
        tunnel.journal = journal.clone();
        let tunnel = Arc::new(tunnel);
        // Hold port + 1 of a bound main port.
        let (main, blocker) = loop {
            let main = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
            let port = main.local_addr().expect("addr").port();
            if let Ok(blocker) = TcpListener::bind(("127.0.0.1", port + 1)).await {
                break (main, blocker);
            }
        };
        let port = main.local_addr().expect("addr").port();
        let none = bind_journal_listener(port, &tunnel).await;
        assert!(none.is_none());
        let json = journal.snapshot_json(0);
        assert!(json.contains("\"k\":\"journal_port\",\"d\":\"unavailable port "), "{json}");
        let running = RunningTunnel::spawn_with_journal(main, port, tunnel, none);
        assert_eq!(running.journal_port, None);
        assert!(is_tunnel_port(port), "the tunnel itself runs without the journal port");
        running.shutdown().await;
        drop(blocker);
    }

    fn running_on_with_journal(tunnel: Arc<Tunnel>, listener: TcpListener, journal: Option<TcpListener>) -> RunningTunnel {
        let port = listener.local_addr().expect("addr").port();
        RunningTunnel::spawn_with_journal(listener, port, tunnel, journal)
    }

    #[tokio::test]
    async fn probe_succeeds_against_a_reachable_pc_and_fails_against_a_dead_one() {
        let (server, accepted) = pong_server().await;
        let remote_id = server.id;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let state = IrohTunnelState::default();
        let running = running_on(Arc::new(Tunnel::new(client, server.clone(), minimal_rebuild())), listener);
        state.0.lock().await.insert(remote_id, running);
        probe_in(&state, &remote_id.to_string()).await.expect("reachable PC");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        assert_eq!(probe_in(&state, &id(42).to_string()).await, Err("no tunnel for this PC".to_string()));

        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let dead_id = id(43);
        let dead_remote = EndpointAddr::new(dead_id);
        let rebuild: Rebuild = Box::new(|| {
            Box::pin(async {
                let e = Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string())?;
                e.close().await;
                Ok(e)
            })
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let running = running_on(Arc::new(Tunnel::new(dead, dead_remote, rebuild)), listener);
        state.0.lock().await.insert(dead_id, running);
        assert!(probe_in(&state, &dead_id.to_string()).await.is_err());
    }

    #[tokio::test]
    async fn an_invalidated_connection_is_redialed() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        let current = tunnel.connection().await.expect("cached");
        tunnel.invalidate(current.stable_id(), "test").await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    /// A failure reported against an old connection must not close the one a
    /// racing task has already redialed.
    #[tokio::test]
    async fn invalidating_a_superseded_connection_keeps_the_fresh_one() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        let first = tunnel.connection().await.expect("first dial");
        stale(&tunnel);
        let second = tunnel.connection().await.expect("redial after a wake-up");
        assert_ne!(first.stable_id(), second.stable_id());
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        tunnel.invalidate(first.stable_id(), "late failure of the old connection").await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "the fresh connection must be reused");
        assert!(second.close_reason().is_none());
    }

    /// Ticks needed to reach the dead mark from the tick that records the baseline.
    const TICKS_TO_DEAD: u32 = QUIET_DEAD_TICKS + 1;

    /// A tunnel whose PC sits behind a UDP gate, with a stream held open through it.
    /// Returns the tunnel, the gate, the held loopback socket and the journal.
    async fn tunnel_with_open_stream() -> (Arc<Tunnel>, Arc<std::sync::atomic::AtomicBool>, TcpStream, Arc<Journal>) {
        let (server, _) = pong_server().await;
        let port = local_v4_port(&server);
        let open = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let front = udp_gate(std::net::SocketAddr::from(([127, 0, 0, 1], port)), open.clone()).await;
        let remote = EndpointAddr::new(server.id).with_ip_addr(front);
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (tunnel, tport, journal) = private_tunnel(client, remote, minimal_rebuild(), |_| {}).await;
        let mut sock = TcpStream::connect(("127.0.0.1", tport)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        let mut reply = vec![0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), sock.read_exact(&mut reply)).await.expect("timed out").expect("read");
        assert_eq!(&reply, b"PONG");
        // The socket stays open, so its stream does too. The pause lets the
        // PC's last acknowledgements land before a test closes the gate.
        assert_eq!(tunnel.open_streams.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(300)).await;
        (tunnel, open, sock, journal)
    }

    /// The PC goes silent while a request is in flight: the watch nudges at 8s
    /// and drops the connection at 12s of ticks, instead of leaving the page's
    /// sockets hanging until QUIC's 30s idle timeout.
    #[tokio::test]
    async fn a_connection_in_use_that_receives_nothing_is_nudged_then_dropped() {
        let (tunnel, gate, _held, journal) = tunnel_with_open_stream().await;
        gate.store(false, Ordering::SeqCst);
        for _ in 0..TICKS_TO_DEAD {
            tunnel.watchdog_tick().await;
        }
        let slot = tunnel.conn.lock().await;
        assert!(slot.conn.is_none(), "the silent connection is still cached");
        assert!(slot.needs_fresh_endpoint, "the redial must start on a fresh endpoint");
        let json = journal.snapshot_json(0);
        let quiet_at = json.find("\"k\":\"quiet\",\"d\":\"secs=8\"").unwrap_or_else(|| panic!("{json}"));
        let dead_at = json.find("\"k\":\"dead\",\"d\":\"secs=12\"").unwrap_or_else(|| panic!("{json}"));
        assert!(quiet_at < dead_at, "{json}");
        assert!(json.contains("no packets for 12s"), "{json}");
        assert_eq!(json.matches("\"k\":\"quiet\"").count(), 1, "one nudge per quiet spell: {json}");
    }

    /// Traffic keeps arriving (the counter moves every tick): the same number of
    /// ticks drops nothing.
    #[tokio::test]
    async fn a_connection_in_use_that_keeps_receiving_is_left_alone() {
        let (tunnel, _gate, _held, journal) = tunnel_with_open_stream().await;
        let counter = AtomicU64::new(0);
        for _ in 0..TICKS_TO_DEAD * 3 {
            tunnel.watchdog_tick_with(&|_| Traffic { rx: counter.fetch_add(1, Ordering::SeqCst), ..Traffic::default() }).await;
        }
        let slot = tunnel.conn.lock().await;
        assert!(slot.conn.as_ref().is_some_and(|c| c.close_reason().is_none()));
        let json = journal.snapshot_json(0);
        assert!(!json.contains("quiet") && !json.contains("dead"), "{json}");
    }

    /// A quiet connection nobody is waiting on is left to QUIC.
    #[tokio::test]
    async fn a_quiet_connection_with_no_stream_open_is_left_alone() {
        let (tunnel, gate, held, journal) = tunnel_with_open_stream().await;
        drop(held);
        for _ in 0..100 {
            if tunnel.open_streams.load(Ordering::SeqCst) == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(tunnel.open_streams.load(Ordering::SeqCst), 0);
        gate.store(false, Ordering::SeqCst);
        for _ in 0..TICKS_TO_DEAD * 2 {
            tunnel.watchdog_tick_with(&|_| Traffic { rx: 5, ..Traffic::default() }).await;
        }
        assert!(tunnel.conn.lock().await.conn.is_some());
        assert!(!journal.snapshot_json(0).contains("dead"));
    }

    /// The counters the watches read move when the PC talks and acknowledges,
    /// over a real connection: the PING we sent was a STREAM frame the PC ACKed.
    #[tokio::test]
    async fn the_counters_count_datagrams_sent_frames_and_acknowledgements() {
        let (tunnel, _gate, _held, _) = tunnel_with_open_stream().await;
        let conn = tunnel.connection().await.expect("cached");
        let t = read_traffic(&conn);
        assert!(t.rx > 0, "{t:?}");
        assert!(t.sent > 0, "{t:?}");
        assert!(t.acked > 0, "{t:?}");
    }

    /// The journal's case: datagrams keep arriving and requests keep being sent,
    /// but the PC acknowledges nothing. Only the acknowledgement watch can see it.
    #[tokio::test]
    async fn a_connection_whose_sent_data_is_never_acknowledged_is_nudged_then_dropped_though_datagrams_arrive() {
        let (tunnel, _gate, _held, journal) = tunnel_with_open_stream().await;
        let conn = tunnel.connection().await.expect("cached");
        let base = read_traffic(&conn);
        let tick = AtomicU64::new(0);
        for _ in 0..TICKS_TO_DEAD {
            let n = tick.fetch_add(1, Ordering::SeqCst);
            tunnel.watchdog_tick_with(&|_| Traffic { rx: base.rx + n * 3, sent: base.sent + n, acked: base.acked }).await;
        }
        let slot = tunnel.conn.lock().await;
        assert!(slot.conn.is_none(), "the unacknowledged connection is still cached");
        assert!(slot.needs_fresh_endpoint, "the redial must start on a fresh endpoint");
        let json = journal.snapshot_json(0);
        let nudge = json.find("\"k\":\"unacked\"").unwrap_or_else(|| panic!("{json}"));
        let dead = json.find("\"k\":\"uplink_dead\"").unwrap_or_else(|| panic!("{json}"));
        assert!(nudge < dead, "{json}");
        assert!(json.contains("nothing acknowledged for 8s"), "{json}");
        assert!(json.contains("paths=["), "the verdict names the paths it was sending on: {json}");
        assert!(!json.contains("\"k\":\"quiet\"") && !json.contains("\"k\":\"dead\""), "the downlink was fine: {json}");
    }

    /// Acknowledgements keep arriving with the requests: the same ticks drop nothing.
    #[tokio::test]
    async fn a_connection_whose_sent_data_is_acknowledged_is_left_alone() {
        let (tunnel, _gate, _held, journal) = tunnel_with_open_stream().await;
        let n = AtomicU64::new(0);
        for _ in 0..TICKS_TO_DEAD * 3 {
            let i = n.fetch_add(1, Ordering::SeqCst);
            tunnel.watchdog_tick_with(&|_| Traffic { rx: i, sent: i, acked: i }).await;
        }
        assert!(tunnel.conn.lock().await.conn.as_ref().is_some_and(|c| c.close_reason().is_none()));
        let json = journal.snapshot_json(0);
        assert!(!json.contains("unacked") && !json.contains("uplink_dead"), "{json}");
    }
