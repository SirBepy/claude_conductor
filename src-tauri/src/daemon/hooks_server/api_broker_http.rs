//! `/hooks/api-broker-http`: the broker for scripts and hooks (`scripts/cc-api/cc_api.py`,
//! `cc_api.mjs`), step 6. It runs the same engine path as the MCP tools (`broker::front`) but
//! identifies the caller differently: the MCP child is a channel of one chat, a script is any
//! process, so this route trusts nothing but the chat's own `CC_BROKER_TOKEN` in
//! `Authorization: Bearer`. The session, the role and the bound services come out of that token
//! (`BrokerSessions::verify`); a `session_id` in the body is ignored.
//!
//! What is rejected with a 401 and no engine work: no header, a malformed value, another
//! daemon's token, another session's edited token, a revoked token, and the daemon's own
//! `remote-access-token.txt` (it is not one of ours). Everything after that is a 200 with
//! `ok`, like the MCP route: a refusal names the line to add and is expected control flow.
//!
//! Reachability: this is the loopback hooks server (`origin_guard`: a `Host` of 127.0.0.1 or
//! localhost and no `Origin`). The remote server, which a phone or a paired machine reaches,
//! mounts no `/hooks` route and `TRANSPORT_TABLE` has no broker row, so neither can call it.
//! The body limit is the router default; `out_file` writes go through `broker::out_file`.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::broker::front;
use crate::daemon::broker::out_file::OutTarget;
use axum::http::{header, HeaderMap, StatusCode};
use axum::{extract::State as AxState, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

fn reply(status: StatusCode, error: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"ok": false, "error": error})))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim()).filter(|t| !t.is_empty())
}

