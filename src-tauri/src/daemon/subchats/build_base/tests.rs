use super::*;
use std::time::UNIX_EPOCH;

const RING: &str = "ring-aaaaaaaaaaaaaaaa";
const OWN: &str = "mycrate-bbbbbbbbbbbbbbbb";
const DAY: Duration = Duration::from_secs(24 * 3600);

fn put(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

fn append(path: &Path, bytes: &[u8]) {
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(bytes).unwrap();
}

fn set_mtime(path: &Path, t: SystemTime) {
    std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(t).unwrap();
}

fn mtime(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}

/// `<root>/.claude/worktrees`.
fn worktrees(root: &Path) -> PathBuf {
    root.join(".claude").join("worktrees")
}

fn forward(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// A finished sub's holder with a tree whose Cargo.lock names `registry_units`
/// registry crates (`dep0` ...), `ring` and its own `mycrate`, and a build folder
/// as cargo leaves it: a unit of each kind, one of the project's own, an
/// incremental folder and a binary copied up from the project's crate.
fn donor(root: &Path, tag: &str, registry_units: usize) -> PathBuf {
    let holder = worktrees(root).join(format!("sub-{tag}"));
    put(&holder.join(".cargo").join("config.toml"), b"[build]\n");
    let mut lock = String::from("version = 4\n\n[[package]]\nname = \"mycrate\"\nversion = \"0.1.0\"\n\n");
    lock.push_str("[[package]]\nname = \"ring\"\nversion = \"0.17.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n");
    let target = holder.join("target");
    let debug = target.join("debug");
    let registry = "C:\\Users\\u\\.cargo\\registry\\src\\index.crates.io-1\\";
    for i in 0..registry_units {
        lock.push_str(&format!("[[package]]\nname = \"dep{i}\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n"));
        let unit = format!("dep{i}-{:016x}", i + 1);
        put(&debug.join("deps").join(format!("lib{unit}.rlib")), format!("rlib {i}").as_bytes());
        put(&debug.join("deps").join(format!("lib{unit}.rmeta")), b"rmeta");
        put(&debug.join("deps").join(format!("{unit}.d")), format!("{}\\debug\\deps\\{unit}.d: {registry}dep{i}-1.0.0\\src\\lib.rs\n", target.display()).as_bytes());
        put(&debug.join(".fingerprint").join(&unit).join(format!("lib-dep{i}.json")), b"{}");
    }
    put(&holder.join("tree").join("src-tauri").join("Cargo.lock"), lock.as_bytes());
    // The ring build script: compiled folder, then the run folder whose output names its `out` by absolute path.
    let out = format!("{}/debug\\build\\{RING}\\out", forward(&target));
    put(&debug.join("build").join(RING).join("output"), format!("cargo:rustc-link-search=native={out}\ncargo:rerun-if-changed=build.rs\n").as_bytes());
    put(&debug.join("build").join(RING).join("root-output"), format!("{}\\debug\\build\\{RING}\\out", target.display()).as_bytes());
    put(&debug.join("build").join(RING).join("out").join("ring_core.lib"), b"static lib");
    put(&debug.join("build").join(RING).join("build_script_build-aaaaaaaaaaaaaaaa.exe"), b"build script");
    put(&debug.join("build").join(RING).join("invoked.timestamp"), b"");
    put(&debug.join(".fingerprint").join(RING).join("run-build-script-build-script-build.json"), b"{}");
    put(&debug.join(".fingerprint").join(RING).join("run-build-script-build-script-build"), b"abc");
    // The project's own crate and its leftovers: none of these may be shared.
    put(&debug.join("deps").join(format!("libmycrate-{}.rlib", &OWN[8..])), b"own rlib");
    put(&debug.join("deps").join(format!("mycrate-{}.d", &OWN[8..])), b"x.d: C:\\repo\\src-tauri\\src\\lib.rs\n");
    put(&debug.join("deps").join("mycrate.exe"), b"own exe");
    put(&debug.join("mycrate.exe"), b"own exe");
    put(&debug.join(".fingerprint").join(OWN).join("lib-mycrate.json"), b"{}");
    put(&debug.join("build").join(OWN).join("output"), b"x");
    put(&debug.join("incremental").join("mycrate-1").join("s-1.bin"), b"incremental");
    holder
}

fn promote_now(holder: &Path) -> Promoted {
    promote(holder, SystemTime::now()).unwrap()
}

fn made(holder: &Path) -> Counts {
    match promote_now(holder) {
        Promoted::Made(c) => c,
        other => panic!("expected a base, got {other:?}"),
    }
}

fn exists_under(base: &Path, rel: &str) -> bool {
    base.join(rel).exists()
}

#[test]
fn the_base_holds_only_third_party_units_and_shares_their_compiled_files() {
    let dir = tempfile::tempdir().unwrap();
    let holder = donor(dir.path(), "aaaa", 25);
    let counts = made(&holder);
    let base = worktrees(dir.path()).join(BASE_DIR);
    assert_eq!(counts.linked, 25 * 2 + 1, "the rlib and rmeta of 25 units and ring's build script exe; its out/ring_core.lib is deeper, so a copy");
    for needed in [
        "debug/deps/libdep3-0000000000000004.rlib",
        "debug/deps/dep3-0000000000000004.d",
        "debug/.fingerprint/dep3-0000000000000004/lib-dep3.json",
        "debug/build/ring-aaaaaaaaaaaaaaaa/output",
        "debug/build/ring-aaaaaaaaaaaaaaaa/out/ring_core.lib",
        "debug/build/ring-aaaaaaaaaaaaaaaa/build_script_build-aaaaaaaaaaaaaaaa.exe",
        "debug/.fingerprint/ring-aaaaaaaaaaaaaaaa/run-build-script-build-script-build.json",
        SOURCE_FILE,
    ] {
        assert!(exists_under(&base, needed), "{needed} is missing");
    }
    for own in ["debug/deps/mycrate.exe", "debug/mycrate.exe", "debug/incremental", "debug/build/mycrate-bbbbbbbbbbbbbbbb", "debug/.fingerprint/mycrate-bbbbbbbbbbbbbbbb"] {
        assert!(!exists_under(&base, own), "{own} is the project's own and must not be shared");
    }
    assert!(!exists_under(&base, "debug/deps/libmycrate-bbbbbbbbbbbbbbbb.rlib"));
    assert_eq!(std::fs::read_to_string(base.join(SOURCE_FILE)).unwrap(), forward(&holder.join("target")));
}

#[test]
fn a_compiled_file_is_one_file_and_a_small_file_is_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let holder = donor(dir.path(), "aaaa", 25);
    made(&holder);
    let base = worktrees(dir.path()).join(BASE_DIR);
    let target = holder.join("target").join("debug");
    // A hardlink shows a write through either name; a copy does not. cargo writes fingerprints in place, so they must be copies.
    append(&base.join("debug/deps/libdep3-0000000000000004.rlib"), b"!");
    assert!(read(&target.join("deps/libdep3-0000000000000004.rlib")).ends_with(b"!"), "the compiled file is shared");
    append(&base.join("debug/.fingerprint/dep3-0000000000000004/lib-dep3.json"), b"!");
    assert_eq!(read(&target.join(".fingerprint/dep3-0000000000000004/lib-dep3.json")), b"{}", "a fingerprint is a copy, so cargo's in-place write cannot reach the donor");
    // The same for the other files cargo rewrites in place (2026-11-16: 16 of 64 files of a fully hardlinked clone changed in the donor).
    for rewritten in ["debug/deps/dep3-0000000000000004.d", "debug/build/ring-aaaaaaaaaaaaaaaa/output", "debug/build/ring-aaaaaaaaaaaaaaaa/invoked.timestamp", "debug/build/ring-aaaaaaaaaaaaaaaa/out/ring_core.lib"] {
        let before = read(&target.join(rewritten.trim_start_matches("debug/")));
        append(&base.join(rewritten), b"!");
        assert_eq!(read(&target.join(rewritten.trim_start_matches("debug/"))), before, "{rewritten} must be a copy");
    }
}

#[test]
fn a_seeded_folder_shares_compiled_files_keeps_mtimes_and_points_at_itself() {
    let dir = tempfile::tempdir().unwrap();
    let holder = donor(dir.path(), "aaaa", 25);
    let old = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    set_mtime(&holder.join("target/debug/build").join(RING).join("output"), old);
    set_mtime(&holder.join("target/debug/.fingerprint/dep3-0000000000000004/lib-dep3.json"), old);
    made(&holder);

    let sub = worktrees(dir.path()).join("sub-bbbb");
    std::fs::create_dir_all(&sub).unwrap();
    let target = sub.join("target");
    let counts = seed(&worktrees(dir.path()), &target).unwrap().expect("a base exists");
    assert_eq!(counts.linked, 25 * 2 + 1, "the same compiled files the base holds");
    let debug = target.join("debug");

    let output = String::from_utf8(read(&debug.join("build").join(RING).join("output"))).unwrap();
    assert!(output.contains(&format!("native={}/debug\\build\\{RING}\\out", forward(&target))), "the link search path names the sub's own folder: {output}");
    assert!(!output.contains("sub-aaaa"), "nothing of the donor's folder is left: {output}");
    let root_output = String::from_utf8(read(&debug.join("build").join(RING).join("root-output"))).unwrap();
    assert!(root_output.contains("sub-bbbb") && !root_output.contains("sub-aaaa"), "{root_output}");
    assert_eq!(mtime(&debug.join("build").join(RING).join("output")), old, "cargo compares this mtime with rerun-if-changed files");
    assert_eq!(mtime(&debug.join(".fingerprint/dep3-0000000000000004/lib-dep3.json")), old);
    assert!(debug.join("build").join(RING).join("out").join("ring_core.lib").is_file(), "the static library the link search path points at is in the sub's folder");

    let base = worktrees(dir.path()).join(BASE_DIR);
    append(&base.join("debug/deps/libdep3-0000000000000004.rlib"), b"!");
    assert!(read(&debug.join("deps/libdep3-0000000000000004.rlib")).ends_with(b"!"));
    std::fs::write(debug.join(".fingerprint/dep3-0000000000000004/lib-dep3.json"), b"rewritten").unwrap();
    assert_eq!(read(&base.join("debug/.fingerprint/dep3-0000000000000004/lib-dep3.json")), b"{}", "a rewrite in the sub leaves the base alone");
}

#[test]
fn deleting_the_donor_leaves_the_base_and_a_seeded_sub_whole() {
    let dir = tempfile::tempdir().unwrap();
    let holder = donor(dir.path(), "aaaa", 25);
    made(&holder);
    let sub_target = worktrees(dir.path()).join("sub-bbbb").join("target");
    seed(&worktrees(dir.path()), &sub_target).unwrap().unwrap();
    std::fs::remove_dir_all(holder.join("target")).unwrap();
    assert_eq!(read(&sub_target.join("debug/deps/libdep3-0000000000000004.rlib")), b"rlib 3");
    assert_eq!(read(&worktrees(dir.path()).join(BASE_DIR).join("debug/deps/libdep3-0000000000000004.rlib")), b"rlib 3");
}

#[test]
fn without_a_base_or_with_a_used_folder_nothing_is_seeded() {
    let dir = tempfile::tempdir().unwrap();
    let target = worktrees(dir.path()).join("sub-cccc").join("target");
    assert_eq!(seed(&worktrees(dir.path()), &target), Ok(None));
    assert!(!target.exists(), "no base: the folder is not even created, cargo makes it");

    made(&donor(dir.path(), "aaaa", 25));
    put(&target.join("debug").join("mine"), b"already building here");
    assert_eq!(seed(&worktrees(dir.path()), &target), Ok(None));
    assert_eq!(read(&target.join("debug").join("mine")), b"already building here");
    assert!(!target.join("debug").join("deps").exists());
}

#[test]
fn a_seed_that_fails_removes_what_it_made_and_reports_it() {
    let dir = tempfile::tempdir().unwrap();
    made(&donor(dir.path(), "aaaa", 25));
    let root = worktrees(dir.path());
    // A base whose profile folder is gone.
    std::fs::remove_dir_all(root.join(BASE_DIR).join("debug")).unwrap();
    let target = root.join("sub-dddd").join("target");
    let err = seed(&root, &target).unwrap_err();
    assert!(err.contains("no debug folder"), "{err}");
    assert!(!target.exists());

    // A file the copy cannot read (held by another process with no sharing).
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let other = tempfile::tempdir().unwrap();
        made(&donor(other.path(), "aaaa", 25));
        let root = worktrees(other.path());
        let locked = root.join(BASE_DIR).join("debug/.fingerprint/dep3-0000000000000004/lib-dep3.json");
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&locked).unwrap();
        let target = root.join("sub-eeee").join("target");
        let err = seed(&root, &target).unwrap_err();
        assert!(err.contains("could not copy"), "{err}");
        assert!(!target.exists(), "half a seed is never left for cargo to trust");
    }
}

