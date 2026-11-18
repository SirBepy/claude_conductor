//! A warm base of compiled third-party dependencies that a new worktree sub's
//! build folder is seeded from (pc-1757). Without it every sub compiled the whole
//! dependency tree again (677 crates, 13 minutes) into its own `sub-<id>/target`
//! and held it as a 5GB copy; with it the sub compiles only the project's own
//! crates (3 crates, 7 minutes) and holds a 2GB private part.
//!
//! The base is `<repo>/.claude/worktrees/.build-base/`, laid out like a cargo
//! target folder (`debug/deps`, `debug/build`, `debug/.fingerprint`) plus a
//! `SOURCE` file naming the target folder it was made from. It sits next to the
//! sub holders so it is on their volume (a hardlink cannot cross volumes), and
//! `build_target::sweep_idle` only reads `sub-*` folders, so it is never swept.
//!
//! **What may be shared, measured 2026-11-16 with cargo 1.95 on Windows.**
//! cargo and rustc replace a compiled output (`.rlib`, `.rmeta`, `.dll`, `.exe`,
//! `.pdb`) by writing a new file, so a hardlinked one is safe. They write
//! fingerprints, dep-info (`.d`), `invoked.timestamp` and a build script's `output`
//! files IN PLACE: 16 of 64 files of a hardlinked clone changed in the source
//! folder after one rebuild in the clone. So only compiled outputs are hardlinked,
//! and every other file is copied with its mtime kept (cargo compares mtimes).
//! A build script's `output` file names its `out` folder by absolute path
//! (`cargo:rustc-link-search=native=<target>/debug/build/ring-<h>/out`), which is
//! the donor's, so a seeded copy has that prefix rewritten to the sub's own folder,
//! or a relink after the donor's folder was deleted would look for a library that is
//! gone.
//!
//! Only third-party units go in (packages with a `registry+` or `git+` source in
//! `Cargo.lock`; a `deps/` file is third-party when its `.d` lists sources under
//! the cargo registry or git checkouts, all of them of a version the lock names):
//! the project's own crates carry the tree's path in their hash and rebuild anyway,
//! and `incremental/` is private by nature. A donor seeded from an older base still
//! holds the units of a version before a dependency bump, and those stay out, so the
//! base's size follows the dependency tree and not its age.
//!
//! Every failure here is a skip: a missing or broken base, a Cargo.lock that cannot
//! be read or a link that fails leaves the sub with an empty `target` that it builds
//! privately, as before.

use super::worktree::is_link;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// The base's folder name inside `<repo>/.claude/worktrees`.
pub(super) const BASE_DIR: &str = ".build-base";
const NEW_DIR: &str = ".build-base.new";
const OLD_DIR: &str = ".build-base.old";
const SOURCE_FILE: &str = "SOURCE";
/// The only cargo profile folder shared: `cargo build`, `check` and `test` all use it.
const PROFILE: &str = "debug";

/// A base older than this is replaced by the next finished sub's build that
/// passes the size gates, so a dependency bump reaches new subs within a week. A donor that was itself seeded
/// from the old base still holds the old units, which `plan` leaves out when their
/// version is not the one `Cargo.lock` names.
const BASE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// A recent base is still replaced by a donor holding at least this many times its
/// `deps` files.
const THIN_BASE_FACTOR: usize = 2;

/// A donor with fewer shared outputs than this built too little to be a base (a
/// sub that only ran `cargo check` on one crate).
const MIN_SHARED: usize = 20;

/// Output kinds rustc and the linker create as new files, so sharing one by
/// hardlink is safe (measured). Everything else is copied.
const LINKED_EXTS: [&str; 9] = ["rlib", "rmeta", "dll", "lib", "pdb", "exe", "so", "dylib", "a"];

/// Files of a build script's run folder that name the donor's folders.
const PATH_FILES: [&str; 2] = ["output", "root-output"];

/// Threads that link and copy one folder's files at once.
const MAX_WORKERS: usize = 8;

/// One lock for every promote and seed: a seed never reads a base that is being
/// swapped, and two finishes never build `.build-base.new` at once.
static BASE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, PartialEq)]
pub(super) struct Counts {
    pub linked: usize,
    pub copied: usize,
    /// Bytes behind the hardlinks: shared with the base, not new disk use.
    pub linked_bytes: u64,
    pub copied_bytes: u64,
}

