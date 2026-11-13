//! Moving commits between a main chat's checkout (the home) and a sub's clone on
//! a paired machine (the host) as git bundles, so no remote and no push is ever
//! involved (`docs/cross-machine-subchats.md`, "Wire").
//!
//! The two clones share history (the host folder is matched by origin URL), so a
//! bundle only ever carries the commits the other side lacks: the sender lists
//! candidate commits of its tip, the receiver answers the newest one it has
//! (`first_have`), and the bundle excludes it. A full-history bundle is never
//! made: this repo's own pack is about 2.8 GB, so a bundle over
//! `MAX_BUNDLE_BYTES` is refused with a note to fetch on the host instead.
//!
//! Everything a peer sends here is untrusted: commit ids are checked to be hex
//! before git sees them, a bundle is only imported into a sub's own ref namespace,
//! and its objects are fsck-checked on the way in.
//!
//! Git features used are all older than 2.24 (macOS Catalina's git); in particular
//! not `bundle create --quiet` (2.32).

use super::super::git::run_git;
use base64::Engine;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The largest bundle either side sends or accepts. A bundle rides base64 in a
/// `/api/rpc` body, which `remote_server.rs` caps at 30 MiB (`MAX_RPC_BODY_BYTES`):
/// 20 MiB raw is about 26.7 MiB of base64, leaving room for the rest of the JSON.
pub const MAX_BUNDLE_BYTES: usize = 20 * 1024 * 1024;

/// How many of the tip's newest first-parent commits are offered one by one.
const RECENT: usize = 256;
/// How far back the offer reaches, one commit in every `SPACING` past `RECENT`.
const REACH: usize = 4096;
const SPACING: usize = 64;
/// Most commits one bundle carries. Checked before the bundle is written, so a
/// far-behind host never makes this side write gigabytes only to refuse them.
const MAX_BUNDLE_COMMITS: u32 = 5000;
/// Longest offer `first_have` reads; anything past it is ignored.
const MAX_OFFER: usize = RECENT + REACH / SPACING + 1;

/// Namespace of the short-lived ref a bundle is made from (git bundles name refs,
/// not bare commits). Removed before `make_bundle` returns.
const BUNDLE_REF_PREFIX: &str = "refs/cc-bundle/";

/// The only refs a bundle may be imported into: a sub's own scratch namespace,
/// and a sub's branch (`sub/<id>`, the name every sub branch has on both sides).
/// Never a trunk, a tag or a remote-tracking ref.
const IMPORT_PREFIXES: [&str; 2] = ["refs/cc-sub/", "refs/heads/sub/"];



/// A full commit id: 40 hex (SHA-1) or 64 hex (SHA-256) characters.
pub fn is_commit_id(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn git_ok(repo: &Path, args: &[&str]) -> Result<String, String> {
    match run_git(repo, args) {
        Some((true, out)) => Ok(text(&out)),
        Some((false, _)) => Err(format!("git {} failed", args.first().copied().unwrap_or(""))),
        None => Err("could not run git".to_string()),
    }
}

/// Git with stderr kept, for the errors a caller shows (a bundle missing a
/// prerequisite says so on stderr).
fn git_verbose(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    // `LC_ALL=C`: `import_file` reads git's English wording to tell a missing
    // prerequisite from a broken bundle.
    cmd.arg("-C").arg(repo).args(args).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    crate::util::process::hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(text(&out.stdout))
    } else {
        Err(one_line(&text(&out.stderr), 300))
    }
}

fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}...", flat.chars().take(max).collect::<String>())
    }
}

/// The full id `rev` names in `repo`, if it names a commit there. A `rev` that
/// starts with `-` is refused unread, so it can never be taken as an option.
pub fn resolve_commit(repo: &Path, rev: &str) -> Option<String> {
    if rev.is_empty() || rev.starts_with('-') {
        return None;
    }
    let sha = git_ok(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).ok()?;
    is_commit_id(&sha).then_some(sha)
}