pub(super) async fn on_api_broker_http(AxState(ctx): AxState<Arc<HookCtx>>, headers: HeaderMap, ValidatedJson(args): ValidatedJson<Value>) -> impl IntoResponse {
    let claims = match bearer(&headers).ok_or(crate::daemon::broker::session::TokenError::Malformed).and_then(|t| ctx.state.broker_sessions.verify(t)) {
        Ok(c) => c,
        Err(e) => return reply(StatusCode::UNAUTHORIZED, e.message()),
    };
    let engine = match ctx.state.broker_engine() {
        Ok(e) => e,
        Err(e) => return reply(StatusCode::OK, &format!("the broker is unavailable: {e}")),
    };
    let requested = match args.get("out_file") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.as_str()),
        Some(_) => return reply(StatusCode::OK, "out_file must be a non-empty string"),
    };
    let target = requested.map(|_| {
        // The chat's own folder (its worktree for a sub) and the temp dir are the only roots; the
        // daemon's data folder is refused even if a root contains it.
        let folder = ctx.state.registry.get(&claims.session_id).map(|row| row.cwd);
        let deny: Vec<PathBuf> = crate::settings::paths::data_dir().into_iter().collect();
        OutTarget::new(folder.as_deref(), deny)
    });
    let out = target.as_ref().zip(requested);
    (StatusCode::OK, Json(front::run_script(engine, &claims, &args, out).await))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The phone and a paired machine reach the remote server only. If it ever mounted a
    /// `/hooks` route, or named this one, a remote caller could post with a token it lifted.
    #[test]
    fn the_remote_server_mounts_no_hooks_route_and_never_names_this_one() {
        for (name, src) in [
            ("remote_server.rs", include_str!("../remote_server.rs")),
            ("remote_handlers.rs", include_str!("../remote_handlers.rs")),
            ("remote_static.rs", include_str!("../remote_static.rs")),
            ("remote_ws_pump.rs", include_str!("../remote_ws_pump.rs")),
        ] {
            assert!(!src.contains("\"/hooks") && !src.contains("api-broker") && !src.contains("api_broker"), "{name} reaches the broker's loopback route");
        }
    }
    use crate::daemon::broker::front::testing::engine_against;
    use crate::daemon::broker::services::Service;
    use crate::daemon::broker::session::{Role, SessionClaims};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use axum::http::HeaderValue;
    use std::fs;
    use std::path::Path;

    const FIG: &str = "CANARY-FIG-http-1";
    const TRELLO_KEY: &str = "CANARY-TK-http-2";
    const TRELLO_TOKEN: &str = "CANARY-TT-http-3";

    struct Rig {
        ctx: Arc<HookCtx>,
        server: mockito::ServerGuard,
        project: tempfile::TempDir,
        /// The daemon's data folder: the one `data_dir()` resolves to, which the route refuses as a destination.
        data: PathBuf,
        _env: crate::daemon::subchats::TempDataDir,
    }

    async fn rig() -> Rig {
        let env = crate::daemon::subchats::TempDataDir::new();
        let server = mockito::Server::new_async().await;
        let project = tempfile::tempdir().unwrap();
        let data = crate::settings::paths::data_dir().unwrap();
        let ctx = Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) });
        let secrets = [("FIGMA_TOKEN", FIG), ("TRELLO_API_KEY", TRELLO_KEY), ("TRELLO_TOKEN", TRELLO_TOKEN), ("SHORTCUT_API_TOKEN", "CANARY-SC-http-4")];
        ctx.state.install_broker_engine(Arc::new(engine_against(&server.url(), &data, &secrets)));
        ctx.state.registry.upsert_interactive("chat-a", project.path(), "p1", "2026-11-18T00:00:00Z");
        Rig { ctx, server, project, data, _env: env }
    }

    impl Rig {
        fn token(&self, session: &str, services: Vec<Service>) -> String {
            self.ctx.state.broker_sessions.mint(SessionClaims::new(session, Role::Chat, services)).expose().to_string()
        }

        async fn post(&self, auth: Option<&str>, body: Value) -> (StatusCode, Value) {
            let mut h = HeaderMap::new();
            if let Some(a) = auth {
                h.insert(header::AUTHORIZATION, HeaderValue::from_str(a).unwrap());
            }
            let resp = on_api_broker_http(AxState(self.ctx.clone()), h, ValidatedJson(body)).await.into_response();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap())
        }

        async fn call(&self, token: &str, body: Value) -> Value {
            let (status, v) = self.post(Some(&format!("Bearer {token}")), body).await;
            assert_eq!(status, StatusCode::OK, "{v}");
            v
        }

        fn audit(&self) -> Vec<Value> {
            let text = fs::read_to_string(self.data.join("broker-audit.jsonl")).unwrap_or_default();
            text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
        }
    }

    #[tokio::test]
    async fn only_a_session_token_gets_in_and_a_rejected_call_reaches_nothing() {
        let mut r = rig().await;
        let none = r.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
        let mine = r.token("chat-a", vec![Service::Figma]);
        let body = json!({"service": "figma", "path": "/v1/me"});
        let e401 = |(s, v): (StatusCode, Value)| {
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{v}");
            assert_eq!(v["ok"], json!(false));
            assert!(!v.to_string().contains("CANARY"), "{v}");
        };
        // No header, a wrong scheme, an empty bearer, garbage.
        e401(r.post(None, body.clone()).await);
        e401(r.post(Some(&format!("Basic {mine}")), body.clone()).await);
        e401(r.post(Some("Bearer "), body.clone()).await);
        e401(r.post(Some("Bearer not-a-token"), body.clone()).await);
        // The daemon's token file alone (its contents are not one of ours), and the session id alone.
        e401(r.post(Some("Bearer DAEMON-TOKEN-FILE-CANARY-0123456789abcdef"), body.clone()).await);
        e401(r.post(Some("Bearer chat-a"), body.clone()).await);
        // A body session_id with no token is no credential.
        e401(r.post(None, json!({"service": "figma", "path": "/v1/me", "session_id": "chat-a"})).await);
        // A tampered token: the mac of another token spliced on.
        let other = r.token("chat-b", vec![Service::Figma]);
        let spliced = format!("{}.{}", mine.rsplit_once('.').unwrap().0, other.rsplit_once('.').unwrap().1);
        e401(r.post(Some(&format!("Bearer {spliced}")), body.clone()).await);
        // A revoked token.
        r.ctx.state.broker_sessions.revoke("chat-b");
        e401(r.post(Some(&format!("Bearer {other}")), body.clone()).await);
        none.assert_async().await;
        assert!(r.audit().is_empty(), "a rejected token makes no engine call, so no audit line");
    }

    #[tokio::test]
    async fn a_valid_token_runs_the_engine_as_its_own_session_whatever_the_body_says() {
        let mut r = rig().await;
        let ok = r.server.mock("GET", "/v1/me").match_header("x-figma-token", FIG).with_status(200).with_body(r#"{"id":"u1"}"#).create_async().await;
        let t = r.token("chat-a", vec![Service::Figma]);
        let v = r.call(&t, json!({"service": "figma", "path": "/v1/me", "session_id": "someone-else"})).await;
        assert_eq!((v["ok"].clone(), v["status"].clone(), v["body"].clone()), (json!(true), json!(200), json!(r#"{"id":"u1"}"#)), "{v}");
        ok.assert_async().await;
        let a = r.audit();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["session"], json!("chat-a"), "the audit names the token's session, not the body's");
        assert_eq!(a[0]["unmasked"], json!(false));
        // A service the token is not bound to is refused with the binding line, and nothing is sent.
        let none = r.server.mock("GET", mockito::Matcher::Regex("^/api/v3".into())).expect(0).create_async().await;
        let v = r.call(&t, json!({"service": "shortcut", "path": "/api/v3/member"})).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("service_not_bound"), "{v}");
        none.assert_async().await;
    }

    #[tokio::test]
    async fn a_text_out_file_holds_the_masked_body_and_the_answer_carries_no_body() {
        let mut r = rig().await;
        let echo = format!("{{\"echo\":\"{FIG}\",\"n\":1}}");
        r.server.mock("GET", "/v1/files/f1").with_status(200).with_body(echo).create_async().await;
        let t = r.token("chat-a", vec![Service::Figma]);
        let v = r.call(&t, json!({"service": "figma", "path": "/v1/files/f1", "out_file": "figma.json"})).await;
        assert_eq!(v["ok"], json!(true), "{v}");
        assert!(v.get("body").is_none() && v.get("unmasked").is_none(), "{v}");
        let text = fs::read_to_string(r.project.path().join("figma.json")).unwrap();
        assert!(text.contains("[MASKED]") && !text.contains(FIG), "{text}");
        assert_eq!(v["bytes"], json!(text.len()));
        assert!(!v.to_string().contains(FIG));
        assert_eq!(r.audit()[0]["unmasked"], json!(false), "a text out_file is masked, so it is not marked unmasked");
        // The temp dir is the other root.
        let tmp = tempfile::tempdir().unwrap();
        let abs = tmp.path().join("again.json");
        let v = r.call(&t, json!({"service": "figma", "path": "/v1/files/f1", "out_file": abs.to_str().unwrap()})).await;
        assert_eq!(v["ok"], json!(true), "{v}");
        assert!(!fs::read_to_string(&abs).unwrap().contains(FIG));
    }

    #[tokio::test]
    async fn an_out_file_outside_the_roots_is_refused_before_any_call_goes_out() {
        let mut r = rig().await;
        let none = r.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
        let t = r.token("chat-a", vec![Service::Figma]);
        let outside = if cfg!(windows) { r"C:\Windows\System32\cc-api-test.txt" } else { "/etc/cc-api-test.txt" };
        let policy_in_data = r.data.join("broker-policy.json");
        // The folder exists, so the refusal is the `.git` rule and not a missing parent.
        fs::create_dir(r.project.path().join(".git")).unwrap();
        for bad in ["../x.txt", "a/../../x.txt", outside, ".git/config", ".env", policy_in_data.to_str().unwrap()] {
            let v = r.call(&t, json!({"service": "figma", "path": "/v1/me", "out_file": bad})).await;
            assert_eq!(v["ok"], json!(false), "{bad}: {v}");
        }
        for odd in [json!(5), json!(["x"]), json!("")] {
            let v = r.call(&t, json!({"service": "figma", "path": "/v1/me", "out_file": odd})).await;
            assert!(v["error"].as_str().unwrap().contains("non-empty string"), "{odd}: {v}");
        }
        none.assert_async().await;
        assert!(!Path::new(outside).exists() && !policy_in_data.exists());
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn an_out_file_through_a_folder_link_that_points_out_is_refused() {
        let mut r = rig().await;
        let none = r.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
        let t = r.token("chat-a", vec![Service::Figma]);
        let outside = if cfg!(windows) { PathBuf::from(r"C:\Windows\Fonts") } else { PathBuf::from("/usr") };
        let link = r.project.path().join("escape");
        #[cfg(windows)]
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside).output().map(|o| o.status.success()).unwrap_or(false);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        assert!(made, "the test needs to create a folder link");
        let v = r.call(&t, json!({"service": "figma", "path": "/v1/me", "out_file": "escape/pwn.txt"})).await;
        assert_eq!(v["ok"], json!(false), "{v}");
        none.assert_async().await;
        assert!(!outside.join("pwn.txt").exists());
    }

    #[tokio::test]
    async fn a_binary_download_is_written_raw_for_a_named_path_and_the_audit_says_unmasked() {
        let mut r = rig().await;
        // Not valid UTF-8, and it holds the Trello token's text so the file proves nothing was masked or decoded.
        let mut bytes = vec![0xff, 0xfe, 0x00, 0x89, b'P', b'N', b'G'];
        bytes.extend_from_slice(TRELLO_TOKEN.as_bytes());
        bytes.push(0x80);
        let m = r.server.mock("GET", mockito::Matcher::Regex("^/1/cards/c1/attachments/a1/download/shot.png".into())).with_status(200).with_header("content-type", "image/png").with_body(bytes.clone()).create_async().await;
        let t = r.token("chat-a", vec![Service::Trello]);
        let v = r.call(&t, json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/shot.png", "download": true, "out_file": "shot.png"})).await;
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!((v["unmasked"].clone(), v["bytes"].clone()), (json!(true), json!(bytes.len())), "{v}");
        assert_eq!(fs::read(r.project.path().join("shot.png")).unwrap(), bytes);
        assert!(!v.to_string().contains(TRELLO_TOKEN));
        m.assert_async().await;
        let a = r.audit();
        assert_eq!(a.len(), 1);
        assert_eq!((a[0]["unmasked"].clone(), a[0]["method"].clone(), a[0]["outcome"].clone()), (json!(true), json!("GET"), json!("ok")), "{}", a[0]);
    }

    #[tokio::test]
    async fn a_binary_download_is_refused_off_the_named_paths_for_any_other_method_and_without_a_file() {
        let mut r = rig().await;
        let none = r.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
        let none_post = r.server.mock("POST", mockito::Matcher::Any).expect(0).create_async().await;
        let t = r.token("chat-a", vec![Service::Trello, Service::Figma]);
        let cases = [
            // A GET that is not a named download path.
            json!({"service": "trello", "path": "/1/cards/c1", "download": true, "out_file": "a.bin"}),
            json!({"service": "figma", "path": "/v1/files/f1", "download": true, "out_file": "a.bin"}),
            // A near miss of the named shape: an empty segment, an extra one, the wrong word.
            json!({"service": "trello", "path": "/1/cards//attachments/a1/download/x.png", "download": true, "out_file": "a.bin"}),
            json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/x/y", "download": true, "out_file": "a.bin"}),
            json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/downloads/x.png", "download": true, "out_file": "a.bin"}),
            // The named path with a method that writes.
            json!({"service": "trello", "method": "POST", "path": "/1/cards/c1/attachments/a1/download/x.png", "download": true, "out_file": "a.bin"}),
            json!({"service": "trello", "method": "DELETE", "path": "/1/cards/c1/attachments/a1/download/x.png", "download": true, "out_file": "a.bin"}),
        ];
        for c in cases {
            let v = r.call(&t, c.clone()).await;
            assert_eq!(v["ok"], json!(false), "{c}: {v}");
            // The engine's own guard answers, ahead of any policy row.
            assert!(v["error"].as_str().unwrap().contains("not_a_download_path"), "{c}: {v}");
        }
        // download with no out_file, and a download that is not a boolean.
        let v = r.call(&t, json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/x.png", "download": true})).await;
        assert!(v["error"].as_str().unwrap().contains("needs an out_file"), "{v}");
        let v = r.call(&t, json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/x.png", "download": "yes", "out_file": "a.bin"})).await;
        assert!(v["error"].as_str().unwrap().contains("true or false"), "{v}");
        none.assert_async().await;
        none_post.assert_async().await;
        assert!(!r.project.path().join("a.bin").exists());
        let a = r.audit();
        assert!(a.iter().all(|l| l["unmasked"] == json!(false)), "a refused download is never marked unmasked");
        assert!(a.iter().any(|l| l["outcome"] == json!("denied_guard")));
    }

    #[tokio::test]
    async fn a_download_that_answers_with_an_error_is_masked_text_and_writes_no_file() {
        let mut r = rig().await;
        r.server.mock("GET", mockito::Matcher::Regex("^/1/cards/c1/attachments/a1/download/".into())).with_status(404).with_body(format!("no such file for {TRELLO_TOKEN}")).create_async().await;
        let t = r.token("chat-a", vec![Service::Trello]);
        let v = r.call(&t, json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/x.png", "download": true, "out_file": "x.png"})).await;
        assert_eq!((v["ok"].clone(), v["status"].clone()), (json!(false), json!(404)), "{v}");
        assert!(v["error"].as_str().unwrap().contains("[MASKED]") && !v.to_string().contains(TRELLO_TOKEN), "{v}");
        assert!(!r.project.path().join("x.png").exists());
        assert_eq!(r.audit()[0]["unmasked"], json!(false), "the error body was masked");
    }

    #[tokio::test]
    async fn a_redirect_answer_writes_no_file_and_is_not_ok_for_a_download_or_a_text_call() {
        let mut r = rig().await;
        let signed = "https://files.example.test/signed?sig=abc";
        r.server.mock("GET", mockito::Matcher::Regex("^/1/cards/c1/attachments/a1/download/".into())).with_status(302).with_header("location", signed).create_async().await;
        r.server.mock("GET", "/v1/files/moved").with_status(304).create_async().await;
        let t = r.token("chat-a", vec![Service::Trello, Service::Figma]);
        let dl = r.call(&t, json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/x.png", "download": true, "out_file": "x.png"})).await;
        let txt = r.call(&t, json!({"service": "figma", "path": "/v1/files/moved", "out_file": "moved.json"})).await;
        for (name, v, status, why) in [("download", dl, 302, "redirects are not followed"), ("text", txt, 304, "is not a 2xx")] {
            assert_eq!((v["ok"].clone(), v["status"].clone()), (json!(false), json!(status)), "{name}: {v}");
            let e = v["error"].as_str().unwrap();
            assert!(e.contains(why) && !e.contains("signed") && !e.contains("may have been applied"), "{name}: {v}");
        }
        assert!(!r.project.path().join("x.png").exists() && !r.project.path().join("moved.json").exists());
        // A write answered with a redirect usually happened: the retry warning rides along.
        r.server.mock("POST", "/api/v3/stories").with_status(303).with_header("location", signed).create_async().await;
        let t2 = r.token("chat-a", vec![Service::Shortcut]);
        let v = r.call(&t2, json!({"service": "shortcut", "method": "POST", "path": "/api/v3/stories", "body": {"name": "x"}, "out_file": "made.json"})).await;
        assert_eq!(v["ok"], json!(false), "{v}");
        let e = v["error"].as_str().unwrap();
        assert!(e.contains("may have been applied") && !e.contains("signed"), "{v}");
        assert!(!r.project.path().join("made.json").exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_windows_short_name_for_a_refused_name_is_refused_before_any_call() {
        let mut r = rig().await;
        let none = r.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
        let t = r.token("chat-a", vec![Service::Figma]);
        for bad in ["ENV~1", "GIT~1", "CLAUDE~1"] {
            let v = r.call(&t, json!({"service": "figma", "path": "/v1/me", "out_file": bad})).await;
            assert_eq!(v["ok"], json!(false), "{bad}: {v}");
        }
        none.assert_async().await;
    }

    #[tokio::test]
    async fn an_upstream_error_with_a_text_out_file_writes_nothing() {
        let mut r = rig().await;
        r.server.mock("GET", "/v1/files/missing").with_status(404).with_body(format!("not found {FIG}")).create_async().await;
        let t = r.token("chat-a", vec![Service::Figma]);
        let v = r.call(&t, json!({"service": "figma", "path": "/v1/files/missing", "out_file": "f.json"})).await;
        assert_eq!((v["ok"].clone(), v["status"].clone()), (json!(false), json!(404)), "{v}");
        assert!(!v.to_string().contains(FIG));
        assert!(!r.project.path().join("f.json").exists());
    }
}