#[derive(Debug, PartialEq)]
pub(super) enum Promoted {
    Skipped(&'static str),
    Made(Counts),
}

struct Item {
    /// Relative to the target folder, e.g. `debug/deps/libserde-0123456789abcdef.rlib`.
    rel: PathBuf,
    link: bool,
    /// A build script's `output` file: the donor's folder is rewritten in it.
    rewrite: bool,
    len: u64,
    mtime: Option<SystemTime>,
}

/// The donor's folder replaced by the sub's, in both slash forms cargo writes.
struct Rewrite {
    from_fwd: String,
    from_bs: String,
    to_fwd: String,
    to_bs: String,
}

impl Rewrite {
    fn new(from: &str, to: &Path) -> Rewrite {
        let from_fwd = from.replace('\\', "/");
        let to_fwd = slashed(to);
        Rewrite { from_bs: from_fwd.replace('/', "\\"), to_bs: to_fwd.replace('/', "\\"), from_fwd, to_fwd }
    }

    fn apply(&self, text: &[u8]) -> Vec<u8> {
        let once = replace_bytes(text, self.from_fwd.as_bytes(), self.to_fwd.as_bytes());
        replace_bytes(&once, self.from_bs.as_bytes(), self.to_bs.as_bytes())
    }
}

fn replace_bytes(text: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    if from.is_empty() {
        return text.to_vec();
    }
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text.len() - i >= from.len() && text[i..i + from.len()].eq_ignore_ascii_case(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(text[i]);
            i += 1;
        }
    }
    out
}

/// The path as the sub's `.cargo/config.toml` writes it (`worktree::write_build_config`).
fn slashed(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// What `Cargo.lock` takes from a registry or git.
#[derive(Debug, Default, PartialEq)]
struct Locked {
    /// Package names. A name that any lock also lists as a path package (a workspace
    /// member) is left out of this and of the two sets below.
    names: HashSet<String>,
    /// `name-version` of every registry package: the folder cargo unpacks it to.
    versions: HashSet<String>,
    /// The full commit of every git package; its checkout folder is named by a
    /// prefix of it.
    revs: HashSet<String>,
}

/// The packages `Cargo.lock` takes from a registry or git. `None` when no lock file
/// under `tree` (its root and its direct folders) could be read.
fn third_party_packages(tree: &Path) -> Option<Locked> {
    let mut locks = vec![tree.join("Cargo.lock")];
    if let Ok(entries) = std::fs::read_dir(tree) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && !matches!(name.as_str(), "node_modules" | "target" | "dist") && entry.file_type().is_ok_and(|t| t.is_dir()) {
                locks.push(entry.path().join("Cargo.lock"));
            }
        }
    }
    // (name, version, source) of every package a lock gives a registry or git source.
    let mut external: Vec<(String, String, String)> = Vec::new();
    let mut own = HashSet::new();
    let mut read_any = false;
    for lock in locks {
        let Ok(text) = std::fs::read_to_string(&lock) else { continue };
        read_any = true;
        let (mut name, mut version, mut source) = (None::<String>, String::new(), None::<String>);
        for line in text.lines().chain(std::iter::once("[[package]]")) {
            if line.starts_with('[') {
                if let Some(n) = name.take() {
                    match source.take() {
                        Some(s) => external.push((n, std::mem::take(&mut version), s)),
                        None => {
                            own.insert(n);
                        }
                    }
                }
                (version, source) = (String::new(), None);
            } else if let Some(v) = line.strip_prefix("name = ") {
                name = Some(v.trim().trim_matches('"').to_string());
            } else if let Some(v) = line.strip_prefix("version = ") {
                version = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("source = ") {
                let v = v.trim().trim_matches('"');
                source = (v.starts_with("registry+") || v.starts_with("git+")).then(|| v.to_string());
            }
        }
    }
    let mut locked = Locked::default();
    for (name, version, source) in external.into_iter().filter(|(n, ..)| !own.contains(n)) {
        if source.starts_with("registry+") {
            locked.versions.insert(format!("{name}-{version}"));
        } else if let Some((_, rev)) = source.rsplit_once('#') {
            locked.revs.insert(rev.to_string());
        }
        locked.names.insert(name);
    }
    read_any.then_some(locked)
}

