//! Where the HTTP front may write a response (`out_file`, step 6).
//!
//! A script asks for the masked text, or for a binary download, to be saved to a
//! file instead of printed. The daemon writes it, so the path is the one thing a
//! chat controls that touches the disk: it is confined here, in code, before
//! anything is written.
//!
//! The rules (each has a test):
//!
//! - **Two roots.** The chat's own folder (its project, or a sub's worktree) and, in the temp
//!   dir, only the chat's own folder `<temp>/cc-api/<session>` ([`OutTarget::for_session`]; the
//!   bare temp dir would let one chat overwrite another's files). A relative path is relative to
//!   the chat's folder. A chat folder that is the home dir, a folder above it or a drive root is
//!   no root (everything under it would be a destination).
//! - **The folder is resolved, not the text.** The parent directory is canonicalized
//!   (every symlink and junction followed) and the result must sit under a canonicalized
//!   root, so `..`, a link that points out and an absolute path elsewhere all fail the
//!   same check. A `..` in the request text is refused outright as well.
//! - **The file itself is never followed.** An existing symlink or non-file at the final
//!   name is refused, and the bytes go to a temp file in the same folder that is renamed
//!   over the name, so a link planted at the name is replaced, not written through.
//! - **Places a response must never land** inside a root: a `.git` or `.claude` folder
//!   anywhere on the parent path, the root's own ancestors included (a hook or a config a
//!   later command runs; a root that is a `.claude` folder gets nothing), except a sub's
//!   worktree `<repo>/.claude/worktrees/<id>` (see `refuse_protected_folders`), a `.env*`
//!   file, and the daemon's own data folder (`broker-policy.json`, the secret store).
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
    /// Set by [`Self::for_session`]: the one folder of the OS temp dir this chat may write.
    session_temp: Option<PathBuf>,
    /// Where `session_temp` canonicalizes to when nothing was planted: `resolve` checks it again, so a
    /// link swapped in while the upstream call ran cannot move the root.
    session_temp_real: Option<PathBuf>,
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
        Self { base: folder.map(Path::to_path_buf), roots, deny, session_temp: None, session_temp_real: None }
    }

    /// The same target with the OS temp dir narrowed to `<temp>/cc-api/<session>`, so one chat
    /// cannot overwrite another chat's temp files (or anything else a program keeps in the temp
    /// dir). The daemon creates that one folder itself; every other folder stays the chat's job.
    pub fn for_session(&self, session: &str) -> Self {
        let temp = std::env::temp_dir();
        let mine = temp.join("cc-api").join(session_folder_name(session));
        let mut out = self.clone();
        out.roots.retain(|r| r != &temp);
        // A failure to create the folder leaves no temp root at all. So does a folder that is not where
        // its name says (`cc-api` or the chat's folder is a link or junction a chat planted): its
        // canonical path would otherwise become the root and move the writes anywhere.
        let real_temp = fs::canonicalize(&temp).ok();
        let home = temp.join("cc-api");
        // `cc-api` is checked before the chat's folder is created in it: a link planted there would
        // otherwise make the daemon create a folder wherever it points.
        let home_ok = fs::create_dir_all(&home).is_ok() && real_temp.as_ref().is_some_and(|t| fs::canonicalize(&home).ok().as_ref() == Some(&t.join("cc-api")));
        let expected = real_temp.map(|t| t.join("cc-api").join(session_folder_name(session)));
        if home_ok && fs::create_dir_all(&mine).is_ok() && expected.is_some() && fs::canonicalize(&mine).ok() == expected {
            out.roots.push(mine.clone());
            out.session_temp = Some(mine);
            out.session_temp_real = expected;
        }
        out
    }

    /// Whether `root` is still where it was when the target was made: only the chat's temp folder can
    /// move (a chat can replace it with a link while a call is in flight).
    fn root_in_place(&self, root: &Path) -> bool {
        match (&self.session_temp, &self.session_temp_real) {
            (Some(t), Some(real)) if t == root => fs::canonicalize(root).ok().as_ref() == Some(real),
            _ => true,
        }
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
        let outside = || match &self.session_temp {
            Some(t) => format!("out_file must be inside the chat's folder or the temp dir (here only this chat's own temp folder, {}; links are followed before this check)", display(t)),
            None => "out_file must be inside the chat's folder or the temp dir (links are followed before this check)".to_string(),
        };
        let root = self.roots.iter().filter(|r| self.root_in_place(r)).filter_map(|r| fs::canonicalize(r).ok()).find(|r| parent.starts_with(r)).ok_or_else(outside)?;
        if self.deny.iter().any(|d| parent.starts_with(fs::canonicalize(d).unwrap_or_else(|_| d.clone()))) {
            return Err("out_file may not be inside the daemon's own data folder".to_string());
        }
        let name_text = name.to_string_lossy().into_owned();
        refuse_protected_folders(&parent, &root)?;
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

/// A folder name for a session id: lowercase letters, digits, `-` and `_` stay, every other byte
/// becomes `%xx`, so two ids never share a folder (a capital letter is encoded because Windows and
/// macOS treat `A` and `a` as one name) and no id can name a path.
fn session_folder_name(session: &str) -> String {
    let mut name: String = session.bytes().map(|b| if b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' { (b as char).to_string() } else { format!("%{b:02x}") }).collect();
    if name.is_empty() {
        name.push_str("%00");
    }
    name
}

/// Refuses a `.git` or `.claude` folder anywhere on the canonical parent path, the root's own
/// ancestors included: a chat whose folder is a `.claude` folder (the `~/.claude` project) would
/// otherwise write a hook or `settings.json` the daemon's raw write lets past Claude Code's own
/// protection. The one exception is a sub's worktree, `<repo>/.claude/worktrees/<id>`: that
/// `.claude` is exempt only when the root itself sits inside the worktree, so a root of the
/// `.claude` folder cannot reach it through `worktrees/<id>/...`.
fn refuse_protected_folders(parent: &Path, root: &Path) -> Result<(), String> {
    let lowered = |p: &Path| -> Vec<String> { p.components().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect() };
    let root_parts = lowered(root);
    // Every such pair inside the root: a worktree made inside another worktree has two.
    let exempt: Vec<usize> = (0..root_parts.len().saturating_sub(2)).filter(|&i| root_parts[i] == ".claude" && root_parts[i + 1] == "worktrees").collect();
    for (i, part) in lowered(parent).iter().enumerate() {
        if (part == ".git" || part == ".claude") && !exempt.contains(&i) {
            return Err(format!("out_file may not be inside a {part} folder"));
        }
    }
    Ok(())
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
        // A sub's worktree, `<repo>/.claude/worktrees/<id>`, is a fine root.
        let tree = project.path().join(".claude/worktrees/wt");
        fs::create_dir_all(tree.join("sub")).unwrap();
        target(&tree, &[]).write("ok.txt", b"x").unwrap();
        target(&tree, &[]).write("sub/ok.txt", b"x").unwrap();
    }

    #[test]
    fn a_root_that_is_or_sits_in_a_claude_folder_refuses_hooks_and_settings() {
        let (project, _) = dirs();
        let claude = project.path().join(".claude");
        fs::create_dir_all(claude.join("hooks")).unwrap();
        fs::create_dir_all(claude.join("worktrees/abc/hooks")).unwrap();
        fs::create_dir_all(claude.join("worktrees/abc/tree")).unwrap();
        // The chat's folder is the `.claude` folder itself (the `~/.claude` project).
        let t = target(&claude, &[]);
        for bad in ["hooks/x.py", "settings.json", "worktrees/abc/hooks/x.py"] {
            let e = t.write(bad, b"x").unwrap_err();
            assert!(e.contains(".claude folder"), "{bad}: {e}");
        }
        assert!(!claude.join("hooks/x.py").exists() && !claude.join("settings.json").exists());
        // A chat folder below a `.claude` that is no worktree parent is refused too.
        fs::create_dir_all(claude.join("skills/s")).unwrap();
        assert!(target(&claude.join("skills"), &[]).write("s/SKILL.md", b"x").is_err());
        // The worktree itself, and a folder inside it, stay writable.
        let tree = claude.join("worktrees/abc/tree");
        target(&tree, &[]).write("ok.txt", b"x").unwrap();
        target(&claude.join("worktrees/abc"), &[]).write("hooks/ok.py", b"x").unwrap();
        // A `.git` above the root is refused the same way.
        let git = project.path().join(".git/work");
        fs::create_dir_all(&git).unwrap();
        assert!(target(&git, &[]).write("x.txt", b"x").unwrap_err().contains(".git folder"));
    }

    #[test]
    fn session_ids_that_differ_only_by_case_get_different_temp_folders() {
        assert_ne!(session_folder_name("Abc"), session_folder_name("abc"));
        assert_eq!(session_folder_name("abc-1_x"), "abc-1_x");
    }

    /// Removes the link a test planted, whatever happens to the test: a junction is a folder on
    /// Windows, a symlink a file elsewhere.
    struct PlantedLink(PathBuf);
    impl PlantedLink {
        fn make(at: &Path, to: &Path) -> Self {
            let _ = fs::remove_dir(at);
            #[cfg(windows)]
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(at).arg(to).output().map(|o| o.status.success()).unwrap_or(false);
            #[cfg(unix)]
            let made = std::os::unix::fs::symlink(to, at).is_ok();
            assert!(made, "the test could not make a link");
            Self(at.to_path_buf())
        }
    }
    impl Drop for PlantedLink {
        fn drop(&mut self) {
            #[cfg(windows)]
            let _ = fs::remove_dir(&self.0);
            #[cfg(unix)]
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn a_link_planted_at_the_chats_temp_folder_gives_no_temp_root() {
        let (project, elsewhere) = dirs();
        let id = format!("link-plant-{}", std::process::id());
        let planted = std::env::temp_dir().join("cc-api").join(&id);
        fs::create_dir_all(planted.parent().unwrap()).unwrap();
        let _link = PlantedLink::make(&planted, elsewhere.path());
        let scoped = target(project.path(), &[]).for_session(&id);
        assert!(scoped.resolve(planted.join("x.json").to_str().unwrap()).is_err());
        assert!(scoped.write(planted.join("x.json").to_str().unwrap(), b"x").is_err());
        assert!(!elsewhere.path().join("x.json").exists(), "the write followed the planted link");
    }

    #[test]
    fn a_link_swapped_in_after_the_target_was_made_moves_no_write() {
        let (project, elsewhere) = dirs();
        let id = format!("link-swap-{}", std::process::id());
        let mine = std::env::temp_dir().join("cc-api").join(&id);
        let _ = fs::remove_dir_all(&mine);
        let scoped = target(project.path(), &[]).for_session(&id);
        let file = mine.join("x.json");
        scoped.write(file.to_str().unwrap(), b"first").unwrap();
        // The chat swaps its folder for a link while the upstream call is in flight.
        fs::remove_dir_all(&mine).unwrap();
        let _link = PlantedLink::make(&mine, elsewhere.path());
        assert!(scoped.write(file.to_str().unwrap(), b"second").is_err());
        assert!(!elsewhere.path().join("x.json").exists(), "the write followed the swapped-in link");
    }

    #[test]
    fn a_worktree_inside_a_worktree_is_a_fine_root_but_its_own_claude_folder_is_not() {
        let (project, _) = dirs();
        let outer = project.path().join(".claude/worktrees/a/tree");
        let inner = outer.join(".claude/worktrees/b/tree");
        fs::create_dir_all(inner.join("sub")).unwrap();
        fs::create_dir_all(outer.join(".claude/hooks")).unwrap();
        target(&inner, &[]).write("sub/ok.txt", b"x").unwrap();
        // The outer worktree's own `.claude` is still no place for a hook.
        let t = target(&outer.join(".claude"), &[]);
        let e = t.write("hooks/x.py", b"x").unwrap_err();
        assert!(e.contains(".claude folder"), "{e}");
        assert!(!outer.join(".claude/hooks/x.py").exists());
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
