//! Settings snapshot fetch/replace, independent of any single session.

use crate::daemon::notifier::Notifier;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::settings_cache::SettingsCache;

pub fn register_settings(router: &mut Router, cache: SettingsCache, notifier: Notifier) {
    let cache_get = cache.clone();
    router.register("get_settings", move |_params, _ctx| {
        let cache = cache_get.clone();
        async move {
            let snap = cache.snapshot();
            serde_json::to_value(&snap).map_err(|e| RpcError::internal(e.to_string()))
        }
    });
    router.register("set_settings", move |params, _ctx| {
        let cache = cache.clone();
        let notifier = notifier.clone();
        async move {
            let v = params.unwrap_or(serde_json::Value::Null);
            let s: crate::types::Settings = serde_json::from_value(v)
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            // The app process owns settings.json, so this push is the ONLY way a
            // desktop-side character (re)assignment reaches a remote client -
            // the `settings-changed` Tauri event `persist` also fires is
            // in-process only. Diffed rather than published unconditionally:
            // the handshake and every unrelated settings save land here too.
            let changed = cache.snapshot().session_characters != s.session_characters;
            cache.replace(s);
            if changed {
                notifier.publish("session_characters_changed", serde_json::json!({}));
            }
            Ok(serde_json::json!({"ok": true}))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::types::Settings;
    use serde_json::json;

    fn ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    async fn push(router: &Router, s: &Settings) {
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "set_settings".into(),
                    params: Some(serde_json::to_value(s).unwrap()),
                },
                ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "set_settings failed: {:?}", resp.error);
    }

    /// The desktop app's character (re)assignment reaches a remote client ONLY
    /// through this push, so the event has to fire on a real change...
    #[tokio::test]
    async fn set_settings_publishes_when_session_characters_change() {
        let notifier = Notifier::new();
        let mut rx = notifier.subscribe();
        let mut router = Router::new();
        register_settings(
            &mut router,
            SettingsCache::new(Settings::default()),
            notifier.clone(),
        );

        let mut changed = Settings::default();
        changed
            .session_characters
            .insert("sess-1".into(), "jaina".into());
        push(&router, &changed).await;

        let frame = rx.try_recv().expect("expected a published frame");
        assert_eq!(frame["method"], "session_characters_changed");
    }

    /// ...and NOT on the handshake push or any unrelated settings save, both of
    /// which land on this same method with the map untouched.
    #[tokio::test]
    async fn set_settings_stays_quiet_when_the_map_is_unchanged() {
        let notifier = Notifier::new();
        let mut rx = notifier.subscribe();
        let mut router = Router::new();
        let mut seeded = Settings::default();
        seeded
            .session_characters
            .insert("sess-1".into(), "jaina".into());
        register_settings(
            &mut router,
            SettingsCache::new(seeded.clone()),
            notifier.clone(),
        );

        let mut other_field_changed = seeded.clone();
        other_field_changed.jarvis_session_id = Some("sess-9".into());
        push(&router, &other_field_changed).await;

        assert!(rx.try_recv().is_err(), "unrelated save must not publish");
    }
}
