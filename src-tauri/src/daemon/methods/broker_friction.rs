//! `broker_friction`: the broker's friction counter, read from `broker-audit.jsonl`
//! (`broker::friction`). Desktop pipe only: it is not in `remote_transport_table`, and the
//! counts name no path or token, but it is Joe's own measure and a phone has no use for it.
//!
//! Params: `{ "days": 1..=90 }` (optional, 14 by default). Result: `broker::friction::Report`.

use crate::daemon::broker::friction;
use crate::daemon::rpc::{Router, RpcError};
use serde_json::Value;

const DEFAULT_DAYS: usize = 14;

fn window_days(params: Option<&Value>) -> Result<usize, RpcError> {
    match params.and_then(|p| p.get("days")) {
        None | Some(Value::Null) => Ok(DEFAULT_DAYS),
        Some(v) => match v.as_u64() {
            Some(n) if (1..=friction::MAX_WINDOW_DAYS as u64).contains(&n) => Ok(n as usize),
            _ => Err(RpcError::invalid_params(format!("days must be a whole number from 1 to {}", friction::MAX_WINDOW_DAYS))),
        },
    }
}

pub fn register_broker_friction(router: &mut Router) {
    router.register("broker_friction", move |params, _ctx| async move {
        let days = window_days(params.as_ref())?;
        let path = crate::settings::paths::data_dir()
            .map_err(|e| RpcError::internal(format!("no data folder: {e}")))?
            .join(crate::daemon::broker::front::AUDIT_FILE);
        // The audit log can be long after a year of calls: read it off the async threads.
        let report = tokio::task::spawn_blocking(move || friction::report_now(&path, days))
            .await
            .map_err(|e| RpcError::internal(format!("friction read failed: {e}")))?
            .map_err(RpcError::internal)?;
        serde_json::to_value(report).map_err(|e| RpcError::internal(e.to_string()))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request, Transport};
    use serde_json::json;

    async fn dispatch(transport: Transport, params: Option<Value>) -> crate::daemon::rpc::Response {
        let mut router = Router::new();
        register_broker_friction(&mut router);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let mut ctx = ConnectionContext::new(tx);
        ctx.remote = matches!(transport, Transport::Phone);
        ctx.transport = transport;
        router.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: "broker_friction".into(), params }, ctx).await
    }

    fn result(resp: crate::daemon::rpc::Response) -> Value {
        serde_json::to_value(&resp).unwrap()["result"].clone()
    }

    #[test]
    fn days_defaults_and_rejects_anything_outside_the_window() {
        assert_eq!(window_days(None).unwrap(), DEFAULT_DAYS);
        assert_eq!(window_days(Some(&json!({}))).unwrap(), DEFAULT_DAYS);
        assert_eq!(window_days(Some(&json!({"days": 3}))).unwrap(), 3);
        for bad in [json!({"days": 0}), json!({"days": 91}), json!({"days": -1}), json!({"days": "7"}), json!({"days": 1.5})] {
            assert!(window_days(Some(&bad)).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn the_method_reads_the_private_data_dirs_audit_log() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let path = crate::settings::paths::data_dir().unwrap().join(crate::daemon::broker::front::AUDIT_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let ts = crate::util::time::now_rfc3339();
        let lines: Vec<String> = ["denied_policy", "denied_scope", "denied_owner", "ok"]
            .iter()
            .map(|o| json!({"ts": ts, "session": "s", "service": "figma", "method": "GET", "path": "/v1/me", "outcome": o}).to_string())
            .collect();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let r = result(dispatch(Transport::Local, Some(json!({"days": 2}))).await);
        assert_eq!((r["today_friction"].clone(), r["within_target"].clone(), r["target_per_day"].clone()), (json!(3), json!(false), json!(2)), "{r}");
        assert_eq!(r["days"].as_array().unwrap().len(), 2);
        assert_eq!(r["day_number"], json!(1));
        // The answer carries counts only: no path, no session.
        assert!(!r.to_string().contains("/v1/me"), "{r}");
    }

    #[tokio::test]
    async fn a_bad_days_argument_is_an_invalid_params_error_and_a_remote_transport_is_refused_by_the_table() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let resp = serde_json::to_value(dispatch(Transport::Local, Some(json!({"days": 0}))).await).unwrap();
        assert_eq!(resp["error"]["code"], json!(-32602), "{resp}");
        // The router itself has no transport check (the table runs before it): the table row is what keeps a phone out.
        assert!(!crate::daemon::remote_handlers::allowed("broker_friction", &Transport::Phone));
        assert!(!crate::daemon::remote_handlers::allowed("broker_friction", &Transport::PeerMachine("x".into())));
    }
}