#[test]
fn a_young_base_is_kept_and_an_old_one_is_replaced_by_a_bigger_build() {
    let dir = tempfile::tempdir().unwrap();
    let first = donor(dir.path(), "aaaa", 25);
    made(&first);
    let base = worktrees(dir.path()).join(BASE_DIR);
    let second = donor(dir.path(), "bbbb", 40);
    assert_eq!(promote_now(&second), Promoted::Skipped("the base is recent"));
    assert!(!exists_under(&base, "debug/deps/libdep29-000000000000001e.rlib"));

    // A base stamped in the future (the clock moved back) is new, not absent.
    assert_eq!(promote(&second, SystemTime::now() - 2 * DAY).unwrap(), Promoted::Skipped("the base is recent"));

    // An old base a failed delete left behind does not stop the swap, and goes.
    let stuck = worktrees(dir.path()).join(format!("{OLD_DIR}-1"));
    put(&stuck.join("debug").join("x"), b"x");
    let in_a_week = SystemTime::now() + 8 * DAY;
    let Promoted::Made(_) = promote(&second, in_a_week).unwrap() else { panic!("an old base is replaced") };
    assert!(!stuck.exists());
    assert!(exists_under(&base, "debug/deps/libdep29-000000000000001e.rlib"));
    assert_eq!(std::fs::read_to_string(base.join(SOURCE_FILE)).unwrap(), forward(&second.join("target")));
    assert!(!worktrees(dir.path()).join(NEW_DIR).exists(), "no half-made folder is left");
    let leftovers = std::fs::read_dir(worktrees(dir.path())).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(OLD_DIR)).count();
    assert_eq!(leftovers, 0);

    // A build that holds under half of what the base does never replaces it, however old the base is.
    let thin = donor(dir.path(), "cccc", 12);
    assert_eq!(promote(&thin, in_a_week + 9 * DAY).unwrap(), Promoted::Skipped("the build holds too little to replace or make a base"));
    assert!(exists_under(&base, "debug/deps/libdep29-000000000000001e.rlib"), "the bigger base stays");
}

