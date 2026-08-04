use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Shared with the app-side reader so one grep finds either half of a stall.
pub const SLOW_SEND_THRESHOLD: Duration = Duration::from_millis(250);

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Response(Response),
    Notification(Notification),
}

impl RpcError {
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method not found: {method}"),
            data: None,
        }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: msg.into(),
            data: None,
        }
    }
    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: msg.into(),
            data: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_roundtrip() {
        let r = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "health".into(),
            params: None,
        };
        let s = serde_json::to_value(&r).unwrap();
        assert_eq!(s, json!({"jsonrpc":"2.0","id":1,"method":"health"}));
        let back: Request = serde_json::from_value(s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn response_with_result_roundtrip() {
        let r = Response {
            jsonrpc: "2.0".into(),
            id: json!(1),
            result: Some(json!({"ok": true})),
            error: None,
        };
        let s = serde_json::to_value(&r).unwrap();
        let back: Response = serde_json::from_value(s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn response_with_error_roundtrip() {
        let r = Response {
            jsonrpc: "2.0".into(),
            id: json!(1),
            result: None,
            error: Some(RpcError::method_not_found("nope")),
        };
        let s = serde_json::to_value(&r).unwrap();
        let back: Response = serde_json::from_value(s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn message_untagged_distinguishes_request_vs_response() {
        let req_json = json!({"jsonrpc":"2.0","id":1,"method":"foo"});
        let resp_json = json!({"jsonrpc":"2.0","id":1,"result":42});
        let notif_json = json!({"jsonrpc":"2.0","method":"event"});

        match serde_json::from_value::<Message>(req_json).unwrap() {
            Message::Request(_) => {}
            other => panic!("expected Request, got {other:?}"),
        }
        match serde_json::from_value::<Message>(resp_json).unwrap() {
            Message::Response(_) => {}
            other => panic!("expected Response, got {other:?}"),
        }
        match serde_json::from_value::<Message>(notif_json).unwrap() {
            Message::Notification(_) => {}
            other => panic!("expected Notification, got {other:?}"),
        }
    }
}

/// Per-connection state threaded through every handler invocation.
#[derive(Clone)]
pub struct ConnectionContext {
    pub outbound: tokio::sync::mpsc::Sender<Value>,
    /// Depth of `outbound`'s queue, since mpsc exposes no `len()`. Decremented
    /// at the dequeue in `transport_common::serve_connection`.
    pub outbound_depth: Arc<AtomicUsize>,
    /// Pairs this connection's log lines across a repro.
    pub conn_id: u64,
    /// Session IDs this connection has attached to. Per-session subscription
    /// tasks are spawned by attach_session and aborted on detach_session OR
    /// on connection close.
    pub subscriptions: std::sync::Arc<tokio::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    /// Daemon-wide notification subscription slot. Populated by
    /// `subscribe_global`; the previous handle (if any) is aborted when a
    /// fresh subscribe is issued.
    pub global_sub: std::sync::Arc<tokio::sync::Mutex<Option<tokio::task::AbortHandle>>>,
}

impl ConnectionContext {
    pub fn new(outbound: tokio::sync::mpsc::Sender<Value>) -> Self {
        Self {
            outbound,
            outbound_depth: Arc::new(AtomicUsize::new(0)),
            conn_id: NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed),
            subscriptions: std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            global_sub: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Single funnel so a future call site can't skip the counter. A failed
    /// send never enters the queue, so undo its increment or the gauge leaks.
    pub async fn send_outbound(&self, msg: Value) -> Result<(), tokio::sync::mpsc::error::SendError<Value>> {
        self.outbound_depth.fetch_add(1, Ordering::Relaxed);
        let result = self.outbound.send(msg).await;
        if result.is_err() {
            self.outbound_depth.fetch_sub(1, Ordering::Relaxed);
        }
        result
    }
}

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, RpcError>> + Send>>;
pub type Handler = Arc<dyn Fn(Option<Value>, ConnectionContext) -> HandlerFuture + Send + Sync>;

#[derive(Default, Clone)]
pub struct Router {
    handlers: HashMap<String, Handler>,
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<F, Fut>(&mut self, method: &str, f: F)
    where
        F: Fn(Option<Value>, ConnectionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, RpcError>> + Send + 'static,
    {
        let arc: Handler = Arc::new(move |p, ctx| Box::pin(f(p, ctx)));
        self.handlers.insert(method.to_string(), arc);
    }

    pub async fn dispatch(&self, req: Request, ctx: ConnectionContext) -> Response {
        log::debug!("rpc dispatch: {}", req.method);
        match self.handlers.get(&req.method) {
            None => Response {
                jsonrpc: "2.0".into(),
                id: req.id,
                result: None,
                error: Some(RpcError::method_not_found(&req.method)),
            },
            Some(h) => {
                let r = h(req.params, ctx).await;
                match r {
                    Ok(v) => Response {
                        jsonrpc: "2.0".into(),
                        id: req.id,
                        result: Some(v),
                        error: None,
                    },
                    Err(e) => Response {
                        jsonrpc: "2.0".into(),
                        id: req.id,
                        result: None,
                        error: Some(e),
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod router_tests {
    use super::*;
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn echo_router() -> Router {
        let mut r = Router::new();
        r.register("echo", |params, _ctx| async move { Ok(params.unwrap_or(Value::Null)) });
        r
    }

    #[tokio::test]
    async fn dispatch_calls_registered_handler() {
        let r = echo_router();
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "echo".into(),
            params: Some(json!("hi")),
        };
        let resp = r.dispatch(req, dummy_ctx()).await;
        assert_eq!(resp.result, Some(json!("hi")));
        assert!(resp.error.is_none());
    }

    #[tokio::test]
    async fn dispatch_unknown_method_returns_method_not_found() {
        let r = echo_router();
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(2),
            method: "nope".into(),
            params: None,
        };
        let resp = r.dispatch(req, dummy_ctx()).await;
        assert!(resp.result.is_none());
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32601);
    }
}
