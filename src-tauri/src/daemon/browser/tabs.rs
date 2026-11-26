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

/// One page target of the daemon Chrome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Page {
    pub id: String,
    pub title: String,
    pub url: String,
}

fn pages_of(list: &Value) -> Vec<Page> {
    list.as_array()
        .map(|targets| {
            targets
                .iter()
                .filter(|t| t["type"] == "page")
                .filter_map(|t| {
                    Some(Page { id: t["id"].as_str()?.to_string(), title: t["title"].as_str().unwrap_or_default().to_string(), url: t["url"].as_str().unwrap_or_default().to_string() })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The page targets with their title and address, `None` when Chrome does not answer.
pub(super) async fn list_pages_detailed(base: &str) -> Option<Vec<Page>> {
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().ok()?;
    let body: Value = client.get(format!("{base}/json/list")).send().await.ok()?.json().await.ok()?;
    Some(pages_of(&body))
}

/// The page `id` in a `/json/list` body: its current URL.
fn url_of(list: &Value, id: &str) -> Option<String> {
    list.as_array()?.iter().find(|t| t["type"] == "page" && t["id"] == id)?["url"].as_str().map(str::to_string)
}

/// The current URL of the page `target_id`, `None` when it is gone or Chrome
/// does not answer.
pub(super) async fn page_url(base: &str, target_id: &str) -> Option<String> {
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().ok()?;
    let body: Value = client.get(format!("{base}/json/list")).send().await.ok()?.json().await.ok()?;
    url_of(&body, target_id)
}

/// The `index: url` entries of Playwright MCP's `browser_tabs list` text, which
/// prints one `- <index>: [(current) ][<title>](<url>)` line per tab. Lines in
/// any other shape are skipped, so a changed format finds nothing instead of
/// the wrong tab.
pub(super) fn parse_tab_list(text: &str) -> Vec<(usize, String)> {
    parse_tab_entries(text).into_iter().map(|(index, _, url)| (index, url)).collect()
}

/// `parse_tab_list` with the `(current)` mark: `(index, is current, url)`.
pub(super) fn parse_tab_entries(text: &str) -> Vec<(usize, bool, String)> {
    text.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("- ")?;
            let (index, rest) = rest.split_once(": ")?;
            let current = rest.starts_with("(current) ");
            let rest = rest.strip_prefix("(current) ").unwrap_or(rest);
            if !rest.starts_with('[') {
                return None;
            }
            let (_, url) = rest.strip_suffix(')')?.rsplit_once("](")?;
            Some((index.parse().ok()?, current, url.to_string()))
        })
        .collect()
}

/// The index of the one tab showing `url`. Several tabs on the same address
/// (another chat's, Joe's) make the pick a guess, and driving someone else's
/// tab is worse than opening a new one.
pub(super) fn pick_resume_index(tabs: &[(usize, String)], url: &str) -> Option<usize> {
    let mut hits = tabs.iter().filter(|(_, u)| u == url);
    let first = hits.next()?;
    hits.next().is_none().then_some(first.0)
}

/// How long a retired driver's tab is kept for the chat's next driver.
const PARK_MAX: Duration = Duration::from_secs(24 * 60 * 60);

/// Tabs of daemon-Chrome drivers that were retired by the idle sweep or died,
/// by session id. The next driver of the session selects the tab again instead
/// of opening a new one (the same promise the bridge keeps for Joe's browser);
/// only the chat ending, a `browser_target` switch or `PARK_MAX` closes it.
#[derive(Default)]
pub(super) struct ParkedTabs(std::collections::HashMap<String, (u16, String, std::time::Instant)>);

impl ParkedTabs {
    pub(super) fn park(&mut self, session: &str, port: u16, target_id: String, now: std::time::Instant) {
        self.0.insert(session.to_string(), (port, target_id, now));
    }

    /// The parked tab of `session` on Chrome's `port`. A tab parked on another
    /// port belongs to a Chrome that is gone and is forgotten.
    pub(super) fn take(&mut self, session: &str, port: u16) -> Option<String> {
        let (p, id, _) = self.0.remove(session)?;
        (p == port).then_some(id)
    }

    /// Target ids of every other chat's parked tab: tabs a chat may not adopt.
    pub(super) fn ids_except(&self, session: &str) -> Vec<String> {
        self.0.iter().filter(|(s, _)| s.as_str() != session).map(|(_, (_, id, _))| id.clone()).collect()
    }

    /// Forgets `session`'s parked tab, for the caller to close.
    pub(super) fn drop_session(&mut self, session: &str) -> Option<(u16, String)> {
        self.0.remove(session).map(|(port, id, _)| (port, id))
    }

    /// Forgets the tabs of sessions not in `live`, and those parked over `PARK_MAX`.
    pub(super) fn drop_stale(&mut self, live: Option<&std::collections::HashSet<String>>, now: std::time::Instant) -> Vec<(u16, String)> {
        let gone: Vec<String> = self
            .0
            .iter()
            .filter(|(s, (_, _, at))| live.is_some_and(|l| !l.contains(*s)) || now.saturating_duration_since(*at) >= PARK_MAX)
            .map(|(s, _)| s.clone())
            .collect();
        gone.iter().filter_map(|s| self.drop_session(s)).collect()
    }
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
    fn the_tab_list_text_gives_each_tabs_index_and_url() {
        let text = "### Open tabs\n- 0: [Inbox (3)](https://mail.example/u/0/#inbox)\n- 1: (current) [Example [x] Domain](https://example.com/)\n- 2: [](about:blank)\nnoise";
        assert_eq!(
            parse_tab_list(text),
            vec![(0, "https://mail.example/u/0/#inbox".to_string()), (1, "https://example.com/".to_string()), (2, "about:blank".to_string())]
        );
        assert!(parse_tab_list("- x: [a](b)\n- 1: no link\n").is_empty(), "a shape it does not know finds nothing");
    }

    #[test]
    fn the_tab_list_marks_the_current_tab_and_page_targets_carry_title_and_address() {
        let text = "- 0: [A](https://a.example/)\n- 1: (current) [B](https://b.example/)";
        assert_eq!(parse_tab_entries(text), vec![(0, false, "https://a.example/".to_string()), (1, true, "https://b.example/".to_string())]);
        let list = json!([{"id": "W", "type": "service_worker", "url": "u"}, {"id": "A", "type": "page", "title": "T", "url": "https://a.example/"}]);
        assert_eq!(pages_of(&list), vec![Page { id: "A".into(), title: "T".into(), url: "https://a.example/".into() }]);
    }

    #[test]
    fn a_tab_is_resumed_only_when_its_address_is_unique() {
        let tabs = vec![(0, "https://a.example/".to_string()), (1, "https://b.example/".to_string()), (2, "https://a.example/".to_string())];
        assert_eq!(pick_resume_index(&tabs, "https://b.example/"), Some(1));
        assert_eq!(pick_resume_index(&tabs, "https://a.example/"), None, "two tabs on one address: a guess could drive another chat's tab");
        assert_eq!(pick_resume_index(&tabs, "https://c.example/"), None);
    }

    #[test]
    fn the_url_of_a_page_comes_from_the_page_entries_only() {
        let list = json!([{"id": "W", "type": "service_worker", "url": "https://sw.example/"}, {"id": "A", "type": "page", "url": "https://a.example/"}]);
        assert_eq!(url_of(&list, "A").as_deref(), Some("https://a.example/"));
        assert_eq!(url_of(&list, "W"), None);
        assert_eq!(url_of(&list, "gone"), None);
    }

    #[test]
    fn a_parked_tab_is_handed_back_once_and_only_to_the_chrome_it_lives_in() {
        let t0 = std::time::Instant::now();
        let mut parked = ParkedTabs::default();
        parked.park("s", 9222, "TAB".into(), t0);
        assert_eq!(parked.take("s", 9222).as_deref(), Some("TAB"));
        assert_eq!(parked.take("s", 9222), None, "taken once");
        parked.park("s", 9222, "TAB".into(), t0);
        assert_eq!(parked.take("s", 9333), None, "a relaunched Chrome has no such tab");
        assert_eq!(parked.take("s", 9222), None, "and the stale record is gone");
    }

    #[test]
    fn parked_tabs_go_with_their_chat_and_after_a_day() {
        let t0 = std::time::Instant::now();
        let mut parked = ParkedTabs::default();
        parked.park("live", 1, "L".into(), t0);
        parked.park("gone", 1, "G".into(), t0);
        let live: std::collections::HashSet<String> = ["live".to_string()].into_iter().collect();
        assert_eq!(parked.drop_stale(Some(&live), t0), vec![(1, "G".to_string())]);
        assert!(parked.drop_stale(None, t0 + PARK_MAX - Duration::from_secs(1)).is_empty());
        assert_eq!(parked.drop_stale(None, t0 + PARK_MAX), vec![(1, "L".to_string())]);
        parked.park("s", 2, "S".into(), t0);
        assert_eq!(parked.drop_session("s"), Some((2, "S".to_string())), "a browser_target switch closes it");
        assert_eq!(parked.drop_session("s"), None);
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