/// The first sub to finish makes the base, so a sub that built little must not hold the place for a
/// week against one that built everything.
#[test]
fn a_young_thin_base_is_replaced_by_a_build_with_twice_its_files_and_by_nothing_smaller() {
    let dir = tempfile::tempdir().unwrap();
    let first = donor(dir.path(), "aaaa", 12);
    made(&first);
    let base = worktrees(dir.path()).join(BASE_DIR);
    assert!(!exists_under(&base, "debug/deps/libdep20-0000000000000015.rlib"));

    let almost = donor(dir.path(), "bbbb", 23);
    assert_eq!(promote_now(&almost), Promoted::Skipped("the base is recent"));
    assert!(!exists_under(&base, "debug/deps/libdep20-0000000000000015.rlib"));

    let full = donor(dir.path(), "cccc", 60);
    made(&full);
    assert!(exists_under(&base, "debug/deps/libdep20-0000000000000015.rlib"));

    // A sub that never built anything has nothing to say about a young base: a skip, not an error.
    let empty = worktrees(dir.path()).join("sub-dddd");
    put(&empty.join("tree").join("src-tauri").join("Cargo.lock"), b"version = 4\n");
    assert_eq!(promote_now(&empty), Promoted::Skipped("the base is recent"));
}

/// The base names the donor's folder as the donor's own `.cargo/config.toml` gave it to cargo, so a
/// caller whose path differs in case still has its seeds rewritten.
#[test]
fn the_donors_folder_is_read_from_its_config_not_from_the_callers_path() {
    let dir = tempfile::tempdir().unwrap();
    let holder = donor(dir.path(), "aaaa", 25);
    let shouted = forward(&holder.join("target")).to_uppercase();
    put(&holder.join(".cargo").join("config.toml"), format!("[build]\ntarget-dir = \"{shouted}\"\n").as_bytes());
    let output = holder.join("target/debug/build").join(RING).join("output");
    put(&output, format!("cargo:rustc-link-search=native={shouted}/debug\\build\\ring\\out\n").as_bytes());
    made(&holder);
    let base = worktrees(dir.path()).join(BASE_DIR);
    assert_eq!(std::fs::read_to_string(base.join(SOURCE_FILE)).unwrap(), shouted);
    let target = worktrees(dir.path()).join("sub-bbbb").join("target");
    seed(&worktrees(dir.path()), &target).unwrap().unwrap();
    let seeded = String::from_utf8(read(&target.join("debug/build").join(RING).join("output"))).unwrap();
    assert!(!seeded.to_uppercase().contains("SUB-AAAA") && seeded.contains("sub-bbbb"), "{seeded}");
}

