//! Where the HTTP front may write a response (`out_file`, step 6).
//!
//! A script asks for the masked text, or for a binary download, to be saved to a
//! file instead of printed. The daemon writes it, so the path is the one thing a
//! chat controls that touches the disk: it is confined here, in code, before
//! anything is written.
//!
//! The rules (each has a test):
//!
//! - **Two roots.** The chat's own folder (its project, or a sub's worktree) and the
//!   OS temp dir. A relative path is relative to the chat's folder. A chat folder that is the home
//!   dir, a folder above it or a drive root is no root (everything under it would be a destination).
//! - **The folder is resolved, not the text.** The parent directory is canonicalized
//!   (every symlink and junction followed) and the result must sit under a canonicalized
//!   root, so `..`, a link that points out and an absolute path elsewhere all fail the
//!   same check. A `..` in the request text is refused outright as well.
//! - **The file itself is never followed.** An existing symlink or non-file at the final
//!   name is refused, and the bytes go to a temp file in the same folder that is renamed
//!   over the name, so a link planted at the name is replaced, not written through.
//! - **Places a response must never land** inside a root: a `.git` or `.claude` folder
//!   (a hook or a config a later command runs), a `.env*` file, and the daemon's own
//!   data folder (`broker-policy.json`, the secret store).
//! - **Names refused on Windows:** a network (UNC), verbatim or device path, a device name, a colon,
//!   a trailing dot or space, and any `~<digit>` (it may be an 8.3 short name for a refused name, so
//!   `backup~2.json` is refused too).
//! - **The parent must exist.** The daemon creates no folders.
//!
//! Not covered: another process of the same user swapping a folder for a link between the
//! check and the rename. The window is the few lines between them, the process could write
//! the file itself, and the daemon token it would need is the same-user limit the arch doc states.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf, Prefix};

const MAX_REQUEST_CHARS: usize = 1024;

/// What one chat may write to.
#[derive(Clone, Debug)]
pub struct OutTarget {
    /// Where a relative path starts: the chat's folder.
    base: Option<PathBuf>,
    roots: Vec<PathBuf>,
    deny: Vec<PathBuf>,
}

impl OutTarget {
    /// `folder` is the chat's working folder (none when the registry does not know it, which
    /// leaves only the temp dir), `deny` the folders a response must never be written into.
    pub fn new(folder: Option<&Path>, deny: Vec<PathBuf>) -> Self {
        // A chat started in the home folder, above it or at a drive root would make everything under it a
        // destination (`.ssh`, a Startup folder, `.vscode/tasks.json`): only the temp dir stays open then.
        let home = dirs::home_dir().and_then(|h| fs::canonicalize(h).ok());
        let broad = |f: &Path| {
            let real = fs::canonicalize(f).ok();
            // Home itself or any folder above it (`C:\Users`) holds every user's `.ssh` and Startup folder.
            f.parent().is_none() || real.as_deref().is_some_and(|r| r.parent().is_none() || home.as_deref().is_some_and(|h| h.starts_with(r)))
        };
        let mut roots: Vec<PathBuf> = folder.filter(|f| !broad(f)).into_iter().map(Path::to_path_buf).collect();
        roots.push(std::env::temp_dir());
        Self { base: folder.map(Path::to_path_buf), roots, deny }
    }

