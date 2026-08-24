//! The global notifier subscription, independent of any single session.

use crate::daemon::notifier::Notifier;
use crate::daemon::rpc::Router;

pub fn register_notifier(router: &mut Router, notifier: Notifier) {
    router.register("subscribe_global", move |_params, ctx| {
        let notifier = notifier.clone();
        async move {
            let mut rx = notifier.subscribe();
            let outbound = ctx.clone();
            let handle = tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(notif) => {
                            if outbound.send_outbound(notif).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    }
                }
            });
            let mut slot = ctx.global_sub.lock().await;
            if let Some(old) = slot.replace(handle.abort_handle()) {
                old.abort();
            }
            Ok(serde_json::json!({"ok": true}))
        }
    });
}
