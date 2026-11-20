//! The engine's wire side: building the request, sending it with the response size cap, and
//! the words said when a send fails after the request may have left the daemon.

use super::*;

/// Said when the request may already have been applied upstream, so a chat does
/// not blindly retry a write.
const SENT_HINT: &str = "the request may have been delivered and applied; check the object before retrying a write";

/// The hint a failed send carries. A read (a GET, a Linear query) changes nothing, so retrying it is
/// always safe and it gets none; only a write that may have been applied is told to check first.
pub(super) fn sent_hint(read: bool) -> Option<String> {
    (!read).then(|| SENT_HINT.to_string())
}

/// `without_url`: a Trello request carries its secrets in the URL, and reqwest
/// prints the URL in its error text. A connect or request-build failure never reached
/// the wire, so only the other errors carry `sent`.
pub(super) fn net_error(e: reqwest::Error) -> SendError {
    SendError::Net { timeout: e.is_timeout(), sent: !(e.is_connect() || e.is_builder()), message: e.without_url().to_string() }
}

pub(super) struct Upstream {
    pub(super) status: u16,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}

pub(super) enum SendError {
    TooLarge,
    /// `sent` is false when nothing left the daemon (request not built, or the
    /// connection was never made), so a retry is safe.
    Net { message: String, timeout: bool, sent: bool },
}

pub(super) struct Auth {
    pub(super) headers: Vec<(HeaderName, String)>,
    pub(super) query: Vec<(String, String)>,
}

impl Engine {
    fn build_request(
        &self,
        spec: &ServiceSpec,
        auth: &Auth,
        checked: &CheckedRequest,
        body: Option<&[u8]>,
        accept: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let mut url = guards::build_url(spec, checked).map_err(|g| g.message)?;
        if !auth.query.is_empty() {
            let mut q = url.query_pairs_mut();
            for (k, v) in &auth.query {
                q.append_pair(k, v);
            }
        }
        let method = match checked.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        };
        let mut rb = self.client.request(method, url).header(reqwest::header::ACCEPT, accept.unwrap_or("application/json"));
        for (name, value) in &auth.headers {
            let mut v = HeaderValue::from_str(value).map_err(|_| "the stored credential has characters a header cannot carry".to_string())?;
            v.set_sensitive(true);
            rb = rb.header(name.clone(), v);
        }
        if let Some(b) = body {
            rb = rb.header(reqwest::header::CONTENT_TYPE, "application/json").body(b.to_vec());
        }
        Ok(rb)
    }

    pub(super) async fn send(
        &self,
        spec: &ServiceSpec,
        auth: &Auth,
        checked: &CheckedRequest,
        body: Option<&[u8]>,
        accept: Option<&str>,
    ) -> Result<Upstream, SendError> {
        let rb = self.build_request(spec, auth, checked, body, accept).map_err(|message| SendError::Net { message, timeout: false, sent: false })?;
        // `without_url`: a Trello request carries its secrets in the URL, and
        // reqwest prints the URL in its error text.
        let net = net_error;
        let mut resp = rb.send().await.map_err(net)?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(net)? {
            if body.len() + chunk.len() > self.limits.max_response_bytes {
                return Err(SendError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Upstream { status, headers, body })
    }
}

pub(super) fn header_name(name: &str) -> Result<HeaderName, String> {
    HeaderName::from_bytes(name.as_bytes()).map_err(|_| format!("bad header name {name}"))
}