/// `ring-6e84a78cb6755c07` -> `ring`: cargo names a package's folders
/// `<package>-<16 hex digits>`.
fn package_of(dir_name: &str) -> Option<&str> {
    let (pkg, hash) = dir_name.rsplit_once('-')?;
    (hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(pkg)
}

/// The key a unit goes by in every folder of a target: its hash. A `.fingerprint`
/// folder is named after the package (`serde-untagged`, `rustls-webpki`), a `deps/`
/// file after the library's crate (`serde_untagged`, `webpki`), and the two differ by
/// more than `-` against `_`, but the hash is one per unit and the same in both.
fn unit_key(name_hash: &str) -> String {
    name_hash.rsplit_once('-').map_or(name_hash, |(_, hash)| hash).to_string()
}

/// Which units of a donor are third-party and still the versions the lock names.
struct ThirdParty<'a> {
    locked: &'a Locked,
    /// The donor's `debug` folder.
    profile: PathBuf,
}

impl ThirdParty<'_> {
    /// Whether the lock names a package of this name at all.
    fn dir_ok(&self, name: &str) -> bool {
        package_of(name).is_some_and(|p| self.locked.names.contains(p))
    }

    /// Whether the sources a dep-info text lists are third-party ones of the versions
    /// the lock names: at least one registry or git source, and none of another
    /// version (a unit built before a dependency bump names the old folder). Only a
    /// source followed by a `/` counts, so the end of a text read short cannot make a
    /// whole version look different.
    fn sources_locked(&self, text: &str) -> bool {
        let text = text.replace('\\', "/");
        let (mut found, mut stale) = (false, false);
        for (at, marker) in text.match_indices("/registry/src/") {
            let mut parts = text[at + marker.len()..].splitn(3, '/');
            if let (Some(_index), Some(package), Some(_rest)) = (parts.next(), parts.next(), parts.next()) {
                found = true;
                stale |= !self.locked.versions.contains(package);
            }
        }
        for (at, marker) in text.match_indices("/git/checkouts/") {
            let mut parts = text[at + marker.len()..].splitn(3, '/');
            if let (Some(_repo), Some(rev), Some(_rest)) = (parts.next(), parts.next(), parts.next()) {
                found = true;
                stale |= rev.len() < 7 || !self.locked.revs.iter().any(|full| full.starts_with(rev));
            }
        }
        found && !stale
    }

    /// The unit (`name-hash`, as a `.d` file is named) a `deps/` file belongs to when
    /// that unit's dep-info lists locked third-party sources. A unit with no `.d` (a
    /// binary copied up from the project's own crate) is not shared.
    fn dep_unit(&self, file: &str) -> Option<String> {
        let base = file.split('.').next().unwrap_or(file);
        let mut candidates = vec![base];
        if let Some(rest) = base.strip_prefix("lib") {
            candidates.push(rest);
        }
        candidates.into_iter().find(|c| read_head(&self.profile.join("deps").join(format!("{c}.d")), 8192).is_ok_and(|text| self.sources_locked(text.split_once(".d: ").map_or("", |(_, rest)| rest)))).map(str::to_string)
    }

    /// Whether the build script that `build/<name>` holds the compiled form of is
    /// the version the lock names, from the dep-info rustc left beside it. `None`
    /// when the folder has none.
    fn compiled_script_locked(&self, name: &str) -> Option<bool> {
        let dir = self.profile.join("build").join(name);
        let (_, path, _) = entries(&dir).into_iter().find(|(file, _, meta)| meta.is_file() && file.ends_with(".d"))?;
        let text = read_head(&path, 8192).ok()?;
        Some(self.sources_locked(text.split_once(".d: ").map_or("", |(_, rest)| rest)))
    }

    /// Whether the run of a build script (`run_json`, in its `.fingerprint` folder)
    /// is of a locked version: the run fingerprint names the fingerprint hash of the
    /// compiled script it ran, which is the content of that script's own fingerprint
    /// file (as little-endian hex), and the compiled script's dep-info names the
    /// version. `None` when any link of that chain is missing.
    fn run_script_locked(&self, run_json: &Path, compiled: &HashMap<String, String>) -> Option<bool> {
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(run_json).ok()?).ok()?;
        // A run of a script whose package has a `links` dependency lists that
        // dependency's script run as well, so the dep to follow is the one that is a
        // compiled script of this base, not the first named like one.
        let compiled_name = json["deps"].as_array()?.iter().filter(|d| d[1].as_str().is_some_and(|n| n.starts_with("build_script"))).find_map(|d| {
            let hash: String = d[3].as_u64()?.to_le_bytes().iter().map(|b| format!("{b:02x}")).collect();
            compiled.get(&hash)
        })?;
        self.compiled_script_locked(compiled_name)
    }

    /// The `.fingerprint` folders to keep: a library's when one of its outputs is a
    /// kept unit of `deps/` (`units`), a build script's when its dep-info names a
    /// locked version, and a script run's when the script it ran does. A folder whose
    /// version cannot be told stays, as every folder of a locked name did before.
    fn fingerprints(&self, units: &HashSet<String>) -> HashSet<String> {
        let fingerprint = self.profile.join(".fingerprint");
        let dirs: Vec<(String, PathBuf, Vec<String>)> = entries(&fingerprint)
            .into_iter()
            .filter(|(name, _, meta)| meta.is_dir() && self.dir_ok(name))
            .map(|(name, path, _)| {
                let files = entries(&path).into_iter().map(|(file, ..)| file).collect();
                (name, path, files)
            })
            .collect();
        let is_compiled_script = |f: &String| f.starts_with("build-script-") && !f.ends_with(".json");
        let compiled: HashMap<String, String> = dirs
            .iter()
            .filter_map(|(name, path, files)| {
                let file = files.iter().find(|f| is_compiled_script(f))?;
                Some((std::fs::read_to_string(path.join(file)).ok()?.trim().to_string(), name.clone()))
            })
            .collect();
        dirs.iter()
            .filter(|(name, path, files)| {
                let verdict = if let Some(run) = files.iter().find(|f| f.starts_with("run-build-script-") && f.ends_with(".json")) {
                    self.run_script_locked(&path.join(run), &compiled)
                } else if files.iter().any(is_compiled_script) {
                    self.compiled_script_locked(name)
                } else {
                    Some(units.contains(&unit_key(name)))
                };
                verdict.unwrap_or(true)
            })
            .map(|(name, ..)| name.clone())
            .collect()
    }
}

