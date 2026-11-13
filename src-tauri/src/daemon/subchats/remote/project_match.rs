//! Which of the host's projects a remote sub runs in: the one whose git origin
//! names the same repository as the home checkout's origin (Joe, 2026-11-13).
//! With no match or several the spawn is refused with the host's list, and the
//! main chat asks Joe which folder it is, or to set the project up on the host
//! first (`docs/cross-machine-subchats.md`, "Decisions").
//!
//! The same repository is written many ways (`git@github.com:o/r.git`,
//! `https://user@github.com/o/r`, `ssh://git@github.com:22/o/r.git/`), so both
//! sides compare a normalised form, never the raw string. Only the normalised
//! form (`origin_of`) goes on the wire: a raw origin URL can carry a token.
//!
//! The comparison ignores case: GitHub-style hosts do, and a wrong miss only
//! falls back to asking Joe. A false match on a case-sensitive server still
//! needs a commit shared with the home before anything is imported
//! (`git_sync::first_have`).

use std::path::{Path, PathBuf};

/// `host[:port]/path` in lowercase with no scheme, user, password, default port,
/// trailing slash or `.git`, or `None` for an empty, unreadable or relative URL
/// (`../origin` would name a different folder on each machine). An absolute local
/// path (a bare repo on disk, used by the two-daemon live rig) keeps its path
/// with forward slashes under `file:`.
pub fn normalize_origin(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("file://") {
        // As a URL its `?`/`#` start a query or fragment, never part of the folder.
        return local(rest.split(['?', '#']).next().unwrap_or(""));
    }
    if lower.starts_with('.') {
        return None;
    }
    if is_local_path(&lower) {
        return local(&lower);
    }
    // A `?` or `#` before the last `@` leaves it unclear which part is user info
    // and which a query (`joe:p?x@host`, `host/r?x=a@b&token=...`): either reading
    // could put a secret in the output, so such a URL matches nothing.
    if let (Some(at), Some(cut)) = (lower.rfind('@'), lower.find(['?', '#'])) {
        if cut < at {
            return None;
        }
    }
    // Credentials first: everything up to the last `@` is user info, whatever a
    // badly formed password holds (`:`, `/`), so nothing of it can reach the
    // output. A path with an `@` in it is misread (a miss, or a wrong host that
    // the shared-commit check then refuses), but never leaks.
    let (scheme, rest) = lower.split_once("://").map_or((None, lower.as_str()), |(s, r)| (Some(s), r));
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    // A query or fragment can carry a token (`?private_token=...`) and never names
    // another repository on the hosts this matches. (A local path, handled above,
    // keeps `?` and `#`, which are legal in folder names.)
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (host, path) = if let Some(scheme) = scheme {
        // scheme://host[:port]/path
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        (host_of(scheme, authority)?, path.to_string())
    } else if let Some((addr, path)) = rest.strip_prefix('[').and_then(|r| r.split_once("]:")) {
        // scp-like with a bracketed IPv6 host: [addr]:path.
        (format!("[{addr}]"), path.to_string())
    } else if let Some((host, path)) = rest.split_once(':') {
        // scp-like: host:path, always ssh on its default port.
        (host.to_string(), path.to_string())
    } else {
        return None;
    };
    let path = trim_path(&path);
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}"))
}

/// The host of a URL authority (user already removed), with its port kept only
/// when it is not the scheme's default, so `ssh://h:22/r` equals `h:r` while two
/// servers on one host stay apart. A bracketed IPv6 host keeps its brackets.
fn host_of(scheme: &str, authority: &str) -> Option<String> {
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (addr, after) = inner.split_once(']')?;
        (format!("[{addr}]"), after.strip_prefix(':').unwrap_or(""))
    } else {
        let (h, p) = authority.split_once(':').unwrap_or((authority, ""));
        (h.to_string(), p)
    };
    let default = match scheme {
        "ssh" | "git+ssh" | "ssh+git" => "22",
        "https" => "443",
        "http" => "80",
        "git" => "9418",
        _ => "",
    };
    Some(if port.is_empty() || port == default { host } else { format!("{host}:{port}") })
}

/// An absolute POSIX or Windows path. A drive needs its slash (`c:/`, `c:\`), so
/// `u:tok@host:r` is read as scp; `u:/tok@host/r` still looks like a drive, and
/// `local` refuses it for its `@`.
fn is_local_path(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/')
        || s.starts_with('\\')
        || (b.get(1) == Some(&b':') && b.first().is_some_and(u8::is_ascii_alphabetic) && matches!(b.get(2), Some(b'/' | b'\\')))
}