#[test]
fn a_patch_table_after_the_last_package_does_not_hide_that_package() {
    let dir = tempfile::tempdir().unwrap();
    put(&dir.path().join("Cargo.lock"), b"[[package]]\nname = \"serde\"\nsource = \"registry+x\"\n\n[[patch.unused]]\nname = \"other\"\n");
    let set = third_party_packages(dir.path()).unwrap();
    assert!(set.contains("serde"), "{set:?}");
}

#[test]
fn a_build_that_barely_compiled_never_becomes_the_base() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(promote_now(&donor(dir.path(), "aaaa", 2)), Promoted::Skipped("the build holds too little to replace or make a base"));
    assert!(!worktrees(dir.path()).join(BASE_DIR).exists());
}

#[test]
fn no_readable_lock_file_or_a_holder_outside_worktrees_makes_no_base() {
    let dir = tempfile::tempdir().unwrap();
    let holder = donor(dir.path(), "aaaa", 25);
    std::fs::remove_file(holder.join("tree/src-tauri/Cargo.lock")).unwrap();
    assert_eq!(promote_now(&holder), Promoted::Skipped("no readable Cargo.lock in the sub's tree"));

    let elsewhere = tempfile::tempdir().unwrap();
    let stray = elsewhere.path().join("cargo-target").join("sub-zzzz");
    put(&stray.join("tree").join("Cargo.lock"), b"[[package]]\nname = \"a\"\nsource = \"registry+x\"\n");
    assert!(matches!(promote_now(&stray), Promoted::Skipped(w) if w.contains("not under")));
    assert!(!stray.parent().unwrap().join(BASE_DIR).exists());
}