/// The commits of `tip` the other side is asked about, newest first: the newest
/// `RECENT` first-parent commits one by one, then one in every `SPACING` back to
/// `REACH`, then the oldest commit reached. A host up to `REACH` first-parent
/// commits behind finds a base within `SPACING` commits of its own tip; one
/// further behind finds none and the spawn is refused with "fetch on the Mac".
pub fn candidates(repo: &Path, tip: &str) -> Result<Vec<String>, String> {
    let tip = resolve_commit(repo, tip).ok_or_else(|| format!("{tip} is not a commit in {}", repo.display()))?;
    let listed = git_ok(repo, &["rev-list", "--first-parent", &format!("--max-count={REACH}"), &tip])?;
    let all: Vec<&str> = listed.lines().map(str::trim).filter(|l| is_commit_id(l)).collect();
    let mut out: Vec<String> = all.iter().take(RECENT).map(|s| s.to_string()).collect();
    out.extend(all.iter().skip(RECENT).step_by(SPACING).map(|s| s.to_string()));
    if let Some(last) = all.last() {
        if out.last().map(String::as_str) != Some(*last) {
            out.push(last.to_string());
        }
    }
    Ok(out)
}

/// The first of `candidates` (sent by the other side, newest first) that is a
/// commit in `repo`. Anything that is not a full commit id is skipped unread.
/// A commit present without its ancestry (a shallow or partial clone) can be
/// answered here; `import_bundle`'s verify then refuses the bundle built on it.
pub fn first_have(repo: &Path, candidates: &[String]) -> Option<String> {
    let ids: Vec<String> = candidates.iter().filter(|c| is_commit_id(c)).take(MAX_OFFER).cloned().collect();
    if ids.is_empty() {
        return None;
    }
    // One `cat-file --batch-check` for the whole list: a git process per id costs
    // tens of milliseconds each on Windows.
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["cat-file", "--batch-check=%(objectname) %(objecttype)"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::util::process::hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    // Written from its own thread while this one reads: git answers each line as
    // it reads it, so with a full offer (about 13 KB in, 17 KB out) a write-all
    // first would fill both ~4 KB Windows pipes and block both processes forever.
    let writer = std::thread::spawn(move || {
        let input: String = ids.iter().map(|id| format!("{id}\n")).collect();
        let _ = stdin.write_all(input.as_bytes());
    });
    let out = child.wait_with_output().ok();
    let _ = writer.join();
    let out = out?;
    let answer = String::from_utf8_lossy(&out.stdout);
    // Answers come back in input order; a missing object reads "<id> missing".
    answer.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (id, kind) = (parts.next()?, parts.next()?);
        (kind == "commit" && is_commit_id(id)).then(|| id.to_string())
    })
}

/// A bundle of `tip`'s history, minus everything reachable from `exclude` (the
/// commit id `first_have` found on the other side, so it must be a full id).
/// `None` for `exclude` would send the whole history, so it is refused: the two
/// clones must share a commit.
pub fn make_bundle(repo: &Path, tip: &str, exclude: Option<&str>) -> Result<Vec<u8>, String> {
    make_bundle_capped(repo, tip, exclude, MAX_BUNDLE_BYTES)
}

