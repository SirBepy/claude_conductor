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
    send(&mut ext, json!({ "event": "hello", "args": [{ "browser": "brave", "userAgent": "Mozilla/5.0 Chrome/155.0.7.1 Safari/537.36" }] })).await;
    b.ensure_connected(&Mine { app: App::Brave, profile: None }).await.unwrap();
    assert_eq!(b.connected_browsers(), ["Brave"]);

    let (key_a, url_a) = b.register(App::Brave, false).unwrap();
    let (_key_b, url_b) = b.register(App::Brave, false).unwrap();
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

    drop(a);
    let close = recv(&mut ext).await;
    assert_eq!((close["call"].as_str(), &close["args"]), (Some("windows.remove"), &json!([7])));
    b.unregister(&key_a);
}

#[test]
fn the_token_must_match_exactly() {
    let b = get();
    assert!(b.token_ok(Some(&b.token.clone())));
    assert!(!b.token_ok(None));
    assert!(!b.token_ok(Some("")));
    assert!(!b.token_ok(Some(&b.token[..b.token.len() - 1])));
}
