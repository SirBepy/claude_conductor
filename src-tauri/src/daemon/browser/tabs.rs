//! Tab bookkeeping for the per-chat Playwright drivers, done through Chrome's
//! DevTools HTTP endpoint. Playwright MCP does not expose the target id of the
//! tab it opens, so the id is found by listing page targets before and after
//! the `browser_tabs new` call. A driver's tab is closed by that id when the
//! driver is retired: closing by tab index would hit the wrong tab as soon as
//! another chat opened or closed one in between.

use std::time::Duration;

use serde_json::Value;

/// A wedged Chrome must not hold up an idle sweep or a chat's tool call.
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);

/// Held across "list, open tab, list": a second driver opening its tab in
/// between would make both diffs see two new pages and neither could tell
/// which is its own.
pub(super) static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Ids of the `page` targets in a `/json/list` body. Service workers,
/// extension pages and the like are not tabs a driver opens or must close.
fn page_ids(list: &Value) -> Vec<String> {
    list.as_array()
        .map(|targets| {
            targets
                .iter()
                .filter(|t| t["type"] == "page")
                .filter_map(|t| t["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The one page in `after` that `before` lacked. Anything but exactly one
/// means the attribution is a guess, and closing a guessed tab could take out
/// a live chat's, so it yields `None` and the tab is left alone.
fn single_new(before: &[String], after: &[String]) -> Option<String> {
    let mut fresh = after.iter().filter(|id| !before.contains(id));
    let first = fresh.next()?;
    fresh.next().is_none().then(|| first.clone())
}

pub(super) async fn list_pages(base: &str) -> Option<Vec<String>> {
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().ok()?;
    let body: Value = client.get(format!("{base}/json/list")).send().await.ok()?.json().await.ok()?;
    Some(page_ids(&body))
}

/// Target id of the tab opened by `open`, or `None` when it cannot be told
/// apart (Chrome unreachable, or other tabs appeared at the same moment). A
/// failed `open` can still have opened its tab, which nothing would ever
/// close, so that tab is closed here before the error is returned.
pub(super) async fn open_and_find<F, Fut, E>(base: &str, open: F) -> Result<Option<String>, E>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), E>>,
{
    let _guard = OPEN_LOCK.lock().await;
    let before = list_pages(base).await;
    let opened = open().await;
    let after = list_pages(base).await;
    let found = match (before, after) {
        (Some(b), Some(a)) => single_new(&b, &a),
        _ => None,
    };
    if let Err(e) = opened {
        if let Some(id) = found {
            close_page(base, &id).await;
        }
        return Err(e);
    }
    Ok(found)
}

/// Best-effort: the tab may already be gone with a relaunched Chrome. The
/// browser's last tab is left open: closing a window's last tab closes the
/// window, and Chrome exits with its last window, which would take the
/// DevTools port every other driver attaches through down with it.
pub(super) async fn close_page(base: &str, target_id: &str) {
    if list_pages(base).await.is_some_and(|pages| pages == [target_id]) {
        log::debug!("claude browser: leaving tab {target_id} open, it is the browser's last");
        return;
    }
    let Ok(client) = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() else { return };
    if let Err(e) = client.get(format!("{base}/json/close/{target_id}")).send().await {
        log::debug!("claude browser: closing tab {target_id} failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn page_ids_skip_non_tab_targets() {
        let list = json!([
            {"id": "A", "type": "page"},
            {"id": "B", "type": "service_worker"},
            {"id": "C", "type": "page"},
        ]);
        assert_eq!(page_ids(&list), vec!["A".to_string(), "C".to_string()]);
        assert!(page_ids(&json!({"not": "a list"})).is_empty());
    }

    #[test]
    fn only_an_unambiguous_new_page_is_attributed() {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(single_new(&ids(&["A"]), &ids(&["A", "B"])), Some("B".to_string()));
        assert_eq!(single_new(&ids(&["A"]), &ids(&["A"])), None, "nothing new");
        assert_eq!(single_new(&ids(&["A"]), &ids(&["A", "B", "C"])), None, "two new pages: a guess could close another chat's tab");
    }

    /// A stand-in for Chrome's DevTools HTTP port: serves a mutable
    /// `/json/list` and records every `/json/close/<id>` it is asked for.
    struct FakeChrome {
        base: String,
        pages: Arc<Mutex<Vec<String>>>,
        closed: Arc<Mutex<Vec<String>>>,
    }

    async fn fake_chrome(initial: &[&str]) -> FakeChrome {
        let pages = Arc::new(Mutex::new(initial.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
        let closed = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (p, c) = (pages.clone(), closed.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let (p, c) = (p.clone(), c.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 2048];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                    let body = if let Some(id) = path.strip_prefix("/json/close/") {
                        c.lock().unwrap().push(id.to_string());
                        p.lock().unwrap().retain(|x| x != id);
                        "Target is closing".to_string()
                    } else {
                        let targets: Vec<Value> =
                            p.lock().unwrap().iter().map(|id| json!({"id": id, "type": "page"})).collect();
                        Value::Array(targets).to_string()
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        FakeChrome { base, pages, closed }
    }

    #[tokio::test]
    async fn the_tab_a_driver_opens_is_found_and_closed_by_id() {
        let chrome = fake_chrome(&["startup"]).await;

        let pages = chrome.pages.clone();
        let id = open_and_find(&chrome.base, || async move {
            pages.lock().unwrap().push("driver-tab".to_string());
            Ok::<(), String>(())
        })
        .await
        .unwrap();
        assert_eq!(id.as_deref(), Some("driver-tab"));

        close_page(&chrome.base, "driver-tab").await;
        assert_eq!(*chrome.closed.lock().unwrap(), vec!["driver-tab".to_string()]);
        assert_eq!(
            list_pages(&chrome.base).await.unwrap(),
            vec!["startup".to_string()],
            "only the startup tab is left, not a pile of abandoned ones"
        );
    }

    #[tokio::test]
    async fn the_browsers_last_tab_is_never_closed() {
        let chrome = fake_chrome(&["only"]).await;
        close_page(&chrome.base, "only").await;
        assert!(chrome.closed.lock().unwrap().is_empty(), "closing it would exit Chrome");
        assert_eq!(list_pages(&chrome.base).await.unwrap(), vec!["only".to_string()]);
    }

    #[tokio::test]
    async fn a_tab_opened_by_a_failing_open_is_closed_not_leaked() {
        let chrome = fake_chrome(&["startup"]).await;
        let pages = chrome.pages.clone();
        let res = open_and_find(&chrome.base, || async move {
            pages.lock().unwrap().push("half-open".to_string());
            Err::<(), String>("browser_tabs new failed".into())
        })
        .await;
        assert_eq!(res, Err("browser_tabs new failed".to_string()));
        assert_eq!(*chrome.closed.lock().unwrap(), vec!["half-open".to_string()]);
    }

    #[tokio::test]
    async fn an_unreachable_chrome_attributes_nothing_and_close_does_not_panic() {
        // Port 1 on loopback refuses connections.
        let base = "http://127.0.0.1:1";
        let id = open_and_find(base, || async { Ok::<(), String>(()) }).await.unwrap();
        assert_eq!(id, None);
        close_page(base, "gone").await;
    }
}