fn make_bundle_capped(repo: &Path, tip: &str, exclude: Option<&str>, cap: usize) -> Result<Vec<u8>, String> {
    let Some(exclude) = exclude else {
        return Err("the other machine's clone shares no commit with this one, so its history would have to be sent whole. Fetch the project on that machine first.".to_string());
    };
    if !is_commit_id(exclude) {
        return Err("the other machine's answer is not a commit id".to_string());
    }
    let tip = resolve_commit(repo, tip).ok_or_else(|| format!("{tip} is not a commit here"))?;
    let exclude = resolve_commit(repo, exclude).ok_or_else(|| format!("{exclude} is not a commit here"))?;
    if tip == exclude {
        return Err("the other machine already has this commit: there is nothing to send".to_string());
    }
    let commits: u32 = git_ok(repo, &["rev-list", "--count", &tip, &format!("^{exclude}")])?.parse().unwrap_or(u32::MAX);
    if commits > MAX_BUNDLE_COMMITS {
        return Err(format!(
            "{commits} commits would have to be sent, more than the {MAX_BUNDLE_COMMITS} a machine link carries at once. Fetch the project on the other machine first, then try again."
        ));
    }
    let file = scratch_file(repo, "make")?;
    let name = format!("{BUNDLE_REF_PREFIX}{}", uuid::Uuid::new_v4().simple());
    git_ok(repo, &["update-ref", &name, &tip])?;
    let made = git_verbose(repo, &["bundle", "create", &file.to_string_lossy(), &name, &format!("^{exclude}")]);
    let _ = git_ok(repo, &["update-ref", "-d", &name]);
    let result = made.and_then(|_| read_capped(&file, cap));
    let _ = std::fs::remove_file(&file);
    result
}

/// The bundle file's bytes, or the over-cap refusal decided from its size alone,
/// before anything is read into memory.
fn read_capped(file: &Path, cap: usize) -> Result<Vec<u8>, String> {
    let len = std::fs::metadata(file).map_err(|e| format!("could not read the bundle: {e}"))?.len();
    if len > cap as u64 {
        return Err(format!(
            "the commits to send come to {} MB, over the {} MB a machine link carries. Fetch the project on the other machine first, then try again.",
            len / (1024 * 1024),
            cap / (1024 * 1024)
        ));
    }
    std::fs::read(file).map_err(|e| format!("could not read the bundle: {e}"))
}

/// Whether `name` is a ref a bundle may be imported into: under `IMPORT_PREFIXES`
/// and well formed by git's own rules (`check-ref-format`).
fn importable_ref(repo: &Path, name: &str) -> bool {
    IMPORT_PREFIXES.iter().any(|p| name.len() > p.len() && name.starts_with(p))
        && !name.contains(':')
        && git_ok(repo, &["check-ref-format", name]).is_ok()
}

/// Fetches the one head of `bundle` into `into_ref` in `repo` and returns the
/// commit it points at. The head may be any commit `repo` already has (a bundle
/// with an empty pack passes every check here), so a caller that merges what it
/// imported first checks the head descends from the base it expects. `into_ref` must be in a sub's own namespace
/// (`IMPORT_PREFIXES`) and not a branch some worktree has checked out (moving it
/// would leave that worktree's files out of step with its branch, so the host
/// imports into `refs/cc-sub/` and moves a sub's branch itself with a rebase).
/// The bundle's pack is indexed with `index-pack --strict` (git's fsck checks on
/// every object) and `into_ref` is set only once the head proved to be a commit:
/// a bundle with no head, several heads, a non-commit head, a prerequisite `repo`
/// lacks, or an object fsck rejects never moves it.
pub fn import_bundle(repo: &Path, bundle: &[u8], into_ref: &str) -> Result<String, String> {
    if !importable_ref(repo, into_ref) {
        return Err(format!("{into_ref} is not a ref a bundle may be imported into"));
    }
    if checked_out(repo, into_ref)? {
        return Err(format!("{into_ref} is checked out in a worktree, so a bundle may not move it"));
    }
    if bundle.len() > MAX_BUNDLE_BYTES {
        return Err("the bundle is larger than a machine link carries".to_string());
    }
    let file = scratch_file(repo, "import")?;
    std::fs::write(&file, bundle).map_err(|e| format!("could not store the bundle: {e}"))?;
    // What `into_ref` holds now, unpeeled (empty for absent, which `update-ref`
    // reads as "must not exist" for either hash length): the final `update-ref`
    // only moves it from this value, so a second import racing this one fails
    // instead of being overwritten.
    let before = git_ok(repo, &["rev-parse", "--verify", "--quiet", into_ref]).unwrap_or_default();
    let result = import_file(repo, &file, bundle, into_ref, &before);
    let _ = std::fs::remove_file(&file);
    result
}