    /// The absolute, canonical path `requested` names, or the reason it is refused.
    pub fn resolve(&self, requested: &str) -> Result<PathBuf, String> {
        let requested = requested.trim();
        if requested.is_empty() || requested.contains('\0') || requested.chars().count() > MAX_REQUEST_CHARS {
            return Err("out_file is empty, holds a NUL, or is over 1024 characters".to_string());
        }
        let raw = Path::new(requested);
        let mut has_prefix = false;
        for c in raw.components() {
            match c {
                Component::ParentDir => return Err("out_file may not contain `..`".to_string()),
                Component::Prefix(p) => {
                    has_prefix = true;
                    // A network path is refused before anything touches the disk: opening one makes
                    // the daemon dial the host.
                    if !matches!(p.kind(), Prefix::Disk(_)) {
                        return Err("out_file may not use a network, verbatim or device path".to_string());
                    }
                }
                _ => {}
            }
        }
        if has_prefix && !raw.has_root() {
            return Err("out_file names a drive-relative path: give the full path or one relative to the chat's folder".to_string());
        }
        let full = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            let base = self.base.as_ref().ok_or("out_file is relative but the chat's folder is unknown: give an absolute path in the temp dir")?;
            base.join(raw)
        };
        let name = full.file_name().ok_or("out_file names no file")?.to_os_string();
        let parent = full.parent().ok_or("out_file names no folder")?;
        let parent = fs::canonicalize(parent).map_err(|_| "out_file's folder does not exist: create it first, the daemon creates no folders".to_string())?;
        if !parent.is_dir() {
            return Err("out_file's folder is not a folder".to_string());
        }
        let outside = || "out_file must be inside the chat's folder or the temp dir (links are followed before this check)".to_string();
        let root = self.roots.iter().filter_map(|r| fs::canonicalize(r).ok()).find(|r| parent.starts_with(r)).ok_or_else(outside)?;
        if self.deny.iter().any(|d| parent.starts_with(fs::canonicalize(d).unwrap_or_else(|_| d.clone()))) {
            return Err("out_file may not be inside the daemon's own data folder".to_string());
        }
        // Below the root only: a worktree itself sits under a `.claude` folder.
        let below = parent.strip_prefix(&root).map_err(|_| outside())?;
        let name_text = name.to_string_lossy().into_owned();
        for part in below.components().map(|c| c.as_os_str().to_string_lossy().into_owned()) {
            let lower = part.to_ascii_lowercase();
            if lower == ".git" || lower == ".claude" {
                return Err(format!("out_file may not be inside a {lower} folder"));
            }
        }
        refuse_final_name(&name_text)?;
        let target = parent.join(&name);
        match fs::symlink_metadata(&target) {
            Ok(m) if m.file_type().is_symlink() => Err("out_file is an existing link: it is not followed or replaced".to_string()),
            Ok(m) if !m.is_file() => Err("out_file is an existing folder or special file".to_string()),
            Ok(_) => {
                // An existing file is judged by its real name too: a Windows short name reaches the same
                // file under a spelling the checks above never saw.
                let real = fs::canonicalize(&target).map_err(|e| format!("out_file cannot be checked: {e}"))?;
                if real.parent() != Some(parent.as_path()) {
                    return Err("out_file resolves to a file in another folder".to_string());
                }
                refuse_final_name(&real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())?;
                Ok(target)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(target),
            Err(e) => Err(format!("out_file cannot be checked: {e}")),
        }
    }

    /// Checks `requested` again and writes `bytes`, replacing a regular file of that name. Returns the
    /// path as written and the byte count.
    pub fn write(&self, requested: &str, bytes: &[u8]) -> Result<(String, usize), String> {
        // Resolved again here, not only at the route: the response can take a while to arrive.
        let target = self.resolve(requested)?;
        let dir = target.parent().ok_or("out_file names no folder")?;
        let stem = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let temp = dir.join(format!(".{stem}.ccapi-{}-{nanos}.tmp", std::process::id()));
        let written = (|| -> std::io::Result<()> {
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            f.write_all(bytes)?;
            f.flush()?;
            drop(f);
            fs::rename(&temp, &target)
        })();
        if let Err(e) = written {
            let _ = fs::remove_file(&temp);
            return Err(format!("out_file could not be written: {e}"));
        }
        Ok((display(&target), bytes.len()))
    }
}

/// The rules for the file's own name (the folder parts are checked apart).
fn refuse_final_name(name: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if lower == ".git" || lower == ".claude" {
        return Err(format!("out_file may not be a {lower} entry"));
    }
    if lower.starts_with(".env") {
        return Err("out_file may not be an .env file".to_string());
    }
    if cfg!(windows) && !windows_name_ok(name) {
        return Err("out_file's name is not a valid Windows file name (a colon, a device name, a trailing dot or space, or a short name with ~)".to_string());
    }
    Ok(())
}

/// The path without Windows' `\\?\` prefix, which a script cannot always open.
fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => s.into_owned(),
    }
}

