//! Executes one card's source (an HTTP request or a local command) and turns
//! the response into a `CardResult`. Never returns an error: every failure
//! lands in `CardResult.error`, already scrubbed of resolved secret values.

use super::card_extras::apply_card_extras;
use super::extract::apply_display;
use super::template::{redact, render_collect, SecretLookup, TemplateCtx};
use super::types::{CardConfig, CardResult, CardSource};
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// Cap on a response body / command stdout, so a card pointed at the wrong
/// endpoint cannot balloon daemon memory.
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// How much of a failing response body or stderr is echoed into the error.
const ERROR_SNIPPET_CHARS: usize = 200;

pub async fn run_card(card: &CardConfig, ctx: &TemplateCtx, secrets: SecretLookup<'_>) -> CardResult {
    run_card_with(card, ctx, secrets, HTTP_TIMEOUT, COMMAND_TIMEOUT).await
}

async fn run_card_with(
    card: &CardConfig,
    ctx: &TemplateCtx,
    secrets: SecretLookup<'_>,
    http_timeout: Duration,
    command_timeout: Duration,
) -> CardResult {
    let mut used = Vec::new();
    let fetched = match &card.source {
        CardSource::Http { .. } => match build_http(&card.source, ctx, secrets, &mut used) {
            Ok(plan) => fetch_http(plan, http_timeout, &used).await,
            Err(e) => Err(e),
        },
        CardSource::Command { .. } => match build_command(&card.source, ctx, secrets, &mut used) {
            Ok(plan) => run_command(plan, command_timeout, &used).await,
            Err(e) => Err(e),
        },
    };
    let fetched_at_ms = chrono::Utc::now().timestamp_millis();
    match fetched {
        Ok(mut json) => {
            // A source can echo a secret it was given (an env var a script
            // prints, an API that reflects a header), so every string is
            // scrubbed before anything reaches the cache, the dashboard or a
            // chat's `test` call.
            redact_value(&mut json, &used);
            let (stats, rows) = apply_display(&json, &card.display);
            let mut result = CardResult { fetched_at_ms, stats, rows, ..Default::default() };
            apply_card_extras(&json, &mut result);
            result
        }
        Err(e) => CardResult { fetched_at_ms, error: Some(redact(&e, &used)), ..Default::default() },
    }
}

fn redact_value(v: &mut Value, used: &[String]) {
    if used.iter().all(|s| s.is_empty()) {
        return;
    }
    match v {
        Value::String(s) => *s = redact(s, used),
        Value::Array(items) => items.iter_mut().for_each(|i| redact_value(i, used)),
        Value::Object(map) => map.values_mut().for_each(|i| redact_value(i, used)),
        _ => {}
    }
}

#[derive(Debug, PartialEq)]
struct HttpPlan {
    method: String,
    url: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, PartialEq)]
struct CommandPlan {
    program: String,
    args: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
}

fn build_http(
    source: &CardSource,
    ctx: &TemplateCtx,
    secrets: SecretLookup,
    used: &mut Vec<String>,
) -> Result<HttpPlan, String> {
    let CardSource::Http { method, url, headers, body } = source else {
        return Err("not an http source".to_string());
    };
    let url = render_collect(url, ctx, secrets, used)?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url must start with http:// or https://".to_string());
    }
    let mut rendered = BTreeMap::new();
    for (name, value) in headers {
        rendered.insert(name.clone(), render_collect(value, ctx, secrets, used)?);
    }
    let body = body.as_ref().map(|b| render_collect(b, ctx, secrets, used)).transpose()?;
    let method = if method.trim().is_empty() { "GET".to_string() } else { method.trim().to_ascii_uppercase() };
    Ok(HttpPlan { method, url, headers: rendered, body })
}