fn import_file(repo: &Path, file: &Path, bundle: &[u8], into_ref: &str, before: &str) -> Result<String, String> {
    let path = file.to_string_lossy();
    // Not `-q`: it also silences the "lacks these prerequisite commits" line.
    git_verbose(repo, &["bundle", "verify", &path]).map_err(|e| {
        if e.contains("prerequisite") {
            format!("this clone lacks commits the bundle builds on: {e}")
        } else {
            format!("the bundle is not valid: {e}")
        }
    })?;
    let heads = git_verbose(repo, &["bundle", "list-heads", &path])?;
    let listed: Vec<(&str, &str)> = heads.lines().filter_map(|l| l.trim().split_once(' ')).collect();
    let [(sha, head)] = listed.as_slice() else {
        return Err(format!("the bundle must carry exactly one head, it carries {}", listed.len()));
    };
    if !is_commit_id(sha) || head.contains(':') || !head.starts_with("refs/") || git_ok(repo, &["check-ref-format", head]).is_err() {
        return Err("the bundle's head is not a commit ref".to_string());
    }
    // The bundle's objects come from another machine: fsck them as a server would
    // a push, so a malformed tree or a hostile `.gitmodules` never reaches a merge.
    // Not `git fetch <bundle>`: on git 2.44 it ignored `transfer.fsckObjects` for
    // a bundle (measured 2026-11-13: a duplicate-entry tree went straight in).
    index_strict(repo, pack_of(bundle)?).map_err(|e| format!("the bundle's objects were refused: {e}"))?;
    let kind = git_ok(repo, &["cat-file", "-t", sha])?;
    if kind != "commit" {
        return Err(format!("the bundle's head is a {kind}, not a commit"));
    }
    git_ok(repo, &["update-ref", into_ref, sha, before]).map_err(|_| format!("{into_ref} moved while the bundle was imported"))?;
    Ok(sha.to_string())
}

/// The pack inside a bundle: everything after the header, which ends at the
/// first empty line (`# v2 git bundle` or `# v3 git bundle`, capabilities,
/// prerequisites, heads).
fn pack_of(bundle: &[u8]) -> Result<&[u8], String> {
    if !(bundle.starts_with(b"# v2 git bundle\n") || bundle.starts_with(b"# v3 git bundle\n")) {
        return Err("the bundle is not valid: unknown header".to_string());
    }
    let end = bundle.windows(2).position(|w| w == b"\n\n").ok_or("the bundle is not valid: no pack")?;
    Ok(&bundle[end + 2..])
}

/// `git index-pack --stdin --fix-thin --strict` in `repo`: stores the pack's
/// objects only when every one passes fsck. A bundle's pack is thin (its deltas
/// can name the prerequisite commits' objects), hence `--fix-thin`.
fn index_strict(repo: &Path, pack: &[u8]) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["index-pack", "--stdin", "--fix-thin", "--strict"])
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::util::process::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("could not write to git")?;
    let pack = pack.to_vec();
    // Fed from its own thread: git reads and reports progress at once, so a
    // write-all first could fill the pipes the same way `first_have` avoids.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&pack);
    });
    let out = child.wait_with_output().map_err(|e| format!("git did not finish: {e}"));
    let _ = writer.join();
    let out = out?;
    if out.status.success() {
        Ok(())
    } else {
        Err(one_line(&text(&out.stderr), 300))
    }
}

/// Whether some worktree of `repo` (the main one included) has `name` checked
/// out. A failed listing is an error, never "not checked out".
fn checked_out(repo: &Path, name: &str) -> Result<bool, String> {
    let listed = git_ok(repo, &["worktree", "list", "--porcelain"])?;
    Ok(listed.lines().any(|l| l.strip_prefix("branch ") == Some(name)))
}

/// Removes a ref an import made, once it has served (best effort). Only a sub's
/// own refs, never anything else.
pub fn delete_ref(repo: &Path, name: &str) {
    if importable_ref(repo, name) {
        let _ = git_ok(repo, &["update-ref", "-d", name]);
    }
}