fn windows_name_ok(name: &str) -> bool {
    if name.contains(':') || name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    // `NAME~1`: a short name can stand for a name the rules above refuse.
    if name.as_bytes().windows(2).any(|w| w[0] == b'~' && w[1].is_ascii_digit()) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = ["con", "prn", "aux", "nul"];
    let numbered = |p: &str| stem.strip_prefix(p).is_some_and(|n| n.len() == 1 && n != "0" && n.chars().all(|c| c.is_ascii_digit()));
    !(reserved.contains(&stem.as_str()) || numbered("com") || numbered("lpt"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs() -> (tempfile::TempDir, tempfile::TempDir) {
        (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
    }

    fn target(project: &Path, deny: &[&Path]) -> OutTarget {
        OutTarget::new(Some(project), deny.iter().map(|d| d.to_path_buf()).collect())
    }

    #[test]
    fn a_relative_path_lands_in_the_chats_folder_and_an_absolute_one_in_the_temp_dir() {
        let (project, _) = dirs();
        let t = target(project.path(), &[]);
        let (p, n) = t.write("out.txt", b"hello").unwrap();
        assert_eq!(n, 5);
        assert_eq!(fs::read(project.path().join("out.txt")).unwrap(), b"hello");
        assert!(Path::new(&p).is_absolute() && !p.starts_with(r"\\?\"), "{p}");
        let temp = tempfile::tempdir().unwrap();
        let abs = temp.path().join("dl.bin");
        t.write(abs.to_str().unwrap(), b"x").unwrap();
        assert_eq!(fs::read(&abs).unwrap(), b"x");
        // A sub-folder that exists is fine; replacing a regular file is fine.
        fs::create_dir(project.path().join("sub")).unwrap();
        t.write("sub/a.txt", b"1").unwrap();
        t.write("sub/a.txt", b"22").unwrap();
        assert_eq!(fs::read(project.path().join("sub/a.txt")).unwrap(), b"22");
    }

    #[test]
    fn traversal_is_refused_in_every_spelling() {
        let (project, _) = dirs();
        let t = target(project.path(), &[]);
        for bad in ["../escape.txt", "sub/../../escape.txt", "..\\escape.txt", "a/../b.txt", ".."] {
            let e = t.write(bad, b"x").unwrap_err();
            assert!(e.contains("`..`") || e.contains("no file"), "{bad}: {e}");
        }
        assert!(!project.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn an_absolute_path_elsewhere_is_refused() {
        let (project, elsewhere) = dirs();
        // The temp dir is a root, so "elsewhere" must be outside it: use the home of the repo's own drive root.
        let t = target(project.path(), &[]);
        let outside = if cfg!(windows) { PathBuf::from(r"C:\Windows\System32") } else { PathBuf::from("/etc") };
        let e = t.write(outside.join("x.txt").to_str().unwrap(), b"x").unwrap_err();
        assert!(e.contains("inside the chat's folder or the temp dir"), "{e}");
        assert!(!outside.join("x.txt").exists());
        // A folder that does not exist is refused with its own reason, not created.
        let e = t.write("nope/x.txt", b"x").unwrap_err();
        assert!(e.contains("does not exist"), "{e}");
        assert!(!project.path().join("nope").exists());
        drop(elsewhere);
    }

    /// A folder link pointing out of the roots. A junction on Windows (no privilege needed), a symlink elsewhere.
    fn link_dir(link: &Path, to: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(to).output().map(|o| o.status.success()).unwrap_or(false)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(to, link).is_ok()
        }
    }

    #[test]
    fn a_folder_link_that_points_out_is_followed_and_then_refused() {
        let (project, _) = dirs();
        // Outside both roots: the temp dir is a root, so aim at a folder next to the project's parent only when that is not the temp dir.
        let outside = if cfg!(windows) { PathBuf::from(r"C:\Windows\Fonts") } else { PathBuf::from("/usr") };
        assert!(outside.exists());
        let link = project.path().join("escape");
        assert!(link_dir(&link, &outside), "the test needs to create a folder link");
        let t = target(project.path(), &[]);
        let e = t.write("escape/pwn.txt", b"x").unwrap_err();
        assert!(e.contains("inside the chat's folder or the temp dir"), "{e}");
        assert!(!outside.join("pwn.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_link_at_the_final_name_is_refused_and_never_written_through() {
        let (project, _) = dirs();
        let victim = project.path().join("victim.txt");
        fs::write(&victim, b"keep").unwrap();
        std::os::unix::fs::symlink(&victim, project.path().join("link.txt")).unwrap();
        let t = target(project.path(), &[]);
        let e = t.write("link.txt", b"overwrite").unwrap_err();
        assert!(e.contains("existing link"), "{e}");
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
    }

    #[test]
    fn a_folder_or_a_special_name_at_the_final_name_is_refused() {
        let (project, _) = dirs();
        fs::create_dir(project.path().join("adir")).unwrap();
        let t = target(project.path(), &[]);
        assert!(t.write("adir", b"x").unwrap_err().contains("existing folder"));
    }

    #[test]
    fn git_claude_env_and_the_data_folder_are_never_a_destination() {
        let (project, data) = dirs();
        fs::create_dir_all(project.path().join(".git/hooks")).unwrap();
        fs::create_dir_all(project.path().join(".claude")).unwrap();
        fs::create_dir_all(project.path().join("a/.CLAUDE")).unwrap();
        let t = target(project.path(), &[data.path()]);
        for bad in [".git/hooks/pre-commit", ".claude/settings.json", "a/.CLAUDE/x", ".git", ".env", ".env.local", ".ENV"] {
            assert!(t.write(bad, b"x").is_err(), "{bad} was accepted");
        }
        let inside_data = data.path().join("broker-policy.json");
        let e = t.write(inside_data.to_str().unwrap(), b"{}").unwrap_err();
        assert!(e.contains("data folder"), "{e}");
        assert!(!inside_data.exists());
        // A worktree that itself sits under a `.claude` folder is a fine root.
        let tree = project.path().join(".claude/wt");
        fs::create_dir_all(&tree).unwrap();
        target(&tree, &[]).write("ok.txt", b"x").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_network_path_is_refused_before_the_disk_is_touched() {
        let (project, _) = dirs();
        let t = target(project.path(), &[]);
        let e = t.write(r"\\host\share\x.txt", b"x").unwrap_err();
        assert!(e.contains("network"), "{e}");
    }

    #[test]
    fn a_chat_in_the_home_folder_or_a_drive_root_gets_only_the_temp_dir() {
        let root = if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") };
        let t = OutTarget::new(Some(&root), vec![]);
        // The refusal must be ours, not the OS's: an unprivileged write to a root fails anyway.
        let e = t.write("pwn.txt", b"x").unwrap_err();
        assert!(e.contains("inside the chat's folder or the temp dir"), "a drive root is no root: {e}");
        assert!(!root.join("pwn.txt").exists());
        if let Some(home) = dirs::home_dir() {
            if let Some(above) = home.parent().filter(|p| p.parent().is_some()) {
                let e = OutTarget::new(Some(above), vec![]).write("cc-api-test-above.txt", b"x").unwrap_err();
                assert!(e.contains("inside the chat's folder or the temp dir"), "a folder above home is no root: {e}");
            }
            let t = OutTarget::new(Some(&home), vec![]);
            let e = t.write("cc-api-test-home.txt", b"x").unwrap_err();
            assert!(e.contains("inside the chat's folder or the temp dir"), "{e}");
            assert!(!home.join("cc-api-test-home.txt").exists());
        }
    }

    #[test]
    fn an_unknown_folder_leaves_only_the_temp_dir() {
        let t = OutTarget::new(None, vec![]);
        let e = t.write("relative.txt", b"x").unwrap_err();
        assert!(e.contains("folder is unknown"), "{e}");
        let temp = tempfile::tempdir().unwrap();
        t.write(temp.path().join("ok.txt").to_str().unwrap(), b"x").unwrap();
    }

    #[test]
    fn empty_nul_and_oversized_requests_are_refused_and_no_temp_file_is_left_behind() {
        let (project, _) = dirs();
        let t = target(project.path(), &[]);
        for bad in ["", "   ", "a\0b", &"x".repeat(2000)] {
            assert!(t.write(bad, b"x").is_err());
        }
        t.write("good.txt", b"x").unwrap();
        let names: Vec<String> = fs::read_dir(project.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["good.txt".to_string()], "no .tmp file stays");
    }

    #[cfg(windows)]
    #[test]
    fn windows_device_and_stream_names_are_refused() {
        let (project, _) = dirs();
        let t = target(project.path(), &[]);
        for bad in ["NUL", "con.txt", "COM1", "lpt9.log", "a.txt:stream", "trail.", "C:rel.txt", "GIT~1", "ENV~1", "GITIGN~1"] {
            assert!(t.write(bad, b"x").is_err(), "{bad} was accepted");
        }
        t.write("com0.txt", b"x").unwrap();
    }
}