#[test]
fn a_package_the_lock_lists_as_both_sourced_and_local_is_never_shared() {
    let dir = tempfile::tempdir().unwrap();
    put(
        &dir.path().join("Cargo.lock"),
        b"[[package]]\nname = \"serde\"\nsource = \"registry+x\"\n\n[[package]]\nname = \"kit\"\nsource = \"git+https://example.com/kit\"\n\n[[package]]\nname = \"shared\"\nsource = \"registry+x\"\n",
    );
    put(&dir.path().join("src-tauri").join("Cargo.lock"), b"[[package]]\nname = \"shared\"\n\n[[package]]\nname = \"app\"\n");
    let set = third_party_packages(dir.path()).unwrap();
    assert!(set.contains("serde") && set.contains("kit"));
    assert!(!set.contains("shared") && !set.contains("app"));
    assert_eq!(third_party_packages(&dir.path().join("nothing")), None);
}

#[test]
fn a_build_folders_package_name_comes_off_its_sixteen_digit_hash() {
    assert_eq!(package_of("tauri-plugin-fs-4b0d4fe7fb347e7f"), Some("tauri-plugin-fs"));
    assert_eq!(package_of("ring-6e84a78cb6755c07"), Some("ring"));
    assert_eq!(package_of("ring-6e84a78cb6755c0"), None);
    assert_eq!(package_of("ring"), None);
    assert_eq!(package_of("ring-zzzzzzzzzzzzzzzz"), None);
}

/// Manual measurement on real build folders, not part of any run:
/// `CC_BASE_DONOR=<sub holder> CC_BASE_SEED=<new target folder> cargo test --lib -- --ignored real_folders --nocapture`.
/// Makes the repo's base from the holder, then seeds the folder from it, and prints both times.
#[test]
#[ignore]
fn real_folders() {
    let (Some(holder), Some(seed_to)) = (std::env::var_os("CC_BASE_DONOR"), std::env::var_os("CC_BASE_SEED")) else { return };
    let holder = PathBuf::from(holder);
    let began = std::time::Instant::now();
    let made = promote(&holder, SystemTime::now());
    println!("promote: {made:?} in {:?}", began.elapsed());
    let began = std::time::Instant::now();
    let seeded = seed(holder.parent().unwrap(), Path::new(&seed_to));
    println!("seed: {seeded:?} in {:?}", began.elapsed());
}

#[test]
fn the_donors_folder_is_replaced_in_both_slash_forms_and_nothing_else_changes() {
    let rw = Rewrite::new("C:\\w\\sub-a\\target", Path::new("D:/x/sub-b/target"));
    let text = b"native=C:/w/sub-a/target\\debug\\build\\r\\out\nroot=C:\\w\\sub-a\\target\\debug\nlonger=C:/w/sub-a/targets\n";
    let out = String::from_utf8(rw.apply(text)).unwrap();
    assert!(out.contains("native=D:/x/sub-b/target\\debug\\build\\r\\out"));
    assert!(out.contains("root=D:\\x\\sub-b\\target\\debug"));
    assert!(out.contains("longer=D:/x/sub-b/targets"), "a longer name that starts the same is still a match, so it moves too: {out}");
    assert_eq!(rw.apply(b"no path here"), b"no path here");
    assert_eq!(rw.apply(b"c:/W/SUB-A/Target/x"), b"D:/x/sub-b/target/x", "a path that differs only in case is still the donor's");
}