/// Clears what a crash in the middle of a bundle can leave behind: the scratch
/// refs (which keep their objects alive) and bundle files. Only for a moment no
/// bundle is being made or imported, such as daemon start.
pub fn sweep_leftovers(repo: &Path) {
    let refs = git_ok(repo, &["for-each-ref", "--format=%(refname)", BUNDLE_REF_PREFIX]).unwrap_or_default();
    for name in refs.lines().map(str::trim).filter(|n| n.starts_with(BUNDLE_REF_PREFIX)) {
        let _ = git_ok(repo, &["update-ref", "-d", name]);
    }
    if let Ok(file) = scratch_file(repo, "probe") {
        if let Some(dir) = file.parent() {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                if entry.path().extension().is_some_and(|e| e == "bundle") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// A scratch file inside the repo's own git folder: it holds the project's
/// source, so it keeps the repo's permissions rather than a shared temp dir's,
/// and git never sees it as a working-tree file.
fn scratch_file(repo: &Path, kind: &str) -> Result<PathBuf, String> {
    let common = PathBuf::from(git_ok(repo, &["rev-parse", "--git-common-dir"])?);
    let common = if common.is_absolute() { common } else { repo.join(common) };
    // A `\\?\C:\...` path handed back to git as an argument becomes `//?/C:/...`,
    // under which git cannot create its lock file; the drive path is the same folder.
    let shown = common.to_string_lossy().into_owned();
    let common = match shown.strip_prefix(r"\\?\").or_else(|| shown.strip_prefix("//?/")) {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => common,
    };
    let dir = common.join("cc-bundles");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    Ok(dir.join(format!("{kind}-{}.bundle", uuid::Uuid::new_v4().simple())))
}

/// A bundle as it rides in a JSON body.
pub fn encode(bundle: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bundle)
}

/// The bundle a peer sent, refused unread when its text alone is over the cap.
pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() / 4 * 3 > MAX_BUNDLE_BYTES + 3 {
        return Err("the bundle is larger than a machine link carries".to_string());
    }
    base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|e| format!("the bundle is not valid base64: {e}"))
}

#[cfg(test)]
mod tests {
    use super::super::super::git::test_repo::{git, init};
    use super::*;

    fn commit(root: &Path, file: &str, body: &str) -> String {
        std::fs::write(root.join(file), body).unwrap();
        git(root, &["add", file]);
        git(root, &["commit", "-q", "-m", file]);
        resolve_commit(root, "HEAD").unwrap()
    }

    /// The home repo plus a clone of it standing in for the host's checkout.
    fn home_and_host() -> (tempfile::TempDir, PathBuf, tempfile::TempDir, PathBuf) {
        let (home_dir, home) = init();
        let host_dir = tempfile::tempdir().unwrap();
        let host = std::fs::canonicalize(host_dir.path()).unwrap().join("clone");
        // `canonicalize` gives `\\?\C:\...` on Windows, which `git clone` cannot
        // read as a source; `-C` with such a path is fine.
        let plain = |p: &Path| p.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        git(host_dir.path(), &["clone", "-q", &plain(&home), "clone"]);
        // A clone does not inherit `home`'s local identity; a CI runner has no global one.
        git(&host, &["config", "user.email", "t@example.com"]);
        git(&host, &["config", "user.name", "t"]);
        git(&host, &["config", "commit.gpgsign", "false"]);
        (home_dir, home, host_dir, host)
    }