fn build_command(
    source: &CardSource,
    ctx: &TemplateCtx,
    secrets: SecretLookup,
    used: &mut Vec<String>,
) -> Result<CommandPlan, String> {
    let CardSource::Command { program, args, cwd, env } = source else {
        return Err("not a command source".to_string());
    };
    if program.trim().is_empty() {
        return Err("command has no program".to_string());
    }
    let args = args.iter().map(|a| render_collect(a, ctx, secrets, used)).collect::<Result<Vec<_>, _>>()?;
    let cwd = match cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(c) => render_collect(c, ctx, secrets, used)?,
        None => ctx.cwd.clone(),
    };
    let mut rendered_env = BTreeMap::new();
    for (name, value) in env {
        rendered_env.insert(name.clone(), render_collect(value, ctx, secrets, used)?);
    }
    // The program is deliberately not templated: a placeholder there would let
    // a secret or a repo name pick which binary runs.
    Ok(CommandPlan { program: program.trim().to_string(), args, cwd, env: rendered_env })
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    static DEFAULT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    if timeout == HTTP_TIMEOUT {
        return DEFAULT.get_or_init(|| build_client(HTTP_TIMEOUT)).clone();
    }
    build_client(timeout)
}

fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        // A redirect would replay custom token headers (`X-Api-Key`, ...) to
        // wherever it points; reqwest only strips Authorization/Cookie.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))
}

async fn fetch_http(plan: HttpPlan, timeout: Duration, used: &[String]) -> Result<Value, String> {
    let method = reqwest::Method::from_bytes(plan.method.as_bytes()).map_err(|_| format!("bad http method {:?}", plan.method))?;
    let mut req = http_client(timeout)?.request(method, &plan.url);
    for (name, value) in &plan.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    if let Some(body) = plan.body {
        req = req.body(body);
    }
    // `without_url`: reqwest's Display embeds the full URL, which carries
    // query-string secrets.
    let mut resp = req.send().await.map_err(|e| describe_reqwest(e.without_url()))?;
    let status = resp.status();
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| describe_reqwest(e.without_url()))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_OUTPUT_BYTES {
            return Err("response is larger than 1 MB".to_string());
        }
    }
    if !status.is_success() {
        let snippet = snippet(&String::from_utf8_lossy(&body), used);
        return Err(if snippet.is_empty() { format!("HTTP {status}") } else { format!("HTTP {status}: {snippet}") });
    }
    Ok(parse_output(&body))
}

fn describe_reqwest(e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("request timed out after {}s", HTTP_TIMEOUT.as_secs())
    } else if e.is_connect() {
        format!("could not connect: {e}")
    } else {
        format!("request failed: {e}")
    }
}

fn snippet(text: &str, used: &[String]) -> String {
    let redacted = redact(text.trim(), used);
    let mut s: String = redacted.chars().take(ERROR_SNIPPET_CHARS).collect();
    if redacted.chars().count() > ERROR_SNIPPET_CHARS {
        s.push_str("...");
    }
    s.replace(['\r', '\n'], " ")
}

