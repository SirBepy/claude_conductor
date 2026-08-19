//! Guard for the CLIENT-SUPPLIED waiting target on `report_turn_status`
//! (todo 675). The app live-tails a local path and hands a URL to the OS
//! opener, so nothing reaches either sink unless it canonicalises inside an
//! allowed root (session cwd, app log dir) or is a plain http(s) URL.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_LABEL: usize = 120;
const MAX_HREF: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitingKind {
    Ci,
    LocalProcess,
    External,
}

impl WaitingKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ci" => Some(Self::Ci),
            "local-process" => Some(Self::LocalProcess),
            "external" => Some(Self::External),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ci => "ci",
            Self::LocalProcess => "local-process",
            Self::External => "external",
        }
    }
}

/// Roots a `local-process` path may live under. This MCP child inherits the
/// session's cwd from its `claude` parent (`daemon::lifecycle::spawn` sets
/// `current_dir`), and the app writes its own logs under `<data>/logs`.
pub fn default_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(f) = crate::settings::paths::log_file() {
        if let Some(dir) = f.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    roots
}

/// Canonicalise FIRST, then contain: a symlink pointing out of `roots` is
/// resolved before the prefix check, so it cannot escape. A relative path or
/// one that does not resolve at all is rejected outright.
fn safe_local_path(href: &str, roots: &[PathBuf]) -> Option<String> {
    if !Path::new(href).is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(href).ok()?;
    for root in roots {
        let Ok(root) = std::fs::canonicalize(root) else {
            continue;
        };
        if real.starts_with(&root) {
            return Some(real.to_string_lossy().into_owned());
        }
    }
    None
}

/// Only `http`/`https` ever reach the OS opener. `file:`, a bare path, any
/// other scheme, and anything carrying whitespace or a control character
/// (argument-injection surface) are rejected.
fn safe_url(href: &str) -> Option<String> {
    let lower = href.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if href.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let after_scheme = lower.split_once("//")?.1;
    let host = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(href.to_string())
}

