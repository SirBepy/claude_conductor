use std::collections::HashSet;
use std::time::Instant;

use futures_util::{SinkExt, StreamExt};
use super::*;

#[test]
fn only_the_bridge_extension_and_originless_clients_pass_the_origin_check() {
    let mut h = HeaderMap::new();
    let ext = format!("chrome-extension://{EXTENSION_ID}");
    assert!(origin_ok(&h, None), "Playwright sends no Origin");
    assert!(!origin_ok(&h, Some(&ext)), "the extension always sends one");
    h.insert("origin", "https://evil.example".parse().unwrap());
    assert!(!origin_ok(&h, None), "a web page cannot reach a chat endpoint");
    assert!(!origin_ok(&h, Some(&ext)));
    h.insert("origin", format!("{ext}/").parse().unwrap());
    assert!(origin_ok(&h, Some(&ext)));
}

#[test]
fn random_hex_is_lowercase_hex_of_twice_the_byte_count() {
    let h = random_hex(16);
    assert_eq!(h.len(), 32);
    assert!(h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
}

#[test]
fn the_pairing_file_is_replaced_whole_and_leaves_no_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = pairing_file(dir.path(), "");
    write_pairing_file(&path, r#"{"port":1,"token":"a"}"#).unwrap();
    write_pairing_file(&path, r#"{"port":2,"token":"b"}"#).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"port":2,"token":"b"}"#);
    let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 1, "the temp sibling is renamed away: {names:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMsg;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str, origin: Option<&str>) -> Result<Ws, String> {
    let mut req = url.into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

async fn recv(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timed out").unwrap().unwrap();
        if let WsMsg::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v.get("ping").is_none() {
                return v;
            }
        }
    }
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(WsMsg::Text(v.to_string())).await.unwrap();
}

/// The fake extension answers one call it expects by name.
async fn answer(ext: &mut Ws, call: &str, result: Value) -> Value {
    let m = recv(ext).await;
    assert_eq!(m["call"], json!(call), "{m}");
    send(ext, json!({ "id": m["id"], "result": result })).await;
    m
}

/// One extension, two chats, over real sockets: a chat's first page opens
/// a minimized window of its own, focus emulation goes on, the other
/// chat cannot reach that tab, and the window closes when its chat leaves.
#[tokio::test]
async fn two_chats_share_one_browser_each_in_its_own_window() {
    let _singleton = SINGLETON_TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    {
        // Keeps the pairing file out of the real data dir.
        let _env = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("CC_DATA_DIR", dir.path());
        get().start().await;
        std::env::remove_var("CC_DATA_DIR");
    }
    let b = get();
    let port = *b.port.get().unwrap();
    let pairing: Value = serde_json::from_str(&std::fs::read_to_string(pairing_file(dir.path(), &crate::daemon::instance::instance_suffix())).unwrap()).unwrap();
    assert_eq!(pairing["port"], json!(port));

    let ext_url = format!("ws://127.0.0.1:{port}/extension?token={}", b.token);
    let ext_origin = format!("chrome-extension://{EXTENSION_ID}");
    assert!(connect(&format!("ws://127.0.0.1:{port}/extension?token=nope"), Some(&ext_origin)).await.is_err(), "wrong token");
    assert!(connect(&ext_url, Some("chrome-extension://someoneelse")).await.is_err(), "another extension");
    let mut ext = connect(&ext_url, Some(&ext_origin)).await.unwrap();
    send(&mut ext, json!({ "event": "hello", "args": [{ "browser": "brave", "userAgent": "Mozilla/5.0 Chrome/155.0.7.1 Safari/537.36", "installId": "install-1" }] })).await;
    b.ensure_connected(&Mine { app: App::Brave, profile: None }).await.unwrap();
    assert_eq!(b.connected_browsers(), ["Brave"]);

    let key_a = "chat-a";
    let (_, url_a) = b.register(key_a, App::Brave, false).unwrap();
    let (_, url_b) = b.register("chat-c", App::Brave, false).unwrap();
    assert!(connect(&url_a, Some("https://evil.example")).await.is_err(), "a web page cannot open a chat endpoint");
    let mut a = connect(&url_a, None).await.unwrap();
    let mut c = connect(&url_b, None).await.unwrap();

    send(&mut a, json!({ "id": 1, "method": "Browser.getVersion" })).await;
    assert_eq!(recv(&mut a).await["result"]["product"], json!("Chrome/155.0.7.1"));

    send(&mut a, json!({ "id": 2, "method": "Target.createTarget", "params": { "url": "about:blank" } })).await;
    let create = answer(&mut ext, "windows.create", json!({ "id": 7, "tabs": [{ "id": 70 }] })).await;
    assert_eq!(create["args"][0]["state"], json!("minimized"));
    assert_eq!(create["args"][0]["focused"], json!(false));
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T70", "type": "page", "url": "about:blank" } })).await;
    let focus = answer(&mut ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(focus["args"][1], json!("Emulation.setFocusEmulationEnabled"));
    let attached = recv(&mut a).await;
    assert_eq!(attached["method"], json!("Target.attachedToTarget"));
    let session = attached["params"]["sessionId"].as_str().unwrap().to_string();
    assert_eq!(recv(&mut a).await, json!({ "id": 2, "result": { "targetId": "T70" } }));

    // Events reach only the owner; the other chat cannot borrow the session.
    send(&mut ext, json!({ "event": "debugger.onEvent", "args": [{ "tabId": 70 }, "Page.loadEventFired", { "timestamp": 1 }] })).await;
    let ev = recv(&mut a).await;
    assert_eq!((ev["method"].as_str(), ev["sessionId"].as_str()), (Some("Page.loadEventFired"), Some(session.as_str())));
    send(&mut c, json!({ "id": 9, "method": "Runtime.evaluate", "sessionId": session, "params": {} })).await;
    assert!(recv(&mut c).await["error"]["message"].as_str().unwrap().contains("does not belong"));

    // The owner's own command reaches its tab, in order.
    send(&mut a, json!({ "id": 3, "method": "Page.navigate", "sessionId": session, "params": { "url": "https://example.com" } })).await;
    let nav = answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F" })).await;
    assert_eq!(nav["args"], json!([{ "tabId": 70 }, "Page.navigate", { "url": "https://example.com" }]));
    assert_eq!(recv(&mut a).await["result"]["frameId"], json!("F"));

    // The setup Playwright sends for a page is what a re-attach has to replay.
    for (n, method) in [(5, "Page.enable"), (6, "Runtime.enable")] {
        send(&mut a, json!({ "id": n, "method": method, "sessionId": session, "params": {} })).await;
        answer(&mut ext, "debugger.sendCommand", json!({})).await;
        assert_eq!(recv(&mut a).await["id"], json!(n));
    }

    // Brave detaches a live tab with target_closed when a new email input takes
    // focus (pc-1454). The chat never hears a close: the bridge attaches again
    // under the same session, replays the setup, and a command sent meanwhile
    // waits for the replay instead of failing.
    send(&mut ext, json!({ "event": "debugger.onDetach", "args": [{ "tabId": 70 }, "target_closed"] })).await;
    let probe = recv(&mut ext).await;
    assert_eq!(probe["call"], json!("tabs.get"));
    send(&mut a, json!({ "id": 7, "method": "Page.navigate", "sessionId": session, "params": { "url": "https://example.org" } })).await;
    send(&mut ext, json!({ "id": probe["id"], "result": { "id": 70 } })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T70", "type": "page", "url": "https://example.com/moved", "title": "Moved" } })).await;
    let focus = answer(&mut ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(focus["args"][1], json!("Emulation.setFocusEmulationEnabled"));
    let replayed = [answer(&mut ext, "debugger.sendCommand", json!({})).await, answer(&mut ext, "debugger.sendCommand", json!({})).await];
    assert_eq!(replayed.map(|m| m["args"][1].as_str().unwrap().to_string()), ["Page.enable", "Runtime.enable"], "the recorded setup, in the order it was sent");
    let nav = answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F2" })).await;
    assert_eq!(nav["args"], json!([{ "tabId": 70 }, "Page.navigate", { "url": "https://example.org" }]), "the held command goes last");
    let cleared = recv(&mut a).await;
    assert_eq!((cleared["method"].as_str(), cleared["sessionId"].as_str()), (Some("Runtime.executionContextsCleared"), Some(session.as_str())), "Playwright sees a reload, not a close");
    assert_eq!(recv(&mut a).await, json!({ "id": 7, "result": { "frameId": "F2" }, "sessionId": session }));
    send(&mut ext, json!({ "event": "debugger.onEvent", "args": [{ "tabId": 70 }, "Page.loadEventFired", { "timestamp": 2 }] })).await;
    assert_eq!(recv(&mut a).await["sessionId"], json!(session), "the same session keeps hearing the tab");

    // A detach for a tab the browser no longer has stays a close.
    send(&mut ext, json!({ "event": "debugger.onDetach", "args": [{ "tabId": 70 }, "target_closed"] })).await;
    let probe = recv(&mut ext).await;
    assert_eq!(probe["call"], json!("tabs.get"));
    send(&mut ext, json!({ "id": probe["id"], "error": "No tab with id: 70." })).await;
    let gone = recv(&mut a).await;
    assert_eq!((gone["method"].as_str(), gone["params"]["sessionId"].as_str()), (Some("Target.detachedFromTarget"), Some(session.as_str())));

    // A detach the user or DevTools asked for is never undone.
    send(&mut a, json!({ "id": 4, "method": "Target.createTarget", "params": { "url": "about:blank" } })).await;
    answer(&mut ext, "tabs.create", json!({ "id": 71 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T71", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(recv(&mut a).await["method"], json!("Target.attachedToTarget"));
    assert_eq!(recv(&mut a).await, json!({ "id": 4, "result": { "targetId": "T71" } }));
    send(&mut ext, json!({ "event": "debugger.onDetach", "args": [{ "tabId": 71 }, "canceled_by_user"] })).await;
    assert_eq!(recv(&mut a).await["method"], json!("Target.detachedFromTarget"));

    // A tab another extension holds (Bitwarden's autofill menu frame) is parked:
    // the chat is told why instead of seeing a close, the attach is retried, and
    // the tab is driven again as soon as the browser lets go.
    send(&mut a, json!({ "id": 10, "method": "Target.createTarget", "params": { "url": "about:blank" } })).await;
    answer(&mut ext, "tabs.create", json!({ "id": 72 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T72", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    let attached = recv(&mut a).await;
    let session72 = attached["params"]["sessionId"].as_str().unwrap().to_string();
    assert_eq!(recv(&mut a).await["id"], json!(10));
    send(&mut ext, json!({ "event": "debugger.onDetach", "args": [{ "tabId": 72 }, "target_closed"] })).await;
    let probe = recv(&mut ext).await;
    assert_eq!(probe["call"], json!("tabs.get"));
    send(&mut a, json!({ "id": 11, "method": "Page.navigate", "sessionId": session72, "params": { "url": "https://example.com" } })).await;
    send(&mut ext, json!({ "id": probe["id"], "result": { "id": 72 } })).await;
    let refusal = "Cannot access a chrome-extension:// URL of different extension";
    for round in 0..2 {
        if round == 1 {
            answer(&mut ext, "tabs.get", json!({ "id": 72 })).await;
        }
        let attach = recv(&mut ext).await;
        assert_eq!(attach["call"], json!("debugger.attach"));
        send(&mut ext, json!({ "id": attach["id"], "error": refusal })).await;
        if round == 0 {
            let blocked = recv(&mut a).await;
            assert_eq!(blocked["id"], json!(11), "the held command is answered at once with the reason");
            let msg = blocked["error"]["message"].as_str().unwrap();
            assert!(msg.contains("BLOCKED ON JOE") && msg.contains("password manager"), "{msg}");
        }
    }
    answer(&mut ext, "tabs.get", json!({ "id": 72 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T72", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    let cleared = recv(&mut a).await;
    assert_eq!((cleared["method"].as_str(), cleared["sessionId"].as_str()), (Some("Runtime.executionContextsCleared"), Some(session72.as_str())), "no close in between");
    send(&mut a, json!({ "id": 12, "method": "Page.navigate", "sessionId": session72, "params": { "url": "https://example.com" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F3" })).await;
    assert_eq!(recv(&mut a).await["result"]["frameId"], json!("F3"), "the parked tab is driven again");

    // A browser that detaches the fresh debugger again while the setup replays
    // gets the attach redone; the chat still never hears a close.
    send(&mut a, json!({ "id": 13, "method": "Page.enable", "sessionId": session72, "params": {} })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(recv(&mut a).await["id"], json!(13));
    send(&mut ext, json!({ "event": "debugger.onDetach", "args": [{ "tabId": 72 }, "target_closed"] })).await;
    answer(&mut ext, "tabs.get", json!({ "id": 72 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T72", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    let replay = recv(&mut ext).await;
    assert_eq!(replay["args"][1], json!("Page.enable"));
    send(&mut ext, json!({ "event": "debugger.onDetach", "args": [{ "tabId": 72 }, "target_closed"] })).await;
    send(&mut ext, json!({ "id": replay["id"], "error": "Debugger is not attached to the tab with id: 72." })).await;
    answer(&mut ext, "tabs.get", json!({ "id": 72 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T72", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    for _ in 0..2 {
        assert_eq!(recv(&mut a).await["method"], json!("Runtime.executionContextsCleared"), "a reload each round, never a close");
    }
    send(&mut a, json!({ "id": 14, "method": "Page.navigate", "sessionId": session72, "params": { "url": "https://example.com" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F4" })).await;
    assert_eq!(recv(&mut a).await["result"]["frameId"], json!("F4"));

    // The extension socket drops (Brave did so about every 5 minutes). The tab is
    // still open, so the chat hears no close: a command sent during the gap waits,
    // and when the same install says hello again the tab is attached again under
    // the same session, the setup is replayed, and the command goes last.
    drop(ext);
    for _ in 0..100 {
        if b.lock().model.chats.get(key_a).is_some_and(|c| c.reconnect.is_some()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(b.lock().model.chats[key_a].reconnect.is_some(), "the chat waits for its browser");
    send(&mut a, json!({ "id": 15, "method": "Page.navigate", "sessionId": session72, "params": { "url": "https://example.net" } })).await;
    // A call that needs the browser itself waits too, then runs on the new connection.
    send(&mut a, json!({ "id": 16, "method": "Target.createTarget", "params": { "url": "about:blank" } })).await;
    let mut ext = connect(&ext_url, Some(&ext_origin)).await.unwrap();
    send(&mut ext, json!({ "event": "hello", "args": [{ "browser": "brave", "userAgent": "Mozilla/5.0 Chrome/155.0.7.1 Safari/537.36", "installId": "install-1" }] })).await;
    let window = recv(&mut ext).await;
    assert_eq!((window["call"].as_str(), &window["args"][0]), (Some("windows.get"), &json!(7)), "the window is checked first");
    send(&mut ext, json!({ "id": window["id"], "result": { "id": 7 } })).await;
    answer(&mut ext, "tabs.get", json!({ "id": 72 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T72", "type": "page", "url": "https://example.com" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    let replayed = answer(&mut ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(replayed["args"][1], json!("Page.enable"), "the setup the chat sent before the drop");
    let nav = answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F5" })).await;
    assert_eq!(nav["args"], json!([{ "tabId": 72 }, "Page.navigate", { "url": "https://example.net" }]), "the command that waited goes last");
    let cleared = recv(&mut a).await;
    assert_eq!((cleared["method"].as_str(), cleared["sessionId"].as_str()), (Some("Runtime.executionContextsCleared"), Some(session72.as_str())), "a reload, not a close");
    assert_eq!(recv(&mut a).await, json!({ "id": 15, "result": { "frameId": "F5" }, "sessionId": session72 }));
    // The waiting createTarget reuses the chat's window on the new connection.
    let created = answer(&mut ext, "tabs.create", json!({ "id": 73 })).await;
    assert_eq!(created["args"][0]["windowId"], json!(7), "the same window, not a new one");
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T73", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    let attached73 = recv(&mut a).await;
    assert_eq!(attached73["method"], json!("Target.attachedToTarget"));
    let session73 = attached73["params"]["sessionId"].as_str().unwrap().to_string();
    let superseded = answer(&mut ext, "tabs.remove", json!({})).await;
    assert_eq!(superseded["args"], json!([[72]]), "the chat's one-tab-at-a-time rule still holds");
    assert_eq!(recv(&mut a).await["id"], json!(16));
    send(&mut ext, json!({ "event": "tabs.onRemoved", "args": [72, { "windowId": 7, "isWindowClosing": false }] })).await;
    assert_eq!(recv(&mut a).await["method"], json!("Target.detachedFromTarget"));

    // The child leaves (the idle sweep retires it, or it restarts): the window and the tab stay open.
    drop(a);
    wait_for(|| b.lock().model.chats.get(key_a).is_some_and(|c| c.parked.is_some())).await;
    assert!(quiet(&mut ext, 300).await, "no windows.remove: a child leaving does not close the chat's window");
    assert_eq!(b.lock().model.chats[key_a].window_id, Some(7));

    // The session's next child lands on the same window and tab. Its debugger is attached fresh (the
    // old child's setup is not the new one's), and what the new Playwright sends meanwhile waits.
    let (_, url_a2) = b.register(key_a, App::Brave, false).unwrap();
    let mut a2 = connect(&url_a2, None).await.unwrap();
    let detach = answer(&mut ext, "debugger.detach", Value::Null).await;
    assert_eq!(detach["args"], json!([{ "tabId": 73 }]));
    answer(&mut ext, "tabs.get", json!({ "id": 73 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T73", "type": "page", "url": "about:blank" } })).await;
    assert_eq!(answer(&mut ext, "debugger.sendCommand", json!({})).await["args"][1], json!("Emulation.setFocusEmulationEnabled"));
    let cleared = recv(&mut a2).await;
    assert_eq!((cleared["method"].as_str(), cleared["sessionId"].as_str()), (Some("Runtime.executionContextsCleared"), Some(session73.as_str())));
    send(&mut a2, json!({ "id": 1, "method": "Target.setAutoAttach", "params": { "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true } })).await;
    let again = recv(&mut a2).await;
    assert_eq!((again["method"].as_str(), again["params"]["sessionId"].as_str()), (Some("Target.attachedToTarget"), Some(session73.as_str())), "the same page, the same session id");
    assert_eq!(recv(&mut a2).await, json!({ "id": 1, "result": {} }));
    send(&mut a2, json!({ "id": 2, "method": "Page.navigate", "sessionId": session73, "params": { "url": "https://example.com/back" } })).await;
    let nav = answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F6" })).await;
    assert_eq!(nav["args"], json!([{ "tabId": 73 }, "Page.navigate", { "url": "https://example.com/back" }]));
    assert_eq!(recv(&mut a2).await["result"]["frameId"], json!("F6"));
    {
        let i = b.lock();
        assert_eq!((i.model.chats[key_a].window_id, i.model.chats[key_a].parked), (Some(7), None), "the same window, no longer parked");
    }

    // A child that connects before the old socket's end is noticed replaces it, and the old socket's end
    // then leaves the chat alone.
    let (_, url_a3) = b.register(key_a, App::Brave, false).unwrap();
    let mut a3 = connect(&url_a3, None).await.unwrap();
    answer(&mut ext, "debugger.detach", Value::Null).await;
    answer(&mut ext, "tabs.get", json!({ "id": 73 })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T73", "type": "page", "url": "about:blank" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(recv(&mut a3).await["method"], json!("Runtime.executionContextsCleared"));
    drop(a2);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(b.lock().model.chats[key_a].parked.is_none(), "the replaced socket's end does not park a chat that has a newer socket");
    send(&mut a3, json!({ "id": 1, "method": "Target.getTargets" })).await;
    assert_eq!(recv(&mut a3).await["result"]["targetInfos"][0]["targetId"], json!("T73"), "the chat is still the new child's");

    // A day without a child closes the window, a shorter time does not.
    drop(a3);
    wait_for(|| b.lock().model.chats.get(key_a).is_some_and(|c| c.parked.is_some())).await;
    b.sweep_parked_at(Instant::now(), model::PARK_MAX).await;
    assert!(quiet(&mut ext, 200).await, "parked for less than a day: left alone");
    let sweeping = tokio::spawn(b.sweep_parked_at(Instant::now() + model::PARK_MAX, model::PARK_MAX));
    let close = answer(&mut ext, "windows.remove", json!({})).await;
    assert_eq!(close["args"], json!([7]), "the parked window closes after the cap");
    sweeping.await.unwrap();
    assert!(!b.lock().model.chats.contains_key(key_a));

    // A chat that calls browser_close loses its window but not its child; the next page opens a new window.
    let (_, url_b) = b.register("chat-b", App::Brave, false).unwrap();
    let mut chat_b = connect(&url_b, None).await.unwrap();
    open_in_new_window(&mut ext, &mut chat_b, 1, (8, 80)).await;
    let closing = tokio::spawn(b.close_window("chat-b"));
    assert_eq!(answer(&mut ext, "windows.remove", json!({})).await["args"], json!([8]));
    closing.await.unwrap();
    send(&mut ext, json!({ "event": "tabs.onRemoved", "args": [80, { "windowId": 8, "isWindowClosing": true }] })).await;
    assert_eq!(recv(&mut chat_b).await["method"], json!("Target.detachedFromTarget"), "the chat hears its page close through the browser's own event");
    open_in_new_window(&mut ext, &mut chat_b, 2, (9, 90)).await;

    // Its child leaves, then the chat is gone from the session registry: the window closes with it.
    drop(chat_b);
    wait_for(|| b.lock().model.chats.get("chat-b").is_some_and(|c| c.parked.is_some())).await;
    let live: HashSet<String> = ["somebody-else".to_string()].into_iter().collect();
    let pruning = tokio::spawn(async move { b.prune_sessions(&live).await });
    assert_eq!(answer(&mut ext, "windows.remove", json!({})).await["args"], json!([9]));
    pruning.await.unwrap();
    assert!(!b.lock().model.chats.contains_key("chat-b"));

    // Ending a session closes its window whether or not a child is connected (a browser_target switch).
    let (_, url_d) = b.register("chat-d", App::Brave, false).unwrap();
    let mut chat_d = connect(&url_d, None).await.unwrap();
    open_in_new_window(&mut ext, &mut chat_d, 1, (10, 100)).await;
    let ending = tokio::spawn(b.end_session("chat-d"));
    assert_eq!(answer(&mut ext, "windows.remove", json!({})).await["args"], json!([10]));
    ending.await.unwrap();

    // Joe's own tab: listed, taken by one chat only, never closed (a close only detaches), and
    // let go of when its chat ends.
    let (_, url_e) = b.register("chat-e", App::Brave, false).unwrap();
    let mut chat_e = connect(&url_e, None).await.unwrap();
    let listing = tokio::spawn(async move { b.adopt_list("chat-e", &Mine { app: App::Brave, profile: None }).await });
    let query = answer(
        &mut ext,
        "tabs.query",
        json!([
            { "id": 55, "windowId": 1, "url": "https://mail.example.com/inbox?token=secret#frag", "title": "Inbox" },
            { "id": 56, "windowId": 1, "url": "chrome://settings", "title": "Settings" }
        ]),
    )
    .await;
    assert_eq!(query["args"], json!([{ "windowType": "normal" }]), "only normal windows, nothing else is asked of the browser");
    let text = listing.await.unwrap().unwrap();
    assert!(text.contains("55") && text.contains("Inbox") && text.contains("mail.example.com"), "{text}");
    assert!(!text.contains("secret") && !text.contains("chrome://"), "no query string, no browser pages: {text}");

    let taking = tokio::spawn(async move { b.adopt_take("chat-e", &Mine { app: App::Brave, profile: None }, 55).await });
    answer(&mut ext, "tabs.get", json!({ "id": 55, "windowId": 1, "url": "https://mail.example.com/inbox", "title": "Inbox" })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T55", "type": "page", "url": "https://mail.example.com/inbox", "title": "Inbox" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    let note = taking.await.unwrap().unwrap();
    assert!(note.contains("never closed"), "{note}");
    assert_eq!(recv(&mut chat_e).await["method"], json!("Target.attachedToTarget"), "the chat hears the tab like a popup");

    let (_, url_f) = b.register("chat-f", App::Brave, false).unwrap();
    let mut chat_f = connect(&url_f, None).await.unwrap();
    let refused = b.adopt_take("chat-f", &Mine { app: App::Brave, profile: None }, 55).await.unwrap_err();
    assert!(refused.contains("holds that tab"), "another chat's take is refused without touching the browser: {refused}");
    assert!(quiet(&mut ext, 100).await);

    send(&mut chat_e, json!({ "id": 20, "method": "Target.closeTarget", "params": { "targetId": "T55" } })).await;
    assert_eq!(recv(&mut chat_e).await["method"], json!("Target.detachedFromTarget"));
    let released = answer(&mut ext, "debugger.detach", Value::Null).await;
    assert_eq!(released["args"], json!([{ "tabId": 55 }]));
    assert_eq!(recv(&mut chat_e).await, json!({ "id": 20, "result": { "success": true } }));
    assert!(quiet(&mut ext, 200).await, "no tabs.remove: closing an adopted tab only lets go of it");

    // Taken again, then the chat ends: the debugger goes, the tab and its window stay.
    let taking = tokio::spawn(async move { b.adopt_take("chat-e", &Mine { app: App::Brave, profile: None }, 55).await });
    answer(&mut ext, "tabs.get", json!({ "id": 55, "windowId": 1, "url": "https://mail.example.com/inbox", "title": "Inbox" })).await;
    answer(&mut ext, "debugger.attach", Value::Null).await;
    answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T55", "type": "page", "url": "https://mail.example.com/inbox" } })).await;
    answer(&mut ext, "debugger.sendCommand", json!({})).await;
    taking.await.unwrap().unwrap();
    assert_eq!(recv(&mut chat_e).await["method"], json!("Target.attachedToTarget"));
    let ending = tokio::spawn(b.end_session("chat-e"));
    assert_eq!(answer(&mut ext, "debugger.detach", Value::Null).await["args"], json!([{ "tabId": 55 }]));
    ending.await.unwrap();
    assert!(quiet(&mut ext, 200).await, "no windows.remove and no tabs.remove for a tab Joe opened");
    drop(chat_f);
    b.unregister(key_a);
}

/// Waits for `ready`, up to two seconds.
async fn wait_for(ready: impl Fn() -> bool) {
    for _ in 0..100 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not reached");
}

/// True when the extension is sent nothing (pings aside) for `ms`.
async fn quiet(ext: &mut Ws, ms: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        match tokio::time::timeout_at(deadline, ext.next()).await {
            Err(_) => return true,
            Ok(Some(Ok(WsMsg::Text(t)))) if serde_json::from_str::<Value>(&t).is_ok_and(|v| v.get("ping").is_some()) => {}
            Ok(_) => return false,
        }
    }
}

/// The chat asks for a page and the bridge makes a window for it: `(window, tab)` are the ids the fake browser hands out.
async fn open_in_new_window(ext: &mut Ws, chat: &mut Ws, id: u64, (window, tab): (i64, i64)) {
    send(chat, json!({ "id": id, "method": "Target.createTarget", "params": { "url": "about:blank" } })).await;
    answer(ext, "windows.create", json!({ "id": window, "tabs": [{ "id": tab }] })).await;
    answer(ext, "debugger.attach", Value::Null).await;
    answer(ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": format!("T{tab}"), "type": "page", "url": "about:blank" } })).await;
    answer(ext, "debugger.sendCommand", json!({})).await;
    assert_eq!(recv(chat).await["method"], json!("Target.attachedToTarget"));
    assert_eq!(recv(chat).await["id"], json!(id));
}

#[test]
fn the_token_must_match_exactly() {
    let b = get();
    assert!(b.token_ok(Some(&b.token.clone())));
    assert!(!b.token_ok(None));
    assert!(!b.token_ok(Some("")));
    assert!(!b.token_ok(Some(&b.token[..b.token.len() - 1])));
}