fn read_head(path: &Path, max: usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(path)?.take(max as u64).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn has_linked_ext(name: &str) -> bool {
    Path::new(name).extension().and_then(|e| e.to_str()).is_some_and(|e| LINKED_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn entries(dir: &Path) -> Vec<(String, PathBuf, std::fs::Metadata)> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    read.flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            (!is_link(&meta)).then(|| (e.file_name().to_string_lossy().into_owned(), e.path(), meta))
        })
        .collect()
}

/// Every file under `dir` as an item named `prefix/...`. `top_link`: files directly
/// in `dir` of a linked kind are hardlinked, deeper ones are copied.
fn collect(dir: &Path, prefix: &Path, top_link: bool, path_files: bool, out: &mut Vec<Item>) {
    for (name, path, meta) in entries(dir) {
        let rel = prefix.join(&name);
        if meta.is_dir() {
            collect(&path, &rel, false, false, out);
        } else {
            out.push(Item {
                rel,
                link: top_link && has_linked_ext(&name),
                rewrite: path_files && PATH_FILES.contains(&name.as_str()),
                len: meta.len(),
                mtime: meta.modified().ok(),
            });
        }
    }
}

/// What to take from `src_target`'s `debug` folder: every `deps` file, `.fingerprint`
/// folder and `build` folder, or with a filter only the third-party ones.
fn plan(src_target: &Path, filter: Option<&ThirdParty>) -> Result<Vec<Item>, String> {
    let profile = src_target.join(PROFILE);
    if !profile.is_dir() {
        return Err(format!("{} has no {PROFILE} folder", src_target.display()));
    }
    let mut items = Vec::new();
    // The units of `deps/` that are kept, so the folders of other versions of a
    // package go with their outputs.
    let mut units = HashSet::new();
    let deps = profile.join("deps");
    for (name, _, meta) in entries(&deps) {
        if !meta.is_file() {
            continue;
        }
        if let Some(f) = filter {
            let Some(unit) = f.dep_unit(&name) else { continue };
            units.insert(unit_key(&unit));
        }
        items.push(Item {
            rel: Path::new(PROFILE).join("deps").join(&name),
            link: has_linked_ext(&name),
            rewrite: false,
            len: meta.len(),
            mtime: meta.modified().ok(),
        });
    }
    let kept_fingerprints = filter.map(|f| f.fingerprints(&units));
    for (name, path, meta) in entries(&profile.join(".fingerprint")) {
        if meta.is_dir() && kept_fingerprints.as_ref().is_none_or(|k| k.contains(&name)) {
            collect(&path, &Path::new(PROFILE).join(".fingerprint").join(&name), false, false, &mut items);
        }
    }
    for (name, path, meta) in entries(&profile.join("build")) {
        // A build folder goes with the fingerprint folder of its name; one with no
        // fingerprint folder is judged by its package name.
        let keep = match (&kept_fingerprints, filter) {
            (Some(kept), Some(f)) => if profile.join(".fingerprint").join(&name).is_dir() { kept.contains(&name) } else { f.dir_ok(&name) },
            _ => true,
        };
        if meta.is_dir() && keep {
            collect(&path, &Path::new(PROFILE).join("build").join(&name), true, true, &mut items);
        }
    }
    Ok(items)
}

