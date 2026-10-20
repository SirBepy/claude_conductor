//! What the shell opener behind `open_external` may be handed.

/// True if `url` is one Conductor's own shell opener may receive. Scoped to
/// what the app's callers actually pass (grepped `src/`): an `http(s)://`
/// link (news items, the update-available link, waiting-on chips, the
/// dev-server popover) or a `mailto:` link, or a local file on a drive path
/// (a bare path, or a `file:` URL from a chat link) - the preview panel's
/// "Open in browser" passes the temp file `write_temp_file` just wrote. A
/// local file must exist and must not be an executable or script type, and
/// every other scheme and any UNC share is refused, so an XSS bug or an
/// AI-authored link that reaches this command can't launch a program.
pub(super) fn is_allowed_external_url(url: &str) -> bool {
    // Checked on the untrimmed string: `trim()` itself strips a trailing
    // control char like `\n`, which would otherwise let one slip through
    // the check below unnoticed.
    if url.is_empty() || url.chars().any(|c| c.is_control()) {
        return false;
    }
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        // Embedded whitespace is an argument-injection / scheme-confusion
        // surface that a well-formed URL never needs.
        return !trimmed.chars().any(|c| c.is_whitespace());
    }
    // Chat links to local files (`file:///C:/.../shot.png`) are a working
    // affordance, so a file: URL is judged as the path it names.
    // `file:///C:/x` keeps its leading slash after the `file://` strip, which
    // is the real root on macOS/Linux but has to go on a Windows drive path.
    let mut local = if lower.starts_with("file://") { &trimmed[7..] } else { trimmed };
    let is_drive = |s: &str| {
        let b = s.as_bytes();
        b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/')
    };
    if local.starts_with('/') && is_drive(&local[1..]) {
        local = &local[1..];
    }
    let accepted = if is_drive(local) {
        // A second ':' after the drive is an NTFS stream suffix
        // (`x.exe::$DATA`) that would hide the real extension.
        !local[2..].contains(':')
    } else {
        // A POSIX absolute path; `//` is a network path and stays refused,
        // like a Windows UNC share, a relative path or any other scheme.
        cfg!(not(windows)) && local.starts_with('/') && !local.starts_with("//")
    };
    accepted && is_openable_local_file(std::path::Path::new(local))
}

/// The shell opener runs a program for an executable or script, so a link
/// (AI-authored chat text included) may only open an existing file of a
/// type that the OS hands to a viewer, never one it executes.
fn is_openable_local_file(path: &std::path::Path) -> bool {
    const EXECUTABLE: &[&str] = &[
        "exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi",
        "msp", "scr", "pif", "cpl", "hta", "lnk", "url", "reg", "jar", "appref-ms", "application",
        "gadget", "msc", "inf", "sys", "dll", "command", "sh", "tool", "scpt", "pkg", "workflow",
        "terminal", "desktop",
    ];
    let Ok(target) = path.canonicalize() else { return false };
    if !target.is_file() {
        return false;
    }
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    !ext.is_empty() && !EXECUTABLE.contains(&ext.as_str())
}

#[cfg(test)]
mod tests {
    use super::is_allowed_external_url;

    #[test]
    fn accepts_https_and_http_and_mailto() {
        assert!(is_allowed_external_url("https://example.com/releases"));
        assert!(is_allowed_external_url("http://localhost:4173"));
        assert!(is_allowed_external_url("mailto:joe@example.com"));
    }

    #[test]
    fn rejects_an_exe_path() {
        // The exact case named in the todo's acceptance criteria.
        assert!(!is_allowed_external_url("C:\\x.exe"));
    }

    fn temp_file_with_ext(ext: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("open-external-test-{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "x").unwrap();
        path
    }

    #[test]
    fn rejects_an_existing_executable_or_script_by_path_or_file_url() {
        for ext in ["exe", "bat", "cmd", "ps1", "lnk", "hta"] {
            let path = temp_file_with_ext(ext);
            let raw = path.to_str().unwrap().to_string();
            let url = format!("file:///{}", raw.replace('\\', "/"));
            let (as_path, as_url) = (is_allowed_external_url(&raw), is_allowed_external_url(&url));
            let _ = std::fs::remove_file(&path);
            assert!(!as_path && !as_url, "{ext} must never be handed to the shell opener");
        }
    }

    #[test]
    fn accepts_an_existing_viewable_file_by_path_or_file_url() {
        let path = temp_file_with_ext("png");
        let raw = path.to_str().unwrap().to_string();
        let url = format!("file:///{}", raw.replace('\\', "/"));
        let (as_path, as_url) = (is_allowed_external_url(&raw), is_allowed_external_url(&url));
        let _ = std::fs::remove_file(&path);
        assert!(as_path && as_url, "a chat link to a screenshot keeps opening");
    }

    #[test]
    fn rejects_an_ntfs_stream_suffix_that_hides_the_extension() {
        let path = temp_file_with_ext("exe");
        let raw = format!("{}::$DATA", path.to_str().unwrap());
        let ok = is_allowed_external_url(&raw);
        let _ = std::fs::remove_file(&path);
        assert!(!ok);
    }

    #[cfg(not(windows))]
    #[test]
    fn accepts_a_posix_absolute_path_and_its_file_url() {
        let path = temp_file_with_ext("html");
        let raw = path.to_str().unwrap().to_string();
        let (as_path, as_url) = (is_allowed_external_url(&raw), is_allowed_external_url(&format!("file://{raw}")));
        let _ = std::fs::remove_file(&path);
        assert!(as_path && as_url, "the macOS preview Open in browser path must keep working");
    }

    #[test]
    fn rejects_a_missing_file_and_a_non_drive_file_url() {
        assert!(!is_allowed_external_url("file:///C:/definitely-missing-file.png"));
        assert!(!is_allowed_external_url("file:///etc/passwd"));
    }

    #[test]
    fn rejects_javascript_and_data_schemes() {
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("data:text/html,<script>1</script>"));
    }

    #[test]
    fn rejects_a_unc_share() {
        assert!(!is_allowed_external_url("\\\\attacker\\share\\payload.exe"));
    }

    #[test]
    fn rejects_whitespace_and_control_chars_in_an_http_url() {
        assert!(!is_allowed_external_url("http://example.com/ x"));
        assert!(!is_allowed_external_url("http://example.com/\n"));
        assert!(!is_allowed_external_url(""));
    }

    #[test]
    fn accepts_this_apps_own_temp_preview_file() {
        // Mirrors exactly what write_temp_file() produces and what
        // preview-panel.ts's "Open in browser" then passes to open_external.
        let path = std::env::temp_dir().join(format!("claude-conductor-{}.html", uuid::Uuid::new_v4()));
        std::fs::write(&path, "<html></html>").unwrap();
        let ok = is_allowed_external_url(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(ok, "temp preview file should be allowed");
    }
}
