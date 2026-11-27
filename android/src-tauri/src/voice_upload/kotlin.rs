//! Android-only: the `Source` backed by `VoiceUploadPlugin.kt` through Tauri's
//! mobile-plugin bridge, and the plugin that starts the upload loop. Not
//! compilable or testable on the host; the logic it calls is in `engine`/`wire`.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

use super::engine::{Auth, BoxFut, Job, Mark, Rpc, Source, Uploader};
use super::tunnel_rpc::{Lookup, TunnelRpc};
use super::wire::{mark_payload, parse_auth, parse_claim};
use crate::iroh_tunnel::IrohTunnelState;

/// Must match `VoiceUploadPlugin`'s package and class in the Kotlin sources.
const PLUGIN_PACKAGE: &str = "com.sirbepy.conductor.mobile";
const PLUGIN_CLASS: &str = "VoiceUploadPlugin";

struct KotlinSource {
    handle: PluginHandle<Wry>,
}

impl KotlinSource {
    async fn ask(&self, command: &str, payload: Value) -> Result<Value, String> {
        self.handle.run_mobile_plugin_async::<Value>(command, payload).await.map_err(|e| e.to_string())
    }
}

impl Source for KotlinSource {
    fn claim(&self) -> BoxFut<'_, Result<Vec<Job>, String>> {
        Box::pin(async move { Ok(parse_claim(&self.ask("voiceClaim", json!({})).await?)) })
    }

    fn mark(&self, id: &str, mark: Mark) -> BoxFut<'_, Result<(), String>> {
        let payload = mark_payload(id, &mark);
        Box::pin(async move { self.ask("voiceMark", payload).await.map(|_| ()) })
    }

    fn auth(&self) -> BoxFut<'_, Result<Option<Auth>, String>> {
        Box::pin(async move { Ok(parse_auth(&self.ask("voiceAuth", json!({})).await?)) })
    }
}

pub(super) fn plugin() -> TauriPlugin<Wry> {
    Builder::new("voice-upload")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            let source: Arc<dyn Source> = Arc::new(KotlinSource { handle });
            let app = app.clone();
            // Read at call time: the tunnel state is managed by the app builder
            // and a tunnel exists only once the shell has dialed a PC.
            let lookup: Lookup = Arc::new(move || {
                let app = app.clone();
                Box::pin(async move {
                    let state = app.try_state::<IrohTunnelState>()?;
                    state.live_tunnel().await
                })
            });
            let rpc: Arc<dyn Rpc> = Arc::new(TunnelRpc::new(lookup, source.clone()));
            tauri::async_runtime::spawn(super::run_forever(Uploader::new(source, rpc)));
            Ok(())
        })
        .build()
}