/// Makes every item of `items` under `dst_target`, from `src_target`: hardlinks for
/// the linked ones, copies (mtime kept) for the rest, the donor's path rewritten in
/// the `rewrite` ones when a rewrite is given.
///
/// Run on up to [`MAX_WORKERS`] threads: creating a file on Windows is latency
/// bound (7000 files took 11 to 16 seconds one after the other, 2026-11-16), and
/// the items are independent.
fn apply(src_target: &Path, dst_target: &Path, items: &[Item], rewrite: Option<&Rewrite>) -> Result<Counts, String> {
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, MAX_WORKERS);
    let per_worker = items.len().div_ceil(workers).max(1);
    let parts: Vec<Result<Counts, String>> = std::thread::scope(|scope| {
        let running: Vec<_> = items.chunks(per_worker).map(|part| scope.spawn(move || apply_some(src_target, dst_target, part, rewrite))).collect();
        running.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("a copy thread panicked".to_string()))).collect()
    });
    let mut counts = Counts::default();
    for part in parts {
        let part = part?;
        counts.linked += part.linked;
        counts.copied += part.copied;
        counts.linked_bytes += part.linked_bytes;
        counts.copied_bytes += part.copied_bytes;
    }
    Ok(counts)
}

fn apply_some(src_target: &Path, dst_target: &Path, items: &[Item], rewrite: Option<&Rewrite>) -> Result<Counts, String> {
    let mut counts = Counts::default();
    for item in items {
        let from = src_target.join(&item.rel);
        let to = dst_target.join(&item.rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        if item.link {
            std::fs::hard_link(&from, &to).map_err(|e| format!("could not link {}: {e}", from.display()))?;
            counts.linked += 1;
            counts.linked_bytes += item.len;
            continue;
        }
        match rewrite.filter(|_| item.rewrite) {
            Some(rw) => {
                let text = std::fs::read(&from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
                std::fs::write(&to, rw.apply(&text)).map_err(|e| format!("could not write {}: {e}", to.display()))?;
            }
            None => {
                std::fs::copy(&from, &to).map_err(|e| format!("could not copy {}: {e}", from.display()))?;
            }
        }
        // cargo decides freshness by comparing mtimes, so a copy keeps its source's.
        if let Some(t) = item.mtime {
            if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&to) {
                let _ = f.set_modified(t);
            }
        }
        counts.copied += 1;
        counts.copied_bytes += item.len;
    }
    Ok(counts)
}

/// Seeds the empty build folder `target` of a new sub from the base under
/// `worktrees_root`. `Ok(None)` when there is no base or `target` already holds
/// something; `Err` after removing what it had made, so the sub builds privately.
pub(super) fn seed(worktrees_root: &Path, target: &Path) -> Result<Option<Counts>, String> {
    let _held = BASE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let base = worktrees_root.join(BASE_DIR);
    let Ok(source) = std::fs::read_to_string(base.join(SOURCE_FILE)) else { return Ok(None) };
    if std::fs::read_dir(target).is_ok_and(|mut d| d.next().is_some()) {
        return Ok(None);
    }
    let made = plan(&base, None).and_then(|items| apply(&base, target, &items, Some(&Rewrite::new(source.trim(), target))));
    match made {
        Ok(counts) => Ok(Some(counts)),
        Err(e) => {
            let left = std::fs::remove_dir_all(target).err().filter(|_| target.exists());
            Err(match left {
                Some(why) => format!("{e}; and its half-made folder could not be removed: {why}"),
                None => e,
            })
        }
    }
}

/// The donor's target folder exactly as its `.cargo/config.toml` gave it to cargo,
/// which is the string cargo wrote into build-script output (`slashed(target)` is
/// the fallback). Case and `\?\` forms can differ from the holder path the caller
/// holds, and a rewrite that matches nothing would leave a seeded folder pointing
/// into the donor's, which is deleted right after.
fn donor_target(holder: &Path, target: &Path) -> String {
    let from_config = std::fs::read_to_string(holder.join(".cargo").join("config.toml")).ok().and_then(|text| {
        let line = text.lines().find_map(|l| l.trim().strip_prefix("target-dir"))?;
        let quoted = line.trim_start().strip_prefix('=')?.trim().strip_prefix('"')?;
        Some(quoted.split('"').next()?.to_string())
    });
    from_config.filter(|p| !p.is_empty()).unwrap_or_else(|| slashed(target))
}

/// Makes the base from a finished sub's build folder before that folder is deleted
/// (`build_target::free`). Skipped when the base is younger than [`BASE_MAX_AGE`]
/// and the donor holds under [`THIN_BASE_FACTOR`] times its `deps` files, when the
/// holder's tree has no readable `Cargo.lock`, or when the donor built less than
/// half of, or fewer than [`MIN_SHARED`] shared files against, a base that is
/// already there. `now` is a parameter for the tests.
pub(super) fn promote(holder: &Path, now: SystemTime) -> Result<Promoted, String> {
    let Some(root) = holder.parent().filter(|r| r.ends_with(".claude/worktrees")) else {
        return Ok(Promoted::Skipped("the holder is not under a repo's .claude/worktrees"));
    };
    let target = holder.join("target");
    let Some(locked) = third_party_packages(&holder.join("tree")) else {
        return Ok(Promoted::Skipped("no readable Cargo.lock in the sub's tree"));
    };
    let _held = BASE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let base = root.join(BASE_DIR);
    // A SOURCE stamped in the future (a clock that moved back) counts as brand new, never as no base.
    let base_age = std::fs::metadata(base.join(SOURCE_FILE)).and_then(|m| m.modified()).ok().map(|m| now.duration_since(m).unwrap_or(Duration::ZERO));
    let recent = base_age.is_some_and(|age| age < BASE_MAX_AGE);
    let fresh = root.join(NEW_DIR);
    let _ = std::fs::remove_dir_all(&fresh);
    // An old base a failed delete left behind never blocks the next swap: each swap names its own.
    if let Ok(read) = std::fs::read_dir(root) {
        for left in read.flatten().filter(|e| e.file_name().to_string_lossy().starts_with(OLD_DIR)) {
            let _ = std::fs::remove_dir_all(left.path());
        }
    }
    let old_deps = entries(&base.join(PROFILE).join("deps")).len();
    // A recent base is kept unless it is thin: the first donor to finish wins when no base exists, and
    // a sub that built little must not hold the place for a week against one that built everything.
    // The donor's raw file count bounds its third-party count from above, so a donor under the bar
    // is turned away before `plan` reads every dep-info file (this runs under the lock a seed waits on).
    if recent && entries(&target.join(PROFILE).join("deps")).len() < old_deps * THIN_BASE_FACTOR {
        return Ok(Promoted::Skipped("the base is recent"));
    }
    let filter = ThirdParty { locked: &locked, profile: target.join(PROFILE) };
    let items = match plan(&target, Some(&filter)) {
        Ok(items) => items,
        // A holder that never built has nothing to say about a recent base that has no deps either.
        Err(_) if recent => return Ok(Promoted::Skipped("the base is recent")),
        Err(e) => return Err(e),
    };
    // Decided from the plan, before a single file is linked or copied.
    let shared = items.iter().filter(|i| i.link).count();
    let donor_deps = items.iter().filter(|i| i.rel.starts_with(Path::new(PROFILE).join("deps"))).count();
    if recent && donor_deps < old_deps * THIN_BASE_FACTOR {
        return Ok(Promoted::Skipped("the base is recent"));
    }
    if shared < MIN_SHARED || (base_age.is_some() && donor_deps < old_deps / 2) {
        return Ok(Promoted::Skipped("the build holds too little to replace or make a base"));
    }
    let counts = match apply(&target, &fresh, &items, None) {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&fresh);
            return Err(e);
        }
    };
    let finished = std::fs::write(fresh.join(SOURCE_FILE), donor_target(holder, &target)).and_then(|()| {
        let old = root.join(format!("{OLD_DIR}-{}", now.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_nanos())));
        if base.exists() {
            std::fs::rename(&base, &old)?;
        }
        std::fs::rename(&fresh, &base).inspect_err(|_| {
            let _ = std::fs::rename(&old, &base);
        })?;
        let _ = std::fs::remove_dir_all(&old);
        Ok(())
    });
    match finished {
        Ok(()) => Ok(Promoted::Made(counts)),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&fresh);
            Err(format!("could not put the new base in place: {e}"))
        }
    }
}

#[cfg(test)]
mod tests;