    /// A repo with no object in common with `home_and_host`'s. Not built on
    /// `init()`: two inits in the same second make the very same root commit, and
    /// an amend would keep that commit in the object store.
    fn unrelated_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "u@example.com"]);
        git(&root, &["config", "user.name", "u"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("other.txt"), "another project\n").unwrap();
        git(&root, &["add", "other.txt"]);
        git(&root, &["commit", "-q", "-m", "another root"]);
        (dir, root)
    }

    fn has_commit(repo: &Path, sha: &str) -> bool {
        resolve_commit(repo, sha).as_deref() == Some(sha)
    }

    #[test]
    fn the_home_sends_only_what_the_host_lacks_and_it_lands_on_the_named_ref() {
        let (_h, home, _o, host) = home_and_host();
        let base = resolve_commit(&home, "HEAD").unwrap();
        commit(&home, "a.txt", "a\n");
        let tip = commit(&home, "b.txt", "b\n");
        assert!(!has_commit(&host, &tip));

        let offer = candidates(&home, &tip).unwrap();
        assert_eq!(offer.first(), Some(&tip), "newest first");
        assert_eq!(first_have(&host, &offer).as_deref(), Some(base.as_str()), "the host's newest shared commit");

        let bundle = make_bundle(&home, &tip, Some(&base)).unwrap();
        let landed = import_bundle(&host, &decode(&encode(&bundle)).unwrap(), "refs/cc-sub/test/target").unwrap();
        assert_eq!(landed, tip);
        assert!(has_commit(&host, &tip));
        let leftover = git_ok(&home, &["for-each-ref", BUNDLE_REF_PREFIX]).unwrap();
        assert!(leftover.is_empty(), "the bundle's own ref is removed: {leftover}");
        delete_ref(&host, "refs/cc-sub/test/target");
        assert!(resolve_commit(&host, "refs/cc-sub/test/target").is_none());
    }

    #[test]
    fn the_sub_branch_comes_back_the_same_way_without_the_hosts_own_commits() {
        let (_h, home, _o, host) = home_and_host();
        let base = resolve_commit(&home, "HEAD").unwrap();
        // A commit only the host's own checkout has: it must never ride back.
        let host_only = commit(&host, "mac-local.txt", "local\n");
        git(&host, &["checkout", "-q", "-b", "sub/abc", &base]);
        let sub_tip = commit(&host, "work.txt", "work\n");

        let offer = candidates(&host, &sub_tip).unwrap();
        let have = first_have(&home, &offer).unwrap();
        assert_eq!(have, base);
        let bundle = make_bundle(&host, &sub_tip, Some(&have)).unwrap();
        assert_eq!(import_bundle(&home, &bundle, "refs/heads/sub/abc").unwrap(), sub_tip);
        assert!(!has_commit(&home, &host_only), "the host's unrelated local commit stayed on the host");
    }

    #[test]
    fn a_peers_offer_is_filtered_to_commit_ids_and_an_unrelated_repo_has_none() {
        let (_h, home, _o, _host) = home_and_host();
        let (_u, unrelated) = unrelated_repo();
        let mut offer = candidates(&home, "HEAD").unwrap();
        assert_eq!(first_have(&unrelated, &offer), None, "no shared history");
        offer.insert(0, "--batch-all-objects".to_string());
        offer.insert(0, "HEAD".to_string());
        let head = resolve_commit(&home, "HEAD").unwrap();
        assert_eq!(first_have(&home, &offer).as_deref(), Some(head.as_str()), "junk entries are skipped, not passed to git");
        assert_eq!(first_have(&home, &[]), None);
    }

    #[test]
    fn no_shared_commit_means_no_bundle_rather_than_the_whole_history() {
        let (_h, home, _o, _host) = home_and_host();
        let err = make_bundle(&home, "HEAD", None).unwrap_err();
        assert!(err.contains("shares no commit"), "{err}");
        let head = resolve_commit(&home, "HEAD").unwrap();
        assert!(make_bundle(&home, &head, Some(&head)).unwrap_err().contains("nothing to send"));
    }

    #[test]
    fn a_bundle_over_the_cap_is_refused_and_leaves_no_ref_behind() {
        let (_h, home, _o, _host) = home_and_host();
        let base = resolve_commit(&home, "HEAD").unwrap();
        let tip = commit(&home, "big.txt", &"x".repeat(4096));
        let err = make_bundle_capped(&home, &tip, Some(&base), 10).unwrap_err();
        assert!(err.contains("Fetch the project"), "{err}");
        assert!(git_ok(&home, &["for-each-ref", BUNDLE_REF_PREFIX]).unwrap().is_empty());
    }

    #[test]
    fn a_bundle_building_on_commits_the_receiver_lacks_is_refused_before_any_ref_is_written() {
        let (_h, home, _o, _host) = home_and_host();
        let (_u, unrelated) = unrelated_repo();
        let base = resolve_commit(&home, "HEAD").unwrap();
        let tip = commit(&home, "c.txt", "c\n");
        let bundle = make_bundle(&home, &tip, Some(&base)).unwrap();
        let err = import_bundle(&unrelated, &bundle, "refs/cc-sub/x").unwrap_err();
        assert!(err.contains("lacks commits"), "{err}");
        assert!(resolve_commit(&unrelated, "refs/cc-sub/x").is_none());
    }

    #[test]
    fn only_a_plain_ref_may_be_the_import_target_and_garbage_is_not_a_bundle() {
        let (_h, _home, _o, host) = home_and_host();
        for bad in ["HEAD", "refs/../config", "refs/a:refs/b", "refs/a b", "refs/heads/master", "refs/tags/v1", "refs/remotes/origin/master", "refs/cc-sub/", "refs/cc-sub/a..b", "refs/heads/sub/x.lock", "-refs/cc-sub/x"] {
            assert!(import_bundle(&host, b"x", bad).unwrap_err().contains("not a ref"), "{bad}");
        }
        assert!(import_bundle(&host, b"not a bundle", "refs/cc-sub/y").unwrap_err().contains("not valid"));
        assert!(decode("!!!").is_err());
    }

    #[test]
    fn the_offer_reaches_back_with_spacing_past_the_recent_window() {
        let (_h, home, _o, host) = home_and_host();
        for i in 0..300 {
            // Empty commits keep 300 of them fast.
            git(&home, &["commit", "-q", "--allow-empty", "-m", &format!("c{i}")]);
        }
        // 301 commits: the newest 256, one spaced pick at index 256, and the root.
        let offer = candidates(&home, "HEAD").unwrap();
        assert_eq!(offer.len(), RECENT + 2, "{}", offer.len());
        let listed = git_ok(&home, &["rev-list", "--first-parent", "HEAD"]).unwrap();
        let all: Vec<&str> = listed.lines().collect();
        assert_eq!(offer[RECENT], all[RECENT], "the first spaced pick follows the recent window");
        let root = git_ok(&home, &["rev-list", "--max-parents=0", "HEAD"]).unwrap();
        assert_eq!(offer.last(), Some(&root), "the oldest reachable commit is always offered");
        // The host, cloned before the 300, has only the root: it answers it from
        // the very end of a full-size offer. Padded past `MAX_OFFER` with absent
        // ids, the exchange is far larger than a pipe buffer in both directions.
        let mut big: Vec<String> = (0..MAX_OFFER).map(|n| format!("{n:040x}")).collect();
        big.splice(0..offer.len(), offer.iter().cloned());
        assert_eq!(big.len(), MAX_OFFER);
        assert_eq!(first_have(&host, &big).as_deref(), Some(root.as_str()));
    }

    /// A tree with the same name twice, which `git fsck` rejects
    /// (`duplicateEntries`), written raw so git's own tools never tidy it.
    fn hostile_commit(repo: &Path, parent: &str) -> String {
        let blob = git_ok(repo, &["rev-parse", "HEAD:base.txt"]).unwrap();
        let raw_id: Vec<u8> = (0..blob.len()).step_by(2).map(|i| u8::from_str_radix(&blob[i..i + 2], 16).unwrap()).collect();
        let mut tree = Vec::new();
        for _ in 0..2 {
            tree.extend_from_slice(b"100644 twice.txt\0");
            tree.extend_from_slice(&raw_id);
        }
        let file = repo.join("hostile-tree.bin");
        std::fs::write(&file, &tree).unwrap();
        // Named relative to the repo: `-C` takes the long `\\?\` path, a path argument does not.
        let tree_id = git_verbose(repo, &["hash-object", "-t", "tree", "--literally", "-w", "hostile-tree.bin"]).unwrap();
        std::fs::remove_file(&file).unwrap();
        git_ok(repo, &["commit-tree", &tree_id, "-p", parent, "-m", "hostile"]).unwrap()
    }

    #[test]
    fn a_bundle_with_a_malformed_tree_is_refused_by_fsck_and_moves_no_ref() {
        let (_h, home, _o, host) = home_and_host();
        let base = resolve_commit(&home, "HEAD").unwrap();
        let bad = hostile_commit(&home, &base);
        let bundle = make_bundle(&home, &bad, Some(&base)).unwrap();
        let err = import_bundle(&host, &bundle, "refs/cc-sub/h/target").unwrap_err();
        assert!(err.contains("objects were refused"), "{err}");
        assert!(resolve_commit(&host, "refs/cc-sub/h/target").is_none());
        assert!(!has_commit(&host, &bad), "nothing from the refused pack was kept");
    }

    #[test]
    fn a_branch_checked_out_in_a_worktree_is_never_moved_by_a_bundle() {
        let (_h, home, _o, host) = home_and_host();
        let base = resolve_commit(&home, "HEAD").unwrap();
        let tip = commit(&home, "e.txt", "e\n");
        let bundle = make_bundle(&home, &tip, Some(&base)).unwrap();
        let wt = host.parent().unwrap().join("wt");
        git(&host, &["worktree", "add", "-q", "-b", "sub/busy", &wt.to_string_lossy().trim_start_matches(r"\\?\").to_string(), "HEAD"]);
        let err = import_bundle(&host, &bundle, "refs/heads/sub/busy").unwrap_err();
        assert!(err.contains("checked out"), "{err}");
        assert_eq!(resolve_commit(&host, "refs/heads/sub/busy").as_deref(), Some(base.as_str()));
    }

    #[test]
    fn a_crash_leftover_is_swept() {
        let (_h, home, _o, _host) = home_and_host();
        let head = resolve_commit(&home, "HEAD").unwrap();
        git(&home, &["update-ref", &format!("{BUNDLE_REF_PREFIX}stale"), &head]);
        let dir = home.join(".git").join("cc-bundles");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("make-stale.bundle"), b"x").unwrap();
        sweep_leftovers(&home);
        assert!(git_ok(&home, &["for-each-ref", BUNDLE_REF_PREFIX]).unwrap().is_empty());
        assert!(!dir.join("make-stale.bundle").exists());
        assert_eq!(resolve_commit(&home, "HEAD").as_deref(), Some(head.as_str()), "nothing else touched");
    }

    #[test]
    fn a_rev_that_looks_like_an_option_is_never_passed_to_git() {
        let (_h, home, _o, _host) = home_and_host();
        assert_eq!(resolve_commit(&home, "--all"), None);
        assert_eq!(resolve_commit(&home, ""), None);
        let head = resolve_commit(&home, "HEAD").unwrap();
        assert!(make_bundle(&home, &head, Some("--all")).unwrap_err().contains("not a commit id"));
    }

    #[test]
    fn no_bundle_scratch_file_is_left_in_the_git_folder() {
        let (_h, home, _o, host) = home_and_host();
        let base = resolve_commit(&home, "HEAD").unwrap();
        let tip = commit(&home, "d.txt", "d\n");
        let bundle = make_bundle(&home, &tip, Some(&base)).unwrap();
        import_bundle(&host, &bundle, "refs/cc-sub/z/target").unwrap();
        for repo in [&home, &host] {
            let dir = repo.join(".git").join("cc-bundles");
            let left: Vec<_> = std::fs::read_dir(&dir).map(|d| d.flatten().collect()).unwrap_or_default();
            assert!(left.is_empty(), "{}: {left:?}", dir.display());
        }
    }
}