/// A local path with an `@` anywhere could be a URL carrying user info (`file://u:p@nas/r`,
/// `u:/tok@host/r`). A real folder with an `@` in its path only costs a miss
/// (the main chat then asks Joe), where a guess could put a secret on the wire.
fn local(path: &str) -> Option<String> {
    if path.contains('@') {
        return None;
    }
    let path = trim_path(&path.replace('\\', "/"));
    (!path.is_empty()).then(|| format!("file:{path}"))
}

fn trim_path(path: &str) -> String {
    let mut p = path.trim().trim_matches('/').to_string();
    while let Some(stripped) = p.strip_suffix(".git") {
        p = stripped.trim_end_matches('/').to_string();
    }
    // `host:~/r` and `host:r` both name `r` in the ssh user's home; `~other/r`
    // is another user's and stays as written.
    p.strip_prefix("~/").map(str::to_string).unwrap_or(p).trim_matches('/').to_string()
}

/// The raw `origin` URL of the repository holding `dir`. Can carry a credential:
/// never send it to a peer, send `origin_of` instead.
pub fn origin_url(dir: &Path) -> Option<String> {
    let (ok, out) = super::super::git::run_git(dir, &["remote", "get-url", "origin"])?;
    let url = String::from_utf8_lossy(&out).trim().to_string();
    (ok && !url.is_empty()).then_some(url)
}

/// The normalised origin of the repository holding `dir`, the form that goes on
/// the wire.
pub fn origin_of(dir: &Path) -> Option<String> {
    origin_url(dir).as_deref().and_then(normalize_origin)
}

/// What the host found for a wanted origin.
#[derive(Debug, PartialEq)]
pub enum Match {
    One(PathBuf),
    None,
    Many(Vec<PathBuf>),
}