/// JSON when it parses, else `{"text": "...", "lines": [...]}` so a plain-text
/// command still drives a card.
fn parse_output(bytes: &[u8]) -> Value {
    if let Ok(v) = serde_json::from_slice::<Value>(bytes) {
        return v;
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end();
    serde_json::json!({
        "text": text,
        "lines": text.lines().map(|l| l.trim_end_matches('\r')).collect::<Vec<_>>(),
    })
}

/// A bare program name resolved on PATH the way a shell would, PATHEXT
/// included, so `pnpm` finds `pnpm.cmd`; std only tries `.exe`. A `.cmd` path
/// then runs through std's batch-file launcher, which escapes the args for
/// cmd.exe and refuses one it cannot escape safely. A name with a path in it,
/// or one PATH does not hold, is passed through unchanged.
fn resolve_program(program: &str) -> std::path::PathBuf {
    resolve_program_in(program, std::env::var_os("PATH"))
}

fn resolve_program_in(program: &str, path: Option<std::ffi::OsString>) -> std::path::PathBuf {
    let bare = !program.contains(['/', '\\']);
    let cwd = std::env::current_dir().unwrap_or_default();
    match bare.then(|| which::which_in(program, path, cwd).ok()).flatten() {
        Some(found) => found,
        None => program.into(),
    }
}

async fn run_command(plan: CommandPlan, timeout: Duration, used: &[String]) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(resolve_program(&plan.program));
    cmd.args(&plan.args)
        .envs(&plan.env)
        .current_dir(&plan.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::util::process::hide_console_tokio(&mut cmd);

    let run = async {
        let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", plan.program))?;
        crate::util::process::guard_orphan_tree(&child);
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;
        // Read one byte past the cap to tell "exactly full" from "overflowed".
        // stderr is kept up to the same cap and the rest is drained to nowhere,
        // concurrently: a reader that stopped at the cap would leave a chatty
        // child blocked on a full pipe, and the run would end as a timeout
        // instead of its real error.
        let read_out = async {
            let mut buf = Vec::new();
            (&mut stdout).take(MAX_OUTPUT_BYTES as u64 + 1).read_to_end(&mut buf).await.map(|_| buf)
        };
        let read_err = async {
            let mut buf = Vec::new();
            (&mut stderr).take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut buf).await?;
            tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await?;
            Ok::<_, std::io::Error>(buf)
        };
        let (out, err) = tokio::join!(read_out, read_err);
        let out = out.map_err(|e| format!("reading output: {e}"))?;
        if out.len() > MAX_OUTPUT_BYTES {
            // Dropping the pipes below would leave the child blocked; kill it.
            let _ = child.kill().await;
            return Err("output is larger than 1 MB".to_string());
        }
        let status = child.wait().await.map_err(|e| format!("waiting for {}: {e}", plan.program))?;
        if !status.success() {
            let err_text = snippet(&String::from_utf8_lossy(&err.unwrap_or_default()), used);
            let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string());
            return Err(if err_text.is_empty() {
                format!("{} exited with code {code}", plan.program)
            } else {
                format!("{} exited with code {code}: {err_text}", plan.program)
            });
        }
        Ok(parse_output(&out))
    };
    // On timeout the future is dropped, and `kill_on_drop` ends the child.
    match tokio::time::timeout(timeout, run).await {
        Ok(r) => r,
        Err(_) => Err(format!("command timed out after {}s", timeout.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dashboard::types::{CardDisplay, Scope, StatSpec};
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::{get, post},
        Router,
    };
    use std::sync::{Arc, Mutex};

    fn ctx() -> TemplateCtx {
        TemplateCtx::for_cwd(&std::env::temp_dir().to_string_lossy())
    }

    fn secrets(name: &str) -> Option<String> {
        (name == "API_KEY").then(|| "sk-dummy-key-123".to_string())
    }

    fn stat_display(path: &str, format: &str) -> CardDisplay {
        CardDisplay::Stats { items: vec![StatSpec { label: "v".into(), path: path.into(), format: format.into() }] }
    }

    fn http_card(url: &str, display: CardDisplay) -> CardConfig {
        let mut headers = BTreeMap::new();
        headers.insert("X-Api-Key".to_string(), "{{secret:API_KEY}}".to_string());
        CardConfig {
            id: "c".into(),
            scope: Scope::default(),
            title: "t".into(),
            enabled: true,
            source: CardSource::Http { method: "get".into(), url: url.into(), headers, body: None },
            display,
            refresh_secs: None,
            action: None,
        }
    }

    fn command_card(program: &str, args: &[&str], display: CardDisplay) -> CardConfig {
        CardConfig {
            source: CardSource::Command {
                program: program.into(),
                args: args.iter().map(|s| s.to_string()).collect(),
                cwd: None,
                env: BTreeMap::new(),
            },
            display,
            ..Default::default()
        }
    }

    fn shell(script: &str) -> (String, Vec<String>) {
        #[cfg(windows)]
        {
            ("powershell".into(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script.into()])
        }
        #[cfg(not(windows))]
        {
            ("sh".into(), vec!["-c".into(), script.into()])
        }
    }

    fn shell_card(script: &str, display: CardDisplay) -> CardConfig {
        let (program, args) = shell(script);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        command_card(&program, &refs, display)
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn http_plan_renders_templates_and_defaults_the_method() {
        let mut headers = BTreeMap::new();
        headers.insert("Authorization".to_string(), "Bearer {{secret:API_KEY}}".to_string());
        let src = CardSource::Http {
            method: "".into(),
            url: "https://api.example.com/{{repo}}?since={{week_start}}".into(),
            headers,
            body: Some("{\"day\":\"{{today}}\"}".into()),
        };
        let c = TemplateCtx::at("C:/w/zng-app", chrono::Local::now());
        let mut used = Vec::new();
        let plan = build_http(&src, &c, &secrets, &mut used).unwrap();
        assert_eq!(plan.method, "GET");
        assert_eq!(plan.url, format!("https://api.example.com/zng-app?since={}", c.week_start));
        assert_eq!(plan.headers["Authorization"], "Bearer sk-dummy-key-123");
        assert_eq!(plan.body.unwrap(), format!("{{\"day\":\"{}\"}}", c.today));
        assert_eq!(used, vec!["sk-dummy-key-123"]);
    }

    #[test]
    fn http_plan_rejects_non_http_urls_and_missing_secrets() {
        let src = |url: &str| CardSource::Http { method: "GET".into(), url: url.into(), headers: Default::default(), body: None };
        let mut used = Vec::new();
        assert!(build_http(&src("file:///etc/passwd"), &ctx(), &secrets, &mut used).is_err());
        let err = build_http(&src("https://x/{{secret:MISSING}}"), &ctx(), &secrets, &mut used).unwrap_err();
        assert!(err.contains("MISSING"));
    }

    #[test]
    fn command_plan_templates_args_but_not_the_program() {
        let src = CardSource::Command {
            program: "gh".into(),
            args: vec!["run".into(), "--repo".into(), "{{repo}}".into()],
            cwd: None,
            env: BTreeMap::new(),
        };
        let c = TemplateCtx::at("C:/w/zng-app", chrono::Local::now());
        let plan = build_command(&src, &c, &secrets, &mut Vec::new()).unwrap();
        assert_eq!(plan, CommandPlan {
                program: "gh".into(),
                args: vec!["run".into(), "--repo".into(), "zng-app".into()],
                cwd: "C:/w/zng-app".into(),
                env: BTreeMap::new()
            });
        let templated = CardSource::Command { program: "{{secret:API_KEY}}".into(), args: vec![], cwd: Some("/x".into()), env: BTreeMap::new() };
        let plan = build_command(&templated, &c, &secrets, &mut Vec::new()).unwrap();
        assert_eq!(plan.program, "{{secret:API_KEY}}");
        assert_eq!(plan.cwd, "/x");
        let empty = CardSource::Command { program: " ".into(), args: vec![], cwd: None, env: BTreeMap::new() };
        assert!(build_command(&empty, &c, &secrets, &mut Vec::new()).is_err());
    }

    #[test]
    fn non_json_output_becomes_text_and_lines() {
        assert_eq!(parse_output(b"{\"a\":1}"), serde_json::json!({"a": 1}));
        assert_eq!(parse_output(b"hello\r\nworld\r\n"), serde_json::json!({"text": "hello\r\nworld", "lines": ["hello", "world"]}));
        assert_eq!(parse_output(b""), serde_json::json!({"text": "", "lines": []}));
        assert_eq!(parse_output(b"42"), serde_json::json!(42));
    }

    #[test]
    fn snippet_caps_redacts_and_flattens() {
        let long = "x".repeat(500);
        let s = snippet(&long, &[]);
        assert_eq!(s.chars().count(), ERROR_SNIPPET_CHARS + 3);
        assert_eq!(snippet("a\nb\nsecretval", &["secretval".to_string()]), "a b ***");
    }

    #[tokio::test]
    async fn http_card_sends_templated_headers_and_extracts_values() {
        let seen: Arc<Mutex<Option<String>>> = Arc::default();
        let app = Router::new()
            .route(
                "/stats",
                get(|State(seen): State<Arc<Mutex<Option<String>>>>, headers: HeaderMap| async move {
                    *seen.lock().unwrap() = headers.get("x-api-key").map(|v| v.to_str().unwrap().to_string());
                    axum::Json(serde_json::json!({"open": 7, "items": [{"n": "a"}]}))
                }),
            )
            .with_state(seen.clone());
        let (base, handle) = serve(app).await;
        let card = http_card(&format!("{base}/stats"), stat_display("open", "number"));
        let res = run_card(&card, &ctx(), &secrets).await;
        handle.abort();
        assert_eq!(res.error, None);
        assert_eq!(res.stats[0].value, "7");
        assert!(res.fetched_at_ms > 0);
        assert_eq!(seen.lock().unwrap().as_deref(), Some("sk-dummy-key-123"));
    }

    #[tokio::test]
    async fn http_post_sends_the_rendered_body() {
        let app = Router::new().route("/echo", post(|body: String| async move { axum::Json(serde_json::json!({"got": body})) }));
        let (base, handle) = serve(app).await;
        let mut card = http_card(&format!("{base}/echo"), stat_display("got", "text"));
        card.source = CardSource::Http {
            method: "POST".into(),
            url: format!("{base}/echo"),
            headers: Default::default(),
            body: Some("repo={{repo}}".into()),
        };
        let c = TemplateCtx::at("C:/w/zng-app", chrono::Local::now());
        let res = run_card(&card, &c, &secrets).await;
        handle.abort();
        assert_eq!(res.error, None);
        assert_eq!(res.stats[0].value, "repo=zng-app");
    }

    #[tokio::test]
    async fn http_error_status_reports_status_and_a_redacted_capped_body() {
        let app = Router::new().route(
            "/bad",
            get(|| async { (StatusCode::UNAUTHORIZED, format!("invalid key sk-dummy-key-123 {}", "y".repeat(400))) }),
        );
        let (base, handle) = serve(app).await;
        let res = run_card(&http_card(&format!("{base}/bad"), stat_display("a", "text")), &ctx(), &secrets).await;
        handle.abort();
        let err = res.error.expect("error");
        assert!(err.starts_with("HTTP 401"), "{err}");
        assert!(!err.contains("sk-dummy-key-123"), "{err}");
        assert!(err.len() < 300, "{}", err.len());
        assert!(res.stats.is_empty());
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let app = Router::new().route("/r", get(|| async { (StatusCode::FOUND, [("location", "http://127.0.0.1:1/x")], "") }));
        let (base, handle) = serve(app).await;
        let res = run_card(&http_card(&format!("{base}/r"), stat_display("a", "text")), &ctx(), &secrets).await;
        handle.abort();
        assert!(res.error.unwrap().starts_with("HTTP 302"));
    }

    #[tokio::test]
    async fn a_secret_in_a_failing_url_never_reaches_the_error() {
        // Port 1 refuses the connection, and the secret sits in the query string.
        let mut card = http_card("http://127.0.0.1:1/x?key={{secret:API_KEY}}", stat_display("a", "text"));
        card.source = match card.source {
            CardSource::Http { method, url, .. } => CardSource::Http { method, url, headers: Default::default(), body: None },
            other => other,
        };
        let res = run_card(&card, &ctx(), &secrets).await;
        let err = res.error.expect("connect failure");
        assert!(!err.contains("sk-dummy-key-123"), "{err}");
        assert!(!err.contains("key="), "url is stripped from the error: {err}");
    }

    #[tokio::test]
    async fn a_missing_secret_is_a_card_error_naming_the_secret() {
        let card = http_card("http://127.0.0.1:1/x", stat_display("a", "text"));
        let res = run_card(&card, &ctx(), &|_: &str| None).await;
        assert!(res.error.unwrap().contains("API_KEY"));
    }

    #[tokio::test]
    async fn http_timeout_becomes_an_error_not_a_hang() {
        let app = Router::new().route("/slow", get(|| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            "late"
        }));
        let (base, handle) = serve(app).await;
        let card = http_card(&format!("{base}/slow"), stat_display("a", "text"));
        let res = run_card_with(&card, &ctx(), &secrets, Duration::from_millis(300), COMMAND_TIMEOUT).await;
        handle.abort();
        assert!(res.error.unwrap().contains("timed out"));
    }

    #[tokio::test]
    async fn command_card_parses_json_stdout() {
        #[cfg(windows)]
        let script = "'{\"a\":1,\"runs\":[1,2,3]}'";
        #[cfg(not(windows))]
        let script = "echo '{\"a\":1,\"runs\":[1,2,3]}'";
        let display = CardDisplay::Stats {
            items: vec![
                StatSpec { label: "a".into(), path: "a".into(), format: "number".into() },
                StatSpec { label: "runs".into(), path: "runs".into(), format: "count".into() },
            ],
        };
        let res = run_card(&shell_card(script, display), &ctx(), &secrets).await;
        assert_eq!(res.error, None);
        assert_eq!(res.stats.iter().map(|s| s.value.as_str()).collect::<Vec<_>>(), vec!["1", "3"]);
    }

    #[tokio::test]
    async fn command_card_wraps_plain_text_as_lines() {
        #[cfg(windows)]
        let script = "'one'; 'two'";
        #[cfg(not(windows))]
        let script = "echo one; echo two";
        let res = run_card(&shell_card(script, stat_display("lines", "count")), &ctx(), &secrets).await;
        assert_eq!(res.error, None);
        assert_eq!(res.stats[0].value, "2");
    }

    #[tokio::test]
    async fn command_runs_in_the_ctx_cwd_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let c = TemplateCtx::for_cwd(&dir.path().to_string_lossy());
        #[cfg(windows)]
        let script = "(Get-Location).Path";
        #[cfg(not(windows))]
        let script = "pwd";
        let res = run_card(&shell_card(script, stat_display("text", "text")), &c, &secrets).await;
        assert_eq!(res.error, None);
        let leaf = dir.path().file_name().unwrap().to_string_lossy().to_string();
        assert!(res.stats[0].value.contains(&leaf), "{}", res.stats[0].value);
    }

    #[tokio::test]
    async fn nonzero_exit_reports_code_and_stderr_and_redacts_secrets() {
        #[cfg(windows)]
        let script = "[Console]::Error.WriteLine('bad token {{secret:API_KEY}}'); exit 3";
        #[cfg(not(windows))]
        let script = "echo 'bad token {{secret:API_KEY}}' >&2; exit 3";
        let res = run_card(&shell_card(script, stat_display("a", "text")), &ctx(), &secrets).await;
        let err = res.error.expect("error");
        assert!(err.contains("code 3"), "{err}");
        assert!(err.contains("bad token ***"), "{err}");
        assert!(!err.contains("sk-dummy-key-123"), "{err}");
    }

    fn with_env(mut card: CardConfig, pairs: &[(&str, &str)]) -> CardConfig {
        if let CardSource::Command { env, .. } = &mut card.source {
            env.extend(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        }
        card
    }

    #[tokio::test]
    async fn command_env_reaches_the_script_rendered_through_the_templates() {
        #[cfg(windows)]
        let script = "'{\"v\":\"' + $env:CC_TOKEN + '\"}'";
        #[cfg(not(windows))]
        let script = "echo \"{\\\"v\\\":\\\"$CC_TOKEN\\\"}\"";
        let card = with_env(shell_card(script, stat_display("v", "text")), &[("CC_TOKEN", "{{secret:API_KEY}}")]);
        let res = run_card(&card, &ctx(), &secrets).await;
        assert_eq!(res.error, None);
        assert_eq!(res.stats[0].value, "***", "the secret reaches the script but never the card");
    }

    #[tokio::test]
    async fn a_secret_echoed_on_success_is_redacted_from_rows_headline_and_progress() {
        #[cfg(windows)]
        let script = r#"@{rows=@(@{t="key $env:CC_TOKEN"}); _card=@{headline=$env:CC_TOKEN; progress=@{value=1; max=2; label=$env:CC_TOKEN}}} | ConvertTo-Json -Depth 5 -Compress"#;
        #[cfg(not(windows))]
        let script = r#"printf '{"rows":[{"t":"key %s"}],"_card":{"headline":"%s","progress":{"value":1,"max":2,"label":"%s"}}}' "$CC_TOKEN" "$CC_TOKEN" "$CC_TOKEN""#;
        let display = CardDisplay::List {
            items_path: "rows".into(),
            label_path: "t".into(),
            value_path: "t".into(),
            link_path: None,
            limit: None,
        };
        let card = with_env(shell_card(script, display), &[("CC_TOKEN", "{{secret:API_KEY}}")]);
        let res = run_card(&card, &ctx(), &secrets).await;
        assert_eq!(res.error, None);
        let shown = serde_json::to_string(&res).unwrap();
        assert!(!shown.contains("sk-dummy-key-123"), "{shown}");
        assert_eq!(res.rows[0].label, "key ***");
        assert_eq!(res.headline.as_deref(), Some("***"));
        assert_eq!(res.progress.as_ref().map(|p| p.label.as_str()), Some("***"));
    }

    #[tokio::test]
    async fn stderr_past_the_cap_still_reports_the_real_exit_before_the_timeout() {
        #[cfg(windows)]
        let script = "[Console]::Error.Write('e' * 1500000); exit 1";
        #[cfg(not(windows))]
        let script = r"head -c 1500000 /dev/zero | tr '\0' e >&2; exit 1";
        let card = shell_card(script, stat_display("a", "text"));
        let res = run_card_with(&card, &ctx(), &secrets, HTTP_TIMEOUT, Duration::from_secs(15)).await;
        let err = res.error.expect("error");
        assert!(err.contains("code 1"), "{err}");
    }

    #[test]
    fn a_bare_name_resolves_to_its_shim_on_path_and_a_path_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join(if cfg!(windows) { "greet.cmd" } else { "greet" });
        std::fs::write(&shim, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = Some(dir.path().as_os_str().to_owned());
        assert_eq!(resolve_program_in("greet", path.clone()), shim);
        assert_eq!(resolve_program_in("no-such-tool-xyz", path.clone()), std::path::PathBuf::from("no-such-tool-xyz"));
        let explicit = format!("{}{}greet", dir.path().display(), std::path::MAIN_SEPARATOR);
        assert_eq!(resolve_program_in(&explicit, path), std::path::PathBuf::from(&explicit));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_cmd_shim_runs_with_its_args() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("greet.cmd");
        std::fs::write(&shim, "@echo {\"v\":\"%1\"}\r\n").unwrap();
        let card = command_card(&shim.to_string_lossy(), &["hi"], stat_display("v", "text"));
        let res = run_card(&card, &ctx(), &secrets).await;
        assert_eq!(res.error, None);
        assert_eq!(res.stats[0].value, "hi");
    }

    #[tokio::test]
    async fn an_env_secret_a_script_echoes_into_stderr_is_redacted_from_the_error() {
        #[cfg(windows)]
        let script = "[Console]::Error.WriteLine('rejected ' + $env:CC_TOKEN); exit 4";
        #[cfg(not(windows))]
        let script = "echo \"rejected $CC_TOKEN\" >&2; exit 4";
        let card = with_env(shell_card(script, stat_display("a", "text")), &[("CC_TOKEN", "{{secret:API_KEY}}")]);
        let res = run_card(&card, &ctx(), &secrets).await;
        let err = res.error.expect("error");
        assert!(err.contains("code 4") && err.contains("rejected ***"), "{err}");
        assert!(!err.contains("sk-dummy-key-123"), "{err}");
    }

    #[tokio::test]
    async fn a_missing_env_secret_names_the_secret_and_never_a_value() {
        let card = with_env(shell_card("exit 0", stat_display("a", "text")), &[("CC_TOKEN", "{{secret:NOPE}}")]);
        let err = run_card(&card, &ctx(), &secrets).await.error.expect("error");
        assert!(err.contains("NOPE"), "{err}");
    }

    #[tokio::test]
    async fn last_run_in_an_env_value_renders_the_callers_resolved_time() {
        #[cfg(windows)]
        let script = "'{\"v\":\"' + $env:SINCE + '\"}'";
        #[cfg(not(windows))]
        let script = "echo \"{\\\"v\\\":\\\"$SINCE\\\"}\"";
        let card = with_env(shell_card(script, stat_display("v", "text")), &[("SINCE", "{{last_run:/sync}}")]);
        let c = ctx().with_last_runs(std::collections::HashMap::from([("/sync".to_string(), 1_700_000_000_000)]));
        let res = run_card(&card, &c, &secrets).await;
        assert_eq!(res.error, None);
        assert_eq!(res.stats[0].value, "1700000000000");
    }

    #[tokio::test]
    async fn a_card_that_only_uses_the_card_object_fills_headline_and_progress() {
        #[cfg(windows)]
        let script = "'{\"_card\":{\"headline\":\"3 workdays not logged\",\"headline_tone\":\"warn\",\"progress\":{\"value\":5,\"max\":8,\"label\":\"5h of 8h\",\"behind\":true}}}'";
        #[cfg(not(windows))]
        let script = "echo '{\"_card\":{\"headline\":\"3 workdays not logged\",\"headline_tone\":\"warn\",\"progress\":{\"value\":5,\"max\":8,\"label\":\"5h of 8h\",\"behind\":true}}}'";
        let display = CardDisplay::Stats { items: vec![] };
        let res = run_card(&shell_card(script, display), &ctx(), &secrets).await;
        assert_eq!(res.error, None);
        assert!(res.stats.is_empty() && res.rows.is_empty());
        assert_eq!(res.headline.as_deref(), Some("3 workdays not logged"));
        assert_eq!(res.headline_tone.as_deref(), Some("warn"));
        let p = res.progress.expect("progress");
        assert_eq!((p.value, p.max, p.label.as_str(), p.behind), (5.0, 8.0, "5h of 8h", true));
    }

    #[tokio::test]
    async fn a_card_object_beside_a_normal_display_leaves_the_stats_alone() {
        #[cfg(windows)]
        let script = "'{\"n\":4,\"_card\":{\"headline\":\"hi\"}}'";
        #[cfg(not(windows))]
        let script = "echo '{\"n\":4,\"_card\":{\"headline\":\"hi\"}}'";
        let res = run_card(&shell_card(script, stat_display("n", "number")), &ctx(), &secrets).await;
        assert_eq!(res.stats[0].value, "4");
        assert_eq!(res.headline.as_deref(), Some("hi"));
        assert_eq!(res.headline_tone, None);
        assert_eq!(res.progress, None);
    }

    #[tokio::test]
    async fn a_failed_run_carries_no_card_extras() {
        let res = run_card(&command_card("definitely-not-a-real-binary-xyz", &[], stat_display("a", "text")), &ctx(), &secrets).await;
        assert!(res.error.is_some() && res.headline.is_none() && res.progress.is_none());
    }

    #[tokio::test]
    async fn missing_program_is_a_card_error() {
        let res = run_card(&command_card("definitely-not-a-real-binary-xyz", &[], stat_display("a", "text")), &ctx(), &secrets).await;
        assert!(res.error.unwrap().contains("could not start"));
    }

    #[tokio::test]
    async fn command_timeout_kills_the_child_and_reports() {
        #[cfg(windows)]
        let script = "Start-Sleep 30";
        #[cfg(not(windows))]
        let script = "sleep 30";
        let card = shell_card(script, stat_display("a", "text"));
        let started = std::time::Instant::now();
        let res = run_card_with(&card, &ctx(), &secrets, HTTP_TIMEOUT, Duration::from_secs(1)).await;
        assert!(res.error.unwrap().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn oversized_stdout_is_refused() {
        #[cfg(windows)]
        let script = "'x' * 1100000";
        #[cfg(not(windows))]
        let script = "head -c 1100000 /dev/zero | tr '\\0' x";
        let res = run_card(&shell_card(script, stat_display("a", "text")), &ctx(), &secrets).await;
        assert!(res.error.unwrap().contains("larger than 1 MB"));
    }
}