/// Build the `waitingOn` payload, or `None` for "no target" - which is what a
/// caller omitting the optional params gets, so every existing caller keeps
/// validating. A rejected href degrades to `href: null`: the label still
/// shows, but there is nothing for the UI to open or read.
pub fn sanitize(
    label: Option<&str>,
    kind: Option<&str>,
    href: Option<&str>,
    roots: &[PathBuf],
) -> Option<Value> {
    let label = label.map(str::trim).filter(|s| !s.is_empty())?;
    let kind = WaitingKind::parse(kind?.trim())?;
    let href = href
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= MAX_HREF)
        .and_then(|h| match kind {
            WaitingKind::LocalProcess => safe_local_path(h, roots),
            WaitingKind::Ci | WaitingKind::External => safe_url(h),
        });
    let label: String = label.chars().take(MAX_LABEL).collect();
    Some(json!({ "label": label, "kind": kind.as_str(), "href": href }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A root dir with `build.log` inside it, plus a sibling dir OUTSIDE the
    /// root holding `secret.txt`.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("session-cwd");
        let outside = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let inside_file = root.join("build.log");
        writeln!(std::fs::File::create(&inside_file).unwrap(), "hello").unwrap();
        let outside_file = outside.join("secret.txt");
        writeln!(std::fs::File::create(&outside_file).unwrap(), "nope").unwrap();
        (tmp, root, outside)
    }

    #[test]
    fn omitting_every_param_yields_no_target() {
        assert_eq!(sanitize(None, None, None, &[]), None);
    }

    #[test]
    fn label_without_kind_is_no_target() {
        assert_eq!(sanitize(Some("CI run"), None, None, &[]), None);
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert_eq!(sanitize(Some("x"), Some("database"), None, &[]), None);
    }

    #[test]
    fn label_only_target_has_null_href() {
        let v = sanitize(Some("  release build  "), Some("ci"), None, &[]).unwrap();
        assert_eq!(v["label"], json!("release build"));
        assert_eq!(v["kind"], json!("ci"));
        assert_eq!(v["href"], Value::Null);
    }

    #[test]
    fn local_path_inside_session_cwd_is_accepted() {
        let (_tmp, root, _outside) = fixture();
        let p = root.join("build.log");
        let v = sanitize(
            Some("build"),
            Some("local-process"),
            Some(p.to_str().unwrap()),
            &[root.clone()],
        )
        .unwrap();
        let got = PathBuf::from(v["href"].as_str().unwrap());
        assert_eq!(got, std::fs::canonicalize(&p).unwrap());
    }

    #[test]
    fn absolute_path_outside_the_roots_is_rejected() {
        let (_tmp, root, outside) = fixture();
        let p = outside.join("secret.txt");
        let v = sanitize(
            Some("build"),
            Some("local-process"),
            Some(p.to_str().unwrap()),
            &[root],
        )
        .unwrap();
        assert_eq!(v["href"], Value::Null, "out-of-tree path must not be readable");
    }

    #[test]
    fn dot_dot_traversal_out_of_the_root_is_rejected() {
        let (_tmp, root, _outside) = fixture();
        let traversal = root.join("..").join("elsewhere").join("secret.txt");
        let v = sanitize(
            Some("build"),
            Some("local-process"),
            Some(traversal.to_str().unwrap()),
            &[root],
        )
        .unwrap();
        assert_eq!(v["href"], Value::Null, "`..` must be canonicalised before containment");
    }

    #[test]
    fn relative_path_is_rejected() {
        let (_tmp, root, _outside) = fixture();
        let v = sanitize(
            Some("build"),
            Some("local-process"),
            Some("build.log"),
            &[root],
        )
        .unwrap();
        assert_eq!(v["href"], Value::Null);
    }

    #[test]
    fn nonexistent_path_inside_the_root_is_rejected() {
        let (_tmp, root, _outside) = fixture();
        let p = root.join("never-written.log");
        let v = sanitize(
            Some("build"),
            Some("local-process"),
            Some(p.to_str().unwrap()),
            &[root],
        )
        .unwrap();
        assert_eq!(v["href"], Value::Null);
    }

    #[test]
    fn app_log_dir_is_a_valid_root_alongside_the_cwd() {
        let (_tmp, root, outside) = fixture();
        let p = outside.join("secret.txt");
        let v = sanitize(
            Some("daemon log"),
            Some("local-process"),
            Some(p.to_str().unwrap()),
            &[root, outside.clone()],
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(v["href"].as_str().unwrap()),
            std::fs::canonicalize(&p).unwrap()
        );
    }

    #[test]
    fn ci_kind_rejects_a_file_scheme_url() {
        let v = sanitize(
            Some("run 32115742584"),
            Some("ci"),
            Some("file:///C:/Windows/win.ini"),
            &[],
        )
        .unwrap();
        assert_eq!(v["href"], Value::Null, "file: must never reach the OS opener");
    }

    #[test]
    fn ci_kind_rejects_a_bare_path() {
        let v = sanitize(Some("run"), Some("ci"), Some("C:\\Windows\\win.ini"), &[]).unwrap();
        assert_eq!(v["href"], Value::Null);
    }

    #[test]
    fn ci_kind_accepts_https_run_url() {
        let url = "https://github.com/SirBepy/repo/actions/runs/32115742584";
        let v = sanitize(Some("release CI"), Some("ci"), Some(url), &[]).unwrap();
        assert_eq!(v["href"], json!(url));
    }

    #[test]
    fn url_with_whitespace_or_no_host_is_rejected() {
        assert_eq!(
            sanitize(Some("a"), Some("external"), Some("https:// evil.test"), &[]).unwrap()["href"],
            Value::Null
        );
        assert_eq!(
            sanitize(Some("a"), Some("external"), Some("https:///path"), &[]).unwrap()["href"],
            Value::Null
        );
    }

    #[test]
    fn javascript_and_data_schemes_are_rejected() {
        for bad in ["javascript:alert(1)", "data:text/html,<b>x", "vbscript:x"] {
            let v = sanitize(Some("a"), Some("external"), Some(bad), &[]).unwrap();
            assert_eq!(v["href"], Value::Null, "{bad} must be rejected");
        }
    }
}