/// The projects in `projects` (folder plus its raw origin URL, if any) whose
/// origin normalises to `want`, the home's `origin_of` as it arrived on the wire.
/// A folder listed twice counts once.
pub fn match_projects(want: &str, projects: &[(PathBuf, Option<String>)]) -> Match {
    if want.is_empty() {
        return Match::None;
    }
    let mut hits: Vec<PathBuf> = projects
        .iter()
        .filter(|(_, origin)| origin.as_deref().and_then(normalize_origin).as_deref() == Some(want))
        .map(|(dir, _)| dir.clone())
        .collect();
    hits.sort();
    hits.dedup();
    match hits.len() {
        0 => Match::None,
        1 => Match::One(hits.remove(0)),
        _ => Match::Many(hits),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_way_of_writing_one_github_repo_normalises_the_same() {
        let want = Some("github.com/sirbepy/claude_conductor".to_string());
        for url in [
            "git@github.com:SirBepy/claude_conductor.git",
            "https://github.com/SirBepy/claude_conductor",
            "https://github.com/SirBepy/claude_conductor.git/",
            "https://joe:ghp_secret@github.com/SirBepy/claude_conductor.git",
            "ssh://git@github.com:22/SirBepy/claude_conductor.git",
            "ssh://git@github.com/SirBepy/claude_conductor",
            "  git@github.com:SirBepy/claude_conductor  ",
        ] {
            assert_eq!(normalize_origin(url), want, "{url}");
        }
    }

    #[test]
    fn a_credential_never_survives_normalising() {
        for url in [
            "https://joe:ghp_secret@github.com/o/r.git",
            "joe:ghp_secret@github.com:o/r.git",
            "https://github.com/o/r.git?private_token=ghp_secret",
            "https://github.com/o/r#ghp_secret",
            "git@github.com:o/r.git?token=ghp_secret:more",
            "https://joe:p/ghp_secret@github.com/o/r",
            "u:ghp_secret@github.com:o/r.git",
        ] {
            let n = normalize_origin(url).unwrap();
            assert!(!n.contains("ghp_secret") && !n.contains("joe"), "{url} -> {n}");
            assert_eq!(n, "github.com/o/r", "{url}");
        }
        // Ambiguous ones name nothing at all rather than risk a secret.
        for url in [
            "joe:pa#ghp_secret@github.com:o/r.git",
            "https://joe:p?ghp_secret@github.com/o/r",
            "https://github.com/o/r?x=a@b.c/z&token=ghp_secret",
            "file://joe:ghp_secret@nas/srv/git/r.git",
            "file://joe:p/ghp_secret@nas/srv/r.git",
            "u:/ghp_secret@github.com/o/r",
            r"u:\ghp_secret@github.com\o\r",
            "https://github.com?x=ghp_secret/o/r",
        ] {
            assert_eq!(normalize_origin(url), None, "{url}");
        }
    }

    #[test]
    fn different_repos_and_hosts_stay_different() {
        assert_ne!(normalize_origin("git@github.com:o/r.git"), normalize_origin("git@github.com:o/r2.git"));
        assert_ne!(normalize_origin("git@github.com:o/r.git"), normalize_origin("git@gitlab.com:o/r.git"));
        assert_eq!(normalize_origin(""), None);
        assert_eq!(normalize_origin("https://github.com/"), None);
    }

    #[test]
    fn ipv6_hosts_ports_and_relative_origins_do_not_collide() {
        assert_ne!(normalize_origin("ssh://git@[::1]/o/r"), normalize_origin("ssh://git@[fd00::2]/o/r"));
        assert_eq!(normalize_origin("ssh://git@[::1]:22/o/r").as_deref(), Some("[::1]/o/r"));
        assert_eq!(normalize_origin("git@[::1]:o/r.git").as_deref(), Some("[::1]/o/r"), "scp form of the same");
        assert_ne!(normalize_origin("https://git.example.com:8443/o/r"), normalize_origin("https://git.example.com:9443/o/r"));
        assert_eq!(normalize_origin("https://git.example.com:443/o/r"), normalize_origin("https://git.example.com/o/r"));
        assert_eq!(normalize_origin("../origin"), None, "a relative origin names a different folder per machine");
        assert_eq!(normalize_origin("./origin.git"), None);
        assert_ne!(normalize_origin("host:~bob/r"), normalize_origin("host:r"));
        assert_eq!(normalize_origin("host:~/r"), normalize_origin("host:r"));
    }

    #[test]
    fn origin_of_sends_the_normalised_form_without_the_token() {
        let (_d, root) = super::super::super::git::test_repo::init();
        super::super::super::git::test_repo::git(&root, &["remote", "add", "origin", "https://joe:ghp_secret@github.com/O/R.git"]);
        assert_eq!(origin_of(&root).as_deref(), Some("github.com/o/r"));
    }

    #[test]
    fn a_local_bare_repo_origin_matches_itself_in_either_slash_style() {
        let a = normalize_origin(r"C:\scratch\origin.git").unwrap();
        assert_eq!(Some(a.clone()), normalize_origin("C:/scratch/origin.git/"));
        assert_eq!(Some(a.clone()), normalize_origin("file:///c:/scratch/origin"));
        assert_eq!(Some(a), normalize_origin("file:///c:/scratch/origin.git?private_token=ghp_secret#x"), "a file URL's query is cut");
        assert_eq!(normalize_origin("/srv/git/r.git").as_deref(), Some("file:srv/git/r"));
        assert_ne!(normalize_origin("/srv/git/proj#a"), normalize_origin("/srv/git/proj#b"), "a local folder keeps # and ?");
    }

    #[test]
    fn the_match_is_one_none_or_many() {
        let projects = vec![
            (PathBuf::from("/Users/joe/Projects/conductor"), Some("https://github.com/SirBepy/claude_conductor".to_string())),
            (PathBuf::from("/Users/joe/Projects/other"), Some("git@github.com:SirBepy/other.git".to_string())),
            (PathBuf::from("/Users/joe/scratch"), None),
        ];
        let want = |url: &str| normalize_origin(url).unwrap();
        assert_eq!(
            match_projects(&want("git@github.com:SirBepy/claude_conductor.git"), &projects),
            Match::One(PathBuf::from("/Users/joe/Projects/conductor"))
        );
        assert_eq!(match_projects(&want("git@github.com:SirBepy/missing.git"), &projects), Match::None);
        assert_eq!(match_projects("", &projects), Match::None);
        let mut two = projects.clone();
        two.push((PathBuf::from("/Users/joe/Projects/conductor-2"), Some("git@github.com:sirbepy/claude_conductor".to_string())));
        assert!(matches!(match_projects(&want("https://github.com/SirBepy/claude_conductor"), &two), Match::Many(v) if v.len() == 2));
        // The same folder registered twice, not side by side, is one match.
        let mut dup = projects.clone();
        dup.push(projects[0].clone());
        assert_eq!(match_projects(&want("https://github.com/SirBepy/claude_conductor"), &dup), Match::One(PathBuf::from("/Users/joe/Projects/conductor")));
    }

    #[test]
    fn origin_url_reads_the_repos_origin() {
        let (_d, root) = super::super::super::git::test_repo::init();
        assert_eq!(origin_url(&root), None, "no origin yet");
        super::super::super::git::test_repo::git(&root, &["remote", "add", "origin", "git@github.com:o/r.git"]);
        assert_eq!(origin_url(&root).as_deref(), Some("git@github.com:o/r.git"));
    }
}
