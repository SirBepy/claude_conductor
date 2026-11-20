    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::git::test_repo;
    use crate::daemon::subchats::{card_log, held, SubchatArgs, TempDataDir};
    use crate::sessions::chat_config::{self, ChatConfig};
    use crate::types::Settings;

    const TS: &str = "2026-11-05T00:00:00Z";

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn g(dir: &Path, args: &[&str]) {
        test_repo::git(dir, args);
    }

    fn commit_file(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
        g(dir, &["add", name]);
        g(dir, &["commit", "-q", "-m", &format!("edit {name}")]);
    }

    fn brief_json(writes: bool, extra: &str) -> SubchatBrief {
        serde_json::from_str(&format!(r#"{{"parent":"m","task":"t","goal":"g","done_when":"d","writes":{writes},"files":["a.txt"]{extra}}}"#)).unwrap()
    }

    /// A worktree sub of a main chat at `root`, with its row, its stored brief and
    /// a real worktree. Returns the sub's id and its tree.
    fn new_sub(st: &Arc<DaemonState>, tag: &str, root: &Path) -> (String, WorktreeInfo) {
        let sid = uuid::Uuid::new_v4().to_string();
        let Ok(Prepare::Ready(p)) = prepare(root, &sid) else { panic!("a scratch repo can have a worktree") };
        let (parent, id) = (format!("{tag}-main"), sid);
        st.registry.upsert_interactive(&parent, root, "proj", TS);
        st.registry.upsert_interactive(&id, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, tag.to_string());
        let mut brief = brief_json(true, "");
        brief.parent = parent;
        brief.worktree_at = Some(p.info.clone());
        brief.git_head_at_spawn = git::head(Path::new(&p.info.cwd));
        chat_config::set_subchat(&id, Some(brief));
        (id, p.info)
    }

    /// Text with line endings normalised: git on Windows checks files out as CRLF.
    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n")
    }

    /// The exact bytes, for the proof that nobody's uncommitted file was touched.
    fn raw(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap_or_default()
    }

    fn target_of(root: &Path) -> String {
        current_branch(root).unwrap()
    }

    fn blockers(parent: &str) -> Vec<card_log::CardEntry> {
        card_log::read(parent).into_iter().filter(|c| c.kind == card_log::KIND_BLOCKER).collect()
    }

    /// The wakes queued for `parent`, the main chat a plumbing problem goes to.
    fn wakes(st: &DaemonState, parent: &str) -> usize {
        st.repo_channel_wakes.lock().unwrap().get(parent).map_or(0, |q| q.len())
    }

    // ---- when it applies ----------------------------------------------------------

    #[test]
    fn every_writer_gets_a_worktree_and_a_read_only_sub_or_a_gate_does_not() {
        assert!(wants(&brief_json(true, "")), "a writer gets its own tree with no setting and no flag");
        assert!(!wants(&brief_json(false, r#","worktree":true"#)), "a read-only sub stays on the main checkout");
        let mut gate = brief_json(true, r#","worktree":true"#);
        gate.gate = true;
        assert!(!wants(&gate), "a gate pushes from the main checkout");
    }

    #[test]
    fn the_spawn_makes_a_worktree_for_every_writer_and_none_for_a_read_only_sub() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let sid = uuid::Uuid::new_v4().to_string();
        assert!(plan_spawn(&brief_json(false, ""), &root, &sid).unwrap().is_none(), "read-only");
        let made = plan_spawn(&brief_json(true, ""), &root, &sid).unwrap().expect("a writer gets a tree");
        assert!(Path::new(&made.info.path).is_dir());
        let other = uuid::Uuid::new_v4().to_string();
        let second = plan_spawn(&brief_json(true, ""), &root, &other).unwrap().expect("and so does a second writer");
        assert_ne!(made.info.path, second.info.path, "side by side, never queued");
    }

    // ---- carrying a sub's work on (continue_from) -----------------------------------

    #[test]
    fn a_successor_starts_from_a_wip_commit_of_the_old_subs_uncommitted_edits() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (old_id, old) = new_sub(&st, "wipold", &root);
        std::fs::write(Path::new(&old.path).join("half.txt"), "half done\n").unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let made = plan_continue(&brief_json(true, ""), &root, &sid, &old_id).unwrap().expect("a tree");
        assert_ne!(made.info.path, old.path);
        assert_eq!(read(&Path::new(&made.info.path).join("half.txt")), "half done\n", "the edit is in the successor's tree");
        assert_eq!(run(Path::new(&made.info.path), &["log", "-1", "--format=%s"]).out.trim(), WIP_MESSAGE);
        assert!(uncommitted_in(Path::new(&old.path)).is_empty(), "the old tree holds it as a commit, nothing loose");
    }

    #[test]
    fn continuing_a_sub_with_nothing_unmerged_is_the_ordinary_spawn_from_head() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (old_id, _old) = new_sub(&st, "cleanold", &root);
        let sid = uuid::Uuid::new_v4().to_string();
        let made = plan_continue(&brief_json(true, ""), &root, &sid, &old_id).unwrap().expect("a tree");
        let head = run(&root, &["rev-parse", "HEAD"]).out.trim().to_string();
        assert_eq!(made.info.base.as_deref(), Some(head.as_str()));
    }

    #[tokio::test]
    async fn handing_over_ends_the_old_sub_and_removes_its_tree_and_branch_without_a_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (old_id, old) = new_sub(&st, "handold", &root);
        std::fs::write(Path::new(&old.path).join("half.txt"), "half done\n").unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let made = plan_continue(&brief_json(true, ""), &root, &sid, &old_id).unwrap().expect("a tree");
        hand_over(&st, &old_id, &made.info).await;
        assert!(!Path::new(&old.path).exists(), "the old tree is gone");
        assert!(!branch_exists(&root, &old.branch), "and so is its branch: every commit is on the successor's");
        assert!(Path::new(&made.info.path).is_dir(), "the successor keeps its tree");
        assert!(st.registry.get(&old_id).unwrap().ended_at.is_some());
        assert!(blockers("handold-main").is_empty(), "no worktree-kept card for the handed-over work");
    }

    // ---- creating it ----------------------------------------------------------------

    #[test]
    fn a_worktree_is_a_new_branch_off_head_under_the_repo_and_stays_out_of_git_status() {
        let (_d, root) = test_repo::init();
        let sid = "abcdef12-0000";
        let Ok(Prepare::Ready(p)) = prepare(&root, sid) else { panic!("ready") };
        let wt = Path::new(&p.info.path);
        assert!(wt.is_dir());
        assert_eq!(path_key(&p.info.path), path_key(&format!("{}/.claude/worktrees/sub-abcdef12/tree", root.to_string_lossy())));
        assert_eq!(p.info.branch, "sub/abcdef12");
        assert_eq!(p.info.target, target_of(&root));
        assert_eq!(git::head(wt), git::head(&root), "off the current HEAD");
        assert_eq!(current_branch(wt).as_deref(), Some("sub/abcdef12"));
        assert!(run(&root, &["status", "--porcelain"]).out.is_empty(), "the worktree folder is excluded locally: {:?}", run(&root, &["status", "--porcelain"]).out);
        assert_eq!(p.info.cwd, p.info.path, "a project at the repo top runs at the worktree top");
    }

    #[test]
    fn a_worktree_at_a_base_starts_there_not_at_head_and_keeps_the_homes_target_name() {
        let (_d, root) = test_repo::init();
        let base = git::head(&root).unwrap();
        commit_file(&root, "later.txt", "newer than the base\n");
        assert_ne!(git::head(&root).unwrap(), base);
        g(&root, &["checkout", "-q", "--detach"]);
        let Ok(Prepare::Ready(p)) = prepare_at(&root, "abcdef12-0000", &base, "master-of-the-pc") else { panic!("ready") };
        let wt = Path::new(&p.info.path);
        assert_eq!(git::head(wt).as_deref(), Some(base.as_str()), "the tree is at the base, not at the clone's HEAD");
        assert!(!wt.join("later.txt").exists());
        assert_eq!(p.info.base.as_deref(), Some(base.as_str()));
        assert_eq!(p.info.target, "master-of-the-pc", "the home's branch name, which need not exist here and the clone may be detached");
        assert_eq!(p.info.branch, "sub/abcdef12");
        assert_eq!(current_branch(wt).as_deref(), Some("sub/abcdef12"));
        assert!(run(&root, &["status", "--porcelain"]).out.is_empty(), "excluded from git status like any sub tree");
    }

    #[test]
    fn a_worktree_at_a_base_refuses_a_commit_this_clone_lacks_and_anything_that_is_not_a_full_id() {
        let (_d, root) = test_repo::init();
        let absent = "1".repeat(40);
        let err = match prepare_at(&root, "11110000", &absent, "master") {
            Err(e) => e,
            Ok(_) => panic!("a base this clone does not have is refused"),
        };
        assert!(err.contains("not in this clone"), "{err}");
        for not_an_id in ["HEAD", "master", "--help", "abc123", ""] {
            assert!(prepare_at(&root, "22220000", not_an_id, "master").is_err(), "{not_an_id:?} is not a base");
        }
        assert!(!root.join(".claude/worktrees/sub-11110000").exists(), "a refused base leaves nothing behind");
    }

    #[test]
    fn a_project_in_a_subfolder_runs_at_the_same_subfolder_of_its_worktree() {
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("web")).unwrap();
        commit_file(&root, "web/index.html", "<p>hi</p>\n");
        let Ok(Prepare::Ready(p)) = prepare(&root.join("web"), "11112222") else { panic!("ready") };
        assert_eq!(path_key(&p.info.cwd), path_key(&format!("{}/web", p.info.path)));
        assert!(Path::new(&p.info.cwd).join("index.html").is_file());
    }

    #[test]
    fn a_folder_that_cannot_have_a_worktree_falls_back_instead_of_failing() {
        let plain = tempfile::tempdir().unwrap();
        assert!(matches!(prepare(plain.path(), "aaaa0000"), Ok(Prepare::Unusable(w)) if w.contains("not a git repository")));
        let (_d, root) = test_repo::init();
        g(&root, &["checkout", "-q", "--detach"]);
        assert!(matches!(prepare(&root, "bbbb0000"), Ok(Prepare::Unusable(w)) if w.contains("detached")));
    }

    #[test]
    fn the_worktree_is_inside_the_same_project_and_the_checks_accept_it() {
        let (_d, root) = test_repo::init();
        let Ok(Prepare::Ready(p)) = prepare(&root, "cccc0000") else { panic!("ready") };
        assert_eq!(project_key(Path::new(&p.info.cwd)), project_key(&root), "the dashboard, list_peers and the settings lookup group it with the repo");
        assert!(crate::daemon::subchats::spawn::check_same_project(&root, Path::new(&p.info.cwd)).is_ok());
    }

    /// The project dashboard groups chats by project id and `list_peers` reads the
    /// same id: a worktree cwd must land in the repo's project, not a new one.
    #[test]
    fn a_worktree_cwd_registers_under_the_repos_own_project() {
        let (_d, root) = test_repo::init();
        let Ok(Prepare::Ready(p)) = prepare(&root, "ffff0000") else { panic!("ready") };
        let st = state();
        let (main_id, created) = st.settings.upsert_project_for_cwd(&root, TS);
        assert!(created);
        let (tree_id, created_again) = st.settings.upsert_project_for_cwd(Path::new(&p.info.cwd), TS);
        assert_eq!(tree_id, main_id, "one project, so the dashboard groups it and list_peers finds it");
        assert!(!created_again, "no second project row for the worktree");
    }

    #[test]
    fn the_first_message_says_where_the_sub_is_and_what_is_not_covered() {
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        let Ok(Prepare::Ready(p)) = prepare(&root, "dddd0000") else { panic!("ready") };
        assert!(matches!(p.setup, Setup::Junction { .. }));
        let note = first_message_note(&p);
        for needle in ["own git worktree", "sub/dddd0000", &p.info.target, "node_modules is a link", "Python virtual environment", "dev server", "database", "still shared"] {
            assert!(note.contains(needle), "{needle:?} missing: {note}");
        }
        assert!(!note.contains('\u{2014}'));
        let (_d2, bare) = test_repo::init();
        let Ok(Prepare::Ready(q)) = prepare(&bare, "eeee0000") else { panic!("ready") };
        assert_eq!(q.setup, Setup::Nothing);
        assert!(first_message_note(&q).contains("Nothing was set up"));
    }

    #[test]
    fn the_spawn_result_carries_the_worktree_note_once() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let sid = uuid::Uuid::new_v4().to_string();
        let made = plan_spawn(&brief_json(true, ""), &root, &sid).unwrap().unwrap();
        let note = super::super::writers::spawn_note(&st, &sid).expect("the main chat is told");
        assert!(note["note"].as_str().unwrap().contains(&made.info.branch), "{note}");
        assert!(super::super::writers::spawn_note(&st, &sid).is_none(), "said once");
    }

    // ---- merging back ------------------------------------------------------------------

    #[test]
    fn finish_merges_the_commits_and_fast_forwards_the_checked_out_branch_and_its_files() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "merge", &root);
        commit_file(Path::new(&info.path), "a.txt", "from the sub\n");
        let before = git::head(&root).unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_ne!(git::head(&root).unwrap(), before);
        assert_eq!(git::head(&root), git::head(Path::new(&info.path)), "a fast-forward, no merge commit");
        assert_eq!(read(&root.join("a.txt")), "from the sub\n", "the main checkout's files moved with its branch");
        assert!(run(&root, &["status", "--porcelain"]).out.is_empty());
    }

    #[test]
    fn a_peers_dirty_file_elsewhere_does_not_block_the_merge_and_keeps_its_bytes() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "peer", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        std::fs::write(root.join("base.txt"), "someone else is editing this\n").unwrap();
        std::fs::write(root.join("scratch.txt"), "untracked\n").unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(raw(&root.join("base.txt")), b"someone else is editing this\n");
        assert_eq!(raw(&root.join("scratch.txt")), b"untracked\n");
        assert_eq!(read(&root.join("a.txt")), "sub\n");
    }

    #[test]
    fn a_dirty_overlap_refuses_keeps_the_merge_pending_on_the_file_and_clobbers_nothing() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "overlap", &root);
        commit_file(Path::new(&info.path), "base.txt", "the sub's version\n");
        std::fs::write(root.join("base.txt"), "mine, not committed\n").unwrap();
        let head_before = git::head(&root).unwrap();
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("must refuse: {landing:?}") };
        assert_eq!(b.points, vec!["base.txt".to_string()]);
        assert_eq!(raw(&root.join("base.txt")), b"mine, not committed\n", "not a byte of it was touched");
        assert_eq!(git::head(&root).unwrap(), head_before, "the target did not move");
        assert_eq!(count(Path::new(&info.path), &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "the commit is safe");
        assert!(b.text.contains("uncommitted"), "{}", b.text);
        assert!(blockers("overlap-main").is_empty(), "another chat's edit is nobody's card");
        assert_eq!(wakes(&st, "overlap-main"), 0, "and wakes nobody");
        assert_eq!(super::super::pending_merges::get(&id).unwrap().files, vec!["base.txt".to_string()]);
    }

    /// A file git ignores is invisible to the dirty check, so a sub that commits
    /// one at the same path (`git add -f`) used to have its merge overwrite the
    /// local copy silently.
    #[test]
    fn an_ignored_local_file_the_merge_would_overwrite_is_refused_and_keeps_its_bytes() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        commit_file(&root, ".gitignore", "secret.env\n");
        std::fs::write(root.join("secret.env"), "API_KEY=mine\n").unwrap();
        let (id, info) = new_sub(&st, "ignored", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("secret.env"), "API_KEY=the sub's\n").unwrap();
        g(&wt, &["add", "-f", "secret.env"]);
        g(&wt, &["commit", "-q", "-m", "add the env file"]);
        let head_before = git::head(&root).unwrap();
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("must refuse: {landing:?}") };
        assert!(b.points.iter().any(|p| p == "secret.env"), "the card names the file: {b:?}");
        assert_eq!(raw(&root.join("secret.env")), b"API_KEY=mine\n", "not a byte of the ignored file was touched");
        assert_eq!(git::head(&root).unwrap(), head_before, "the target did not move");
        assert_eq!(count(&wt, &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "the commit is safe");
        assert!(blockers("ignored-main").is_empty(), "no card for Joe");
        assert_eq!(wakes(&st, "ignored-main"), 1, "the main chat is handed it");
        assert!(super::super::plumbing::current(&id).unwrap().files.contains(&"secret.env".to_string()));
    }

    #[test]
    fn a_staged_change_in_the_main_checkout_counts_as_dirty_too() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "staged", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub\n");
        std::fs::write(root.join("base.txt"), "staged\n").unwrap();
        g(&root, &["add", "base.txt"]);
        assert!(matches!(land(&id, &info), Landing::Blocked(_)));
        assert_eq!(raw(&root.join("base.txt")), b"staged\n");
    }

    #[test]
    fn a_merge_conflict_keeps_the_commits_draws_no_card_and_a_resolved_finish_merges() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "conflict", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "base.txt", "sub's line\n");
        commit_file(&root, "base.txt", "peer's line\n");
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("conflicts: {landing:?}") };
        assert_eq!(b.verdict, "Merge conflict");
        assert_eq!(b.points, vec!["base.txt".to_string()]);
        assert!(wt.is_dir(), "the worktree stays");
        assert_eq!(count(&wt, &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "its commit is not lost");
        assert!(run(&wt, &["status", "--porcelain"]).out.is_empty(), "the rebase was aborted, not left half done");
        assert_eq!(read(&root.join("base.txt")), "peer's line\n");
        assert!(blockers("conflict-main").is_empty(), "no card for Joe");
        // No runtime here to tell the sub on, so the main chat is handed it.
        assert_eq!(super::super::plumbing::current(&id).unwrap().files, vec!["base.txt".to_string()]);
        // The sub resolves it the way the card told it to, then finishes again.
        let t = branch_ref(&info.target);
        assert!(!run(&wt, &["rebase", &t]).ok, "the sub's own rebase hits the same conflict");
        std::fs::write(wt.join("base.txt"), "resolved\n").unwrap();
        g(&wt, &["add", "base.txt"]);
        g(&wt, &["-c", "core.editor=true", "rebase", "--continue"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(read(&root.join("base.txt")), "resolved\n");
    }

    #[test]
    fn a_target_that_moved_meanwhile_is_retried_once_and_both_sets_of_commits_land() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "moved", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        let mut moved = |attempt: usize| {
            if attempt == 0 {
                commit_file(&root, "peer.txt", "landed while the merge ran\n");
            }
        };
        assert_eq!(land_with(&id, &info, &mut moved), Landing::Merged);
        assert_eq!(read(&root.join("a.txt")), "sub\n");
        assert_eq!(read(&root.join("peer.txt")), "landed while the merge ran\n", "the peer's commit is still there");
        assert_eq!(git::head(&root), git::head(Path::new(&info.path)));
    }

    #[test]
    fn a_target_that_keeps_moving_is_a_blocker_not_a_loop() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "busy", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        let mut n = 0;
        let mut always = |_attempt: usize| {
            n += 1;
            commit_file(&root, &format!("peer{n}.txt"), "x\n");
        };
        assert!(matches!(land_with(&id, &info, &mut always), Landing::Blocked(_)));
        assert!(!root.join("a.txt").exists(), "nothing half merged");
    }

    #[test]
    fn a_branch_switched_in_the_main_checkout_is_refused_rather_than_merged_into_the_wrong_branch() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "switched", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        g(&root, &["checkout", "-q", "-b", "elsewhere"]);
        let other_head = git::head(&root);
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("refused: {landing:?}") };
        assert!(b.text.contains("elsewhere") && b.text.contains(&info.target), "{}", b.text);
        assert_eq!(git::head(&root), other_head, "the wrong branch was not touched");
        assert!(!root.join("a.txt").exists());
        assert!(blockers("switched-main").is_empty());
        assert_eq!(wakes(&st, "switched-main"), 1);
    }

    #[test]
    fn no_commits_means_no_merge() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "nothing", &root);
        let before = git::head(&root);
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(git::head(&root), before);
        assert!(blockers("nothing-main").is_empty());
    }

    #[test]
    fn two_subs_finishing_together_both_land_through_the_repo_lock() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (a, ia) = new_sub(&st, "pair-a", &root);
        let (b, ib) = new_sub(&st, "pair-b", &root);
        commit_file(Path::new(&ia.path), "a.txt", "a\n");
        commit_file(Path::new(&ib.path), "b.txt", "b\n");
        let (ta, tb) = (std::thread::spawn(move || land(&a, &ia)), std::thread::spawn(move || land(&b, &ib)));
        assert_eq!(ta.join().unwrap(), Landing::Merged);
        assert_eq!(tb.join().unwrap(), Landing::Merged);
        assert_eq!((read(&root.join("a.txt")), read(&root.join("b.txt"))), ("a\n".to_string(), "b\n".to_string()));
    }

    static REST: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());
    fn rest_probe(_st: &Arc<DaemonState>, id: &str) {
        let landed = info_of(id).is_some_and(|i| Path::new(&i.repo).join("a.txt").exists());
        REST.lock().unwrap().push((id.to_string(), landed));
    }

    #[test]
    fn the_rest_of_finishing_runs_after_the_merge_and_only_for_a_worktree_sub() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "defer", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        assert!(defer(&st, &id, rest_probe));
        assert!(REST.lock().unwrap().contains(&(id.clone(), true)), "the card and the sub waiting behind it see what landed");
        assert!(!merging(&project_key(&root)), "the merge is over");
        st.registry.upsert_interactive("plain-sub", &root, "proj", TS);
        assert!(!defer(&st, "plain-sub", rest_probe), "any other sub finishes at once");
    }

    /// A visiting sub's target is its home machine's branch. Finishing must not merge
    /// its commits into whatever branch this machine's own checkout happens to have
    /// (here the same name), nor draw a card for a main chat that is not here.
    #[test]
    fn finishing_a_visiting_sub_merges_nothing_into_this_machines_checkout_and_draws_no_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (base, target) = (git::head(&root).unwrap(), target_of(&root));
        let Ok(Prepare::Ready(p)) = prepare_at(&root, "f1f1f1f1-0000", &base, &target) else { panic!("ready") };
        let id = "visitor-finish".to_string();
        st.registry.upsert_interactive(&id, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&id, Some("home-main".into()));
        crate::daemon::subchats::store_visiting_brief(&id, "home-main", "pc");
        let mut brief = chat_config::get(&id).unwrap().subchat.unwrap();
        brief.worktree_at = Some(p.info.clone());
        chat_config::set_subchat(&id, Some(brief));
        commit_file(Path::new(&p.info.path), "a.txt", "from the sub\n");
        let before = git::head(&root);

        crate::daemon::subchats::on_finished(&st, &id);

        assert_eq!(git::head(&root), before, "the host's own branch did not move");
        assert!(read(&root.join("a.txt")).is_empty(), "nor its files");
        assert!(card_log::read("home-main").is_empty(), "no card for a main chat that is not here");
        assert!(Path::new(&p.info.path).is_dir(), "the tree stays for the home to fetch from");
    }

    // ---- continuing ------------------------------------------------------------------------

    #[tokio::test]
    async fn a_continued_sub_is_brought_up_to_date_before_its_message_and_its_facts_base_moves() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "continue", &root);
        commit_file(Path::new(&info.path), "a.txt", "round one\n");
        assert_eq!(land(&id, &info), Landing::Merged);
        commit_file(&root, "peer.txt", "moved on\n");
        before_continue(&st, &id).await;
        let wt = Path::new(&info.path);
        assert_eq!(read(&wt.join("peer.txt")), "moved on\n", "it has what landed since");
        assert_eq!(git::head(wt), git::head(&root));
        assert_eq!(info_of(&id).unwrap().base, git::head(&root), "round two counts from here");
        assert!(blockers("continue-main").is_empty());
    }

    #[tokio::test]
    async fn a_continue_that_conflicts_wakes_the_main_chat_and_leaves_the_branch_alone() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "cont-conflict", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub\n");
        commit_file(&root, "base.txt", "peer\n");
        let before = git::head(Path::new(&info.path));
        before_continue(&st, &id).await;
        assert_eq!(git::head(Path::new(&info.path)), before, "nothing was rewritten");
        assert!(blockers("cont-conflict-main").is_empty(), "no card for Joe");
        assert_eq!(wakes(&st, "cont-conflict-main"), 1);
        let rec = super::super::plumbing::current(&id).unwrap();
        assert_eq!((rec.problem, rec.files), (super::super::plumbing::Problem::NotUpToDate, vec!["base.txt".to_string()]));
    }

    /// A visiting sub's target is a branch of its home machine: this clone has no
    /// such branch, so a rebase onto it would fail and wake a main chat that is
    /// not here. The home brings the branch up to date (step 4).
    #[tokio::test]
    async fn a_continue_of_a_visiting_sub_does_not_rebase_onto_a_target_this_clone_lacks() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let base = git::head(&root).unwrap();
        let Ok(Prepare::Ready(p)) = prepare_at(&root, "v1v1v1v1-0000", &base, "pc-only-branch") else { panic!("ready") };
        let id = "visitor-continue".to_string();
        st.registry.upsert_interactive(&id, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&id, Some("home-main".into()));
        crate::daemon::subchats::store_visiting_brief(&id, "home-main", "pc");
        let mut brief = chat_config::get(&id).unwrap().subchat.unwrap();
        brief.worktree_at = Some(p.info.clone());
        chat_config::set_subchat(&id, Some(brief));
        before_continue(&st, &id).await;
        assert!(super::super::plumbing::current(&id).is_none(), "nothing to report: the home owns the update");
        assert_eq!(git::head(Path::new(&p.info.path)).as_deref(), Some(base.as_str()), "the branch was not touched");
    }

    /// Only a sub told about this very conflict stays quiet: one whose merge waits
    /// for another chat's files still has its stale branch reported.
    #[tokio::test]
    async fn a_continue_that_conflicts_while_a_merge_waits_for_files_still_wakes_the_main_chat() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "cont-pending", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub\n");
        commit_file(&root, "base.txt", "peer\n");
        super::super::pending_merges::store(&id, super::super::pending_merges::Cause::DirtyFiles, vec!["other.txt".into()]);
        before_continue(&st, &id).await;
        assert_eq!(wakes(&st, "cont-pending-main"), 1);
        assert_eq!(super::super::plumbing::current(&id).unwrap().problem, super::super::plumbing::Problem::NotUpToDate);
    }

    // ---- setting up ---------------------------------------------------------------------------

    #[tokio::test]
    async fn before_launch_links_node_modules_once_and_a_junction_target_survives_removal() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("node_modules").join("pkg").join("index.js"), "module.exports = 1;\n").unwrap();
        let st = state();
        let (id, info) = new_sub(&st, "junction", &root);
        before_launch(&st, &id).await.unwrap();
        let link = Path::new(&info.path).join("node_modules");
        assert_eq!(read(&link.join("pkg").join("index.js")), "module.exports = 1;\n", "a JS project works in the new tree");
        assert!(is_link(&std::fs::symlink_metadata(&link).unwrap()));
        before_launch(&st, &id).await.unwrap();
        // The sub made no commits and left nothing uncommitted: removable.
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!Path::new(&info.path).exists());
        assert_eq!(read(&root.join("node_modules").join("pkg").join("index.js")), "module.exports = 1;\n", "the main checkout's node_modules is untouched");
        assert!(!branch_exists(&root, &info.branch));
        assert!(!run(&root, &["worktree", "list", "--porcelain"]).out.contains("sub-"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_failing_bootstrap_script_stops_the_launch_and_draws_no_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        commit_file(&root, "scripts/bootstrap-worktree.ps1", "Write-Host 'installing'\nexit 3\n");
        let st = state();
        let (id, _info) = new_sub(&st, "badscript", &root);
        let err = before_launch(&st, &id).await.expect_err("a broken tree must not start a sub");
        assert!(err.contains("could not be set up"), "{err}");
        assert!(err.contains("bootstrap-worktree.ps1"), "{err}");
        assert!(blockers("badscript-main").is_empty(), "the launch's caller hands it to the main chat");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn the_repos_bootstrap_script_runs_once_in_the_new_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        commit_file(&root, "scripts/bootstrap-worktree.ps1", "Add-Content -Path ran.txt -Value x\n");
        let st = state();
        let (id, info) = new_sub(&st, "goodscript", &root);
        before_launch(&st, &id).await.unwrap();
        before_launch(&st, &id).await.unwrap();
        assert_eq!(read(&Path::new(&info.path).join("ran.txt")).lines().count(), 1, "a second launch does not run it again");
        assert!(!root.join("ran.txt").exists(), "it ran in the worktree, not the main checkout");
    }

    #[test]
    fn registering_a_worktree_sub_holds_it_for_its_setup_without_taking_the_writer_slot() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        st.registry.upsert_interactive("reg-main", &root, "proj", TS);
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["footer.ts".into()]),
            ..Default::default()
        };
        let mut plan = crate::daemon::subchats::spawn::plan(&st, "reg-main", &cfg, &root.to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let prepared = plan_spawn(&plan.brief, &root, &sid).unwrap().unwrap();
        plan.brief.worktree_at = Some(prepared.info.clone());
        let spec = held::LaunchSpec {
            cwd: PathBuf::from(&prepared.info.cwd),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: plan.first_message.clone(),
        };
        let id = register_row(&st, "reg-main", Some("footer"), &cfg, spec, &mut plan, sid.clone()).unwrap();
        assert_eq!(id, sid);
        let inst = st.registry.get(&id).unwrap();
        assert_eq!(path_key(&inst.cwd.to_string_lossy()), path_key(&prepared.info.cwd), "the sub's cwd is its worktree");
        assert_eq!(inst.progress.waiting_for.as_deref(), Some(SETUP_TEXT));
        assert!(held::is_held(&id));
        assert_eq!(super::super::writers::holder_of(&root), None, "writers in worktrees do not queue");
        assert!(super::super::writers::queue_of(&root).is_empty());
        let stored = info_of(&id).expect("the path is recorded in the stored brief");
        assert_eq!(stored.path, prepared.info.path);
        assert_eq!(git::head(&inst.cwd), git::head(&root));
        assert!(super::super::writers::restore_inner(&st).is_empty(), "boot must not hand a worktree sub the slot");
        assert_eq!(super::super::writers::queue_of(&root), Vec::<String>::new());
    }

    #[test]
    fn a_continuing_sub_is_registered_with_a_link_to_the_sub_it_carries_on_so_it_reads_that_subs_decisions() {
        use crate::daemon::subchats::decisions::{self, Kind, NewEntry};
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        st.registry.upsert_interactive("cont-main", &root, "proj", TS);
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["footer.ts".into()]),
            ..Default::default()
        };
        let mut plan = crate::daemon::subchats::spawn::plan(&st, "cont-main", &cfg, &root.to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        plan.continue_from = Some("old-sub".into());
        let data = decisions::data_root().expect("the temp data dir");
        let row = |sub: &str, body: &str| NewEntry { kind: Kind::Decided, who: sub.into(), sub: Some(sub.into()), question: None, body: body.into() };
        decisions::append_in(&data, "cont-main", "d", vec![row("old-sub", "grid beats flex"), row("other-sub", "sibling note")]).unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let prepared = plan_spawn(&plan.brief, &root, &sid).unwrap().unwrap();
        plan.brief.worktree_at = Some(prepared.info.clone());
        let spec = held::LaunchSpec {
            cwd: PathBuf::from(&prepared.info.cwd),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: plan.first_message.clone(),
        };
        let id = register_row(&st, "cont-main", Some("footer"), &cfg, spec, &mut plan, sid).unwrap();
        let seen = decisions::render_in(&data, "cont-main", "CV", Some(&id)).expect("rows are visible");
        assert!(seen.contains("grid beats flex"), "the carried-on sub's row reaches the new sub: {seen}");
        assert!(!seen.contains("sibling note"), "a sibling's row stays hidden: {seen}");
    }

    #[test]
    fn the_stored_tree_survives_a_restart_and_an_old_brief_without_one_still_loads() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "restart", &root);
        // A restart rebuilds everything from the stored brief.
        let reread = chat_config::get(&id).unwrap().subchat.unwrap().worktree_at.unwrap();
        assert_eq!(reread, info);
        let json = serde_json::to_string(&chat_config::get(&id).unwrap().subchat.unwrap()).unwrap();
        let again: SubchatBrief = serde_json::from_str(&json).unwrap();
        assert_eq!(again.worktree_at, Some(info));
        let old: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t"}"#).unwrap();
        assert_eq!(old.worktree_at, None);
    }

    // ---- removing -------------------------------------------------------------------------------

    #[test]
    fn a_worktree_with_unmerged_commits_is_kept_and_so_is_one_with_uncommitted_work() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (_id, info) = new_sub(&st, "keep", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "unmerged\n");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep") };
        assert!(why.contains("not merged"), "{why}");
        assert!(wt.is_dir() && branch_exists(&root, &info.branch));
        // Merged, but a new edit is uncommitted.
        let (id2, info2) = new_sub(&st, "keep2", &root);
        let wt2 = PathBuf::from(&info2.path);
        assert_eq!(land(&id2, &info2), Landing::Nothing);
        std::fs::write(wt2.join("scratch.txt"), "half done\n").unwrap();
        let Removal::Kept(why) = remove_if_safe(&info2) else { panic!("must keep") };
        assert!(why.contains("uncommitted") && why.contains("scratch.txt"), "{why}");
        assert_eq!(read(&wt2.join("scratch.txt")), "half done\n", "nothing was deleted");
    }

    #[test]
    fn a_merged_clean_worktree_is_removed_with_its_branch() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "clean", &root);
        commit_file(Path::new(&info.path), "a.txt", "x\n");
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!Path::new(&info.path).exists());
        assert!(!branch_exists(&root, &info.branch));
        assert_eq!(read(&root.join("a.txt")), "x\n", "the merged work stays in the main checkout");
        assert_eq!(remove_if_safe(&info), Removal::Removed, "removing twice is harmless");
    }

    /// A file deeper than Windows' 260-character limit (a pnpm node_modules has
    /// hundreds) stopped `git worktree remove` half way, after git had already
    /// unregistered the tree, so the folder stayed and the retry no longer knew it
    /// as ours: every worktree sub of 2026-11-10/11 was left behind this way.
    #[test]
    fn a_tree_holding_paths_longer_than_windows_allows_is_removed_whole() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", "node_modules/\n");
        let st = state();
        let (id, info) = new_sub(&st, "deep", &root);
        let wt = PathBuf::from(&info.path);
        let deep = wt.join("node_modules").join("a".repeat(60)).join("b".repeat(60)).join("c".repeat(60)).join("d".repeat(60));
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("index.d.ts"), "export {};\n").unwrap();
        assert!(deep.join("index.d.ts").to_string_lossy().len() > 260, "precondition: past MAX_PATH");
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists(), "no half-deleted folder is left");
        assert!(!branch_exists(&root, &info.branch));
        assert!(!holder_of(&info).unwrap().exists(), "and nothing around it");
    }

    /// A shared target dir keeps a copy of the project's own crates per tree path
    /// that nothing frees (112GB on 2026-11-12): each tree builds into a folder of
    /// its own beside it, and that folder goes with the tree.
    #[test]
    fn a_tree_builds_into_its_own_folder_and_the_folder_goes_with_the_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "build", &root);
        let holder = holder_of(&info).expect("a new tree has a folder around it");
        let config = read(&holder.join(".cargo").join("config.toml"));
        let want = holder.join("target").to_string_lossy().replace('\\', "/");
        assert!(config.contains(&format!("target-dir = \"{want}\"")), "{config}");
        assert!(run(Path::new(&info.path), &["status", "--porcelain"]).out.is_empty(), "the config is outside the tree, so git add -A never commits it");
        let output = holder.join("target").join("debug").join("deps");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("libapp-0123.rlib"), vec![0u8; 4096]).unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!holder.exists(), "the build output and its config are deleted with the tree");
    }

    /// pc-1757: a tree's build folder starts from the repo's shared base of compiled
    /// third-party dependencies when an earlier sub left one, and stays empty (cargo
    /// builds everything itself, as before) when none exists.
    #[test]
    fn a_new_trees_build_folder_is_seeded_from_the_shared_base_and_stays_empty_without_one() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let Ok(Prepare::Ready(first)) = prepare(&root, "seed0001") else { panic!("ready") };
        let first_holder = holder_of(&first.info).unwrap();
        assert!(first_holder.join(".cargo").join("config.toml").is_file());
        assert!(!first_holder.join("target").exists(), "no base yet: cargo makes the folder on its first build");

        let base = root.join(".claude").join("worktrees").join(build_base::BASE_DIR);
        let rlib = base.join("debug").join("deps").join("libserde-0123456789abcdef.rlib");
        std::fs::create_dir_all(rlib.parent().unwrap()).unwrap();
        std::fs::write(&rlib, b"compiled").unwrap();
        let run_dir = base.join("debug").join("build").join("ring-0123456789abcdef");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(run_dir.join("output"), b"cargo:rustc-link-search=native=C:/old/sub-x/target\\debug\\build\\ring\\out\n").unwrap();
        std::fs::write(base.join("SOURCE"), "C:/old/sub-x/target").unwrap();

        let Ok(Prepare::Ready(second)) = prepare(&root, "seed0002") else { panic!("ready") };
        let holder = holder_of(&second.info).unwrap();
        let target = holder.join("target");
        assert_eq!(std::fs::read(target.join("debug/deps/libserde-0123456789abcdef.rlib")).unwrap(), b"compiled");
        let output = std::fs::read_to_string(target.join("debug/build/ring-0123456789abcdef/output")).unwrap();
        let own = target.to_string_lossy().replace('\\', "/");
        assert!(output.contains(&format!("native={own}")) && !output.contains("sub-x"), "{output}");
        assert!(run(Path::new(&second.info.path), &["status", "--porcelain"]).out.is_empty(), "the seeded folder is beside the tree, never in it");
    }

    /// Cargo itself must pick the folder: a config it does not read would leave the
    /// builds in the shared dir. Skipped where CARGO_TARGET_DIR is set, which
    /// outranks any config file.
    #[test]
    fn cargo_run_in_the_tree_reports_the_trees_own_target_dir() {
        if std::env::var_os("CARGO_TARGET_DIR").is_some() || std::env::var_os("CARGO_BUILD_TARGET_DIR").is_some() {
            return;
        }
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("src")).unwrap();
        commit_file(&root, "Cargo.toml", "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n");
        commit_file(&root, "src/lib.rs", "\n");
        let Ok(Prepare::Ready(p)) = prepare(&root, "c4c4c4c4") else { panic!("ready") };
        let mut cmd = std::process::Command::new("cargo");
        cmd.args(["metadata", "--format-version", "1", "--no-deps", "--offline"]).current_dir(&p.info.path);
        let out = cmd.output().expect("cargo runs");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let meta: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let got = meta["target_directory"].as_str().unwrap();
        let holder = holder_of(&p.info).unwrap();
        assert_eq!(path_key(got), path_key(&holder.join("target").to_string_lossy()));
        discard(&p.info);
    }

    /// A removal that failed when the sub ended (here: a file it left uncommitted,
    /// since deleted), or one the daemon never ran because it stopped first, is
    /// done at the next start.
    #[test]
    fn a_tree_left_by_an_ended_sub_is_removed_at_the_next_start() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "sweep", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("scratch.txt"), "half done\n").unwrap();
        assert!(crate::daemon::subchats::end_sub(&st, &id));
        assert!(wt.is_dir(), "kept at the end: it had uncommitted work");
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        let (live, live_info) = new_sub(&st, "sweep-live", &root);
        let (died, died_info) = new_sub(&st, "sweep-died", &root);
        st.registry.mark_ended(&died, crate::types::EndReason::ProcessGone, TS);
        sweep_ended(&st);
        assert!(!wt.exists() && !holder_of(&info).unwrap().exists(), "the closed sub's tree is gone");
        assert!(Path::new(&live_info.path).is_dir(), "a sub that has not ended keeps its tree: {live}");
        assert!(Path::new(&died_info.path).is_dir(), "a sub whose process died can be brought back, so it keeps its tree: {died}");
    }

    /// A closed sub that is brought back is not closed any more, so its mark goes
    /// and a later shutdown cannot make the boot sweep take its tree.
    #[tokio::test]
    async fn a_closed_sub_brought_back_loses_its_closed_mark() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "revive", &root);
        let mark = holder_of(&info).unwrap().join(CLOSED_MARK);
        std::fs::write(&mark, "closed\n").unwrap();
        before_continue(&st, &id).await;
        assert!(!mark.exists());
    }

    /// A build that still holds a file in the build folder leaves it, and the
    /// closed mark stays so the boot sweep tries again.
    #[test]
    fn a_build_folder_that_cannot_go_yet_keeps_the_closed_mark_for_the_next_start() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "held-build", &root);
        let holder = holder_of(&info).unwrap();
        std::fs::write(holder.join(CLOSED_MARK), "closed\n").unwrap();
        let deps = holder.join("target").join("debug");
        std::fs::create_dir_all(&deps).unwrap();
        let held = deps.join("app.exe");
        std::fs::write(&held, b"x").unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // No FILE_SHARE_DELETE: what a running exe or a linker's open output does.
            let lock = std::fs::OpenOptions::new().read(true).share_mode(0x1).open(&held).unwrap();
            assert!(matches!(remove_if_safe(&info), Removal::BuildLeft(_)));
            assert!(holder.join(CLOSED_MARK).is_file(), "the mark is what the boot sweep looks for");
            assert!(!Path::new(&info.path).exists(), "the tree itself went");
            drop(lock);
        }
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!holder.exists());
    }

    /// A closed sub whose tree a chat that has not ended still works in (a row that
    /// kept the tree as its folder) is never swept out from under it.
    #[test]
    fn the_sweep_leaves_a_tree_a_live_chat_works_in() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "sweep-used", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("scratch.txt"), "half done\n").unwrap();
        assert!(crate::daemon::subchats::end_sub(&st, &id));
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        st.registry.upsert_interactive("kept-it", &wt, "proj", TS);
        sweep_ended(&st);
        assert!(wt.is_dir(), "a live chat's folder stays");
    }

    /// What git leaves when it gives up part way: the tree unregistered, its `.git`
    /// link gone, files left. The next removal finishes it instead of calling the
    /// folder someone else's.
    #[test]
    fn a_tree_git_left_half_removed_is_finished_by_the_next_removal() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "half", &root);
        let wt = PathBuf::from(&info.path);
        assert_eq!(land(&id, &info), Landing::Nothing);
        std::fs::remove_file(wt.join(".git")).unwrap();
        g(&root, &["worktree", "prune"]);
        assert!(!is_registered(&root, &info.path), "precondition: git no longer lists it");
        std::fs::write(wt.join("unchecked.txt"), "a running sub's file\n").unwrap();
        assert!(matches!(remove_if_safe(&info), Removal::Kept(_)), "not closed: a running sub whose .git went missing keeps its files");
        assert!(wt.join("unchecked.txt").is_file());
        std::fs::write(holder_of(&info).unwrap().join(CLOSED_MARK), "closed\n").unwrap();
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists() && !holder_of(&info).unwrap().exists());
        assert!(!branch_exists(&root, &info.branch));
        // A folder of ours that git never had, with its .git link, is still left alone.
        let (_id2, info2) = new_sub(&st, "half-2", &root);
        let wt2 = PathBuf::from(&info2.path);
        g(&root, &["worktree", "remove", "--force", &wt2.to_string_lossy()]);
        std::fs::create_dir_all(&wt2).unwrap();
        std::fs::write(wt2.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert!(matches!(remove_if_safe(&info2), Removal::Kept(why) if why.contains("not a worktree this app made")));
        assert!(wt2.is_dir());
    }

    /// A scratch repo with an initialised submodule `mod`. The inner repo's temp
    /// dir is returned so the caller's binding keeps it alive.
    fn repo_with_module() -> (tempfile::TempDir, PathBuf, tempfile::TempDir, PathBuf) {
        let (inner_dir, inner) = test_repo::init();
        let (dir, root) = test_repo::init();
        // Git takes a plain path as the module's URL, not the `\\?\` form canonicalize gives.
        let url = inner.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
        g(&root, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &url, "mod"]);
        g(&root, &["commit", "-q", "-m", "add the module"]);
        (inner_dir, inner, dir, root)
    }

    /// Initialises the module inside a sub's tree, the way a bootstrap script does.
    fn init_module(wt: &Path) -> PathBuf {
        g(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
        let module = wt.join("mod");
        g(&module, &["config", "user.email", "t@example.com"]);
        g(&module, &["config", "user.name", "t"]);
        g(&module, &["config", "commit.gpgsign", "false"]);
        module
    }

    /// The id a sub's saved submodule commits are filed under in the main checkout.
    fn kept_ref(info: &WorktreeInfo, n: u32) -> String {
        format!("refs/cc-sub-kept/{}/{n}", info.branch.strip_prefix("sub/").unwrap())
    }

    /// What the main checkout's copy of `mod` holds under `name`, if anything.
    fn kept_sha(root: &Path, name: &str) -> Option<String> {
        let o = run(&root.join("mod"), &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")]);
        o.ok.then(|| o.out.trim().to_string())
    }

    /// `git worktree remove` refuses any tree with an initialised submodule, so the
    /// removal always falls through to `--force`, which deletes the module's git dir
    /// with the tree: a commit made only there would be lost while main pointed at
    /// it. The commit is saved in the main checkout's module first, and then the
    /// tree goes: a merged, clean tree is never kept just because of it.
    #[test]
    fn a_submodule_commit_no_remote_has_is_saved_in_the_main_checkout_and_the_tree_removed() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "only in this tree\n");
        let tip = git::head(&module).unwrap();
        g(&wt, &["add", "mod"]);
        g(&wt, &["commit", "-q", "-m", "point at the module commit"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        assert!(uncommitted_in(&wt).is_empty(), "the superproject sees a clean tree, which is the trap");
        assert_eq!(kept_sha(&root, &tip), None, "premise: the main checkout's module has no copy of the commit");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists(), "the tree is gone");
        assert!(!branch_exists(&root, &info.branch), "and its merged branch");
        assert_eq!(kept_sha(&root, &kept_ref(&info, 1)).as_deref(), Some(tip.as_str()), "the commit lives on under a kept ref");
        assert_eq!(run(&root.join("mod"), &["show", "-s", "--format=%s", &tip]).out, "edit m.txt", "and its content is readable there");
    }

    /// A branch other than HEAD that holds a commit no remote has is saved too.
    #[test]
    fn every_unpublished_submodule_tip_is_saved() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-branches", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        g(&module, &["checkout", "-q", "-b", "side"]);
        commit_file(&module, "side.txt", "on a side branch\n");
        let side = git::head(&module).unwrap();
        g(&module, &["checkout", "-q", "--detach"]);
        commit_file(&module, "head.txt", "on a detached head\n");
        let head = git::head(&module).unwrap();
        // The parent's pointer moved to the detached commit, which is not the work.
        let drifted: Vec<String> = uncommitted_in(&wt);
        assert_eq!(drifted, vec!["mod".to_string()]);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        let saved: Vec<String> = [1, 2].iter().filter_map(|n| kept_sha(&root, &kept_ref(&info, *n))).collect();
        assert!(saved.contains(&side) && saved.contains(&head), "both tips are kept: {saved:?}");
        assert_eq!(kept_sha(&root, &kept_ref(&info, 3)), None, "and nothing else");
    }

    /// The module moved to a commit the branch never recorded shows as `M mod` in the
    /// parent's status, which kept the tree as "uncommitted work: mod" forever.
    #[test]
    fn a_submodule_moved_to_a_commit_the_branch_never_recorded_is_saved_not_kept() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-drift", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "never recorded in the parent\n");
        let tip = git::head(&module).unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(uncommitted_in(&wt), vec!["mod".to_string()], "premise: the parent lists the module as modified");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists());
        assert_eq!(kept_sha(&root, &kept_ref(&info, 1)).as_deref(), Some(tip.as_str()));
    }

    /// Even a moved pointer to a commit a remote has is recorded under a kept ref,
    /// since the parent's record of which commit the tree used goes with the tree.
    #[test]
    fn a_submodule_moved_to_a_published_commit_keeps_that_commit_named() {
        let _data = TempDataDir::new();
        let (_i, inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-drift-pub", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&inner, "upstream.txt", "published\n");
        let published = git::head(&inner).unwrap();
        g(&module, &["fetch", "-q", "origin"]);
        g(&module, &["checkout", "-q", &published]);
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(uncommitted_in(&wt), vec!["mod".to_string()], "premise: the parent lists the module as modified");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert_eq!(kept_sha(&root, &kept_ref(&info, 1)).as_deref(), Some(published.as_str()));
    }

    /// Whether any of the sub's kept refs in the main checkout's module holds `sha`.
    fn kept_anywhere(root: &Path, info: &WorktreeInfo, sha: &str) -> bool {
        (1..=6).any(|n| kept_sha(root, &kept_ref(info, n)).as_deref() == Some(sha))
    }

    /// A stash and a tag live in the module's own git dir, which goes with the tree.
    #[test]
    fn a_submodule_stash_and_tag_are_saved_too() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-stash-tag", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        let published = git::head(&module).unwrap();
        commit_file(&module, "tagged.txt", "only a tag points here\n");
        let tagged = git::head(&module).unwrap();
        g(&module, &["tag", "keep-me"]);
        g(&module, &["checkout", "-q", "--detach", &published]);
        std::fs::write(module.join("base.txt"), "stashed work\n").unwrap();
        g(&module, &["stash", "push", "-q"]);
        let older_stash = run(&module, &["rev-parse", "refs/stash"]).out.trim().to_string();
        std::fs::write(module.join("base.txt"), "more stashed work\n").unwrap();
        g(&module, &["stash", "push", "-q"]);
        let stashed = run(&module, &["rev-parse", "refs/stash"]).out.trim().to_string();
        assert_ne!(older_stash, stashed, "premise: two stash entries, the older reachable only through the reflog");
        assert!(uncommitted_in(&wt).is_empty(), "premise: the tree looks clean and its HEAD is published");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(kept_anywhere(&root, &info, &tagged), "the tagged commit is kept");
        assert!(kept_anywhere(&root, &info, &stashed), "the newest stash is kept");
        assert!(kept_anywhere(&root, &info, &older_stash), "and the older one");
    }

    /// The branch is merged and records commit X for the module; the module then moved
    /// on to a published commit and no ref reaches X. The merged history still needs it.
    #[test]
    fn a_commit_the_merged_branch_recorded_is_saved_even_when_no_module_ref_reaches_it() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-recorded", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        let published = git::head(&module).unwrap();
        commit_file(&module, "m.txt", "recorded by the parent\n");
        let recorded = git::head(&module).unwrap();
        g(&wt, &["add", "mod"]);
        g(&wt, &["commit", "-q", "-m", "point at the module commit"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        g(&module, &["checkout", "-q", "--detach", &published]);
        let branches = run(&module, &["for-each-ref", "--format=%(refname)", "refs/heads"]).out;
        for b in branches.lines() {
            g(&module, &["update-ref", "-d", b.trim()]);
        }
        assert!(run(&module, &["for-each-ref", "refs/heads", "refs/tags"]).out.is_empty(), "premise: no module ref reaches the commit");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(kept_anywhere(&root, &info, &recorded), "the commit the merged branch recorded is kept");
    }

    /// The module's own git dir (inside the tree's, so it goes with the tree).
    fn module_git_dir(module: &Path) -> PathBuf {
        PathBuf::from(run(module, &["rev-parse", "--absolute-git-dir"]).out.trim())
    }

    /// A stash git cannot list (here its newest commit is gone from the module) must
    /// not read as "no stash": the older entries live only on its reflog, and the
    /// tree goes with it.
    #[test]
    fn a_submodule_stash_git_cannot_list_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-stash-broken", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        std::fs::write(module.join("base.txt"), "stashed work\n").unwrap();
        g(&module, &["stash", "push", "-q"]);
        std::fs::write(module.join("base.txt"), "more stashed work\n").unwrap();
        g(&module, &["stash", "push", "-q"]);
        let newest = run(&module, &["rev-parse", "refs/stash"]).out.trim().to_string();
        let object = module_git_dir(&module).join("objects").join(&newest[..2]).join(&newest[2..]);
        assert!(object.is_file(), "premise: the stash commit is a loose object: {}", object.display());
        let mut perm = std::fs::metadata(&object).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        std::fs::set_permissions(&object, perm).unwrap();
        std::fs::remove_file(&object).unwrap();
        assert!(run(&module, &["rev-parse", "--verify", "--quiet", "refs/stash"]).ok, "premise: the stash ref is there");
        assert!(!run(&module, &["rev-list", "-g", "refs/stash"]).ok, "premise: git cannot list the stash");
        assert!(uncommitted_in(&wt).is_empty(), "premise: the tree looks clean");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("mod") && why.contains("stash could not be listed"), "{why}");
        assert!(wt.is_dir() && module_git_dir(&module).is_dir(), "nothing was deleted");
    }

    /// The commits that recorded the module are read from the tree's own history; a
    /// history git cannot read says nothing about what they recorded.
    #[test]
    fn a_tree_whose_history_cannot_be_read_for_the_modules_pointers_is_kept() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-history-broken", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "recorded by the parent\n");
        g(&wt, &["add", "mod"]);
        g(&wt, &["commit", "-q", "-m", "point at the module commit"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        // The tree of the commit before the module was added is no part of what the
        // earlier checks read, and the pointer history cannot be walked without it.
        let parent_tree = run(&wt, &["rev-parse", "HEAD~2^{tree}"]).out.trim().to_string();
        let objects = run(&wt, &["rev-parse", "--git-path", "objects"]).out.trim().to_string();
        let object = Path::new(&objects).join(&parent_tree[..2]).join(&parent_tree[2..]);
        let object = if object.is_absolute() { object } else { wt.join(object) };
        assert!(object.is_file(), "premise: the tree object is loose: {}", object.display());
        let mut perm = std::fs::metadata(&object).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        std::fs::set_permissions(&object, perm).unwrap();
        std::fs::remove_file(&object).unwrap();
        assert!(!run(&wt, &["log", "--format=%H", "HEAD", "--", "mod"]).ok, "premise: git cannot walk the pointer history");
        assert!(uncommitted_in(&wt).is_empty(), "premise: the tree looks clean");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("mod") && why.contains("could not be listed"), "{why}");
        assert!(wt.is_dir(), "nothing was deleted");
    }

    /// A scratch repo whose module `mod` has a module of its own, `nested`, set up in
    /// the main checkout. The temp dirs are returned so the caller keeps them alive.
    fn repo_with_nested_module() -> (Vec<tempfile::TempDir>, PathBuf) {
        let (d3, leaf) = test_repo::init();
        let (d2, inner) = test_repo::init();
        let (d1, root) = test_repo::init();
        let path_url = |p: &Path| p.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
        g(&inner, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &path_url(&leaf), "nested"]);
        g(&inner, &["commit", "-q", "-m", "add the nested module"]);
        g(&root, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &path_url(&inner), "mod"]);
        g(&root, &["commit", "-q", "-m", "add the module"]);
        g(&root, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "-q"]);
        (vec![d3, d2, d1], root)
    }

    /// Initialises both modules inside a sub's tree and returns the nested one.
    fn init_nested_module(wt: &Path) -> PathBuf {
        g(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "-q"]);
        let nested = wt.join("mod").join("nested");
        g(&nested, &["config", "user.email", "t@example.com"]);
        g(&nested, &["config", "user.name", "t"]);
        g(&nested, &["config", "commit.gpgsign", "false"]);
        nested
    }

    /// A module nested in another that sits on a commit its owner never recorded
    /// shows as modified in the owner's status, which kept the tree as "uncommitted
    /// work: nested" for ever. Its commit is saved like a top-level module's.
    #[test]
    fn a_nested_submodule_moved_to_a_commit_nobody_recorded_is_saved_not_kept() {
        let _data = TempDataDir::new();
        let (_keep, root) = repo_with_nested_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-nested-drift", &root);
        let wt = PathBuf::from(&info.path);
        let nested = init_nested_module(&wt);
        commit_file(&nested, "n.txt", "never recorded by anyone\n");
        let tip = git::head(&nested).unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(uncommitted_in(&wt.join("mod")), vec!["nested".to_string()], "premise: the owner lists the nested module as modified");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists());
        let kept = run(&root.join("mod").join("nested"), &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", kept_ref(&info, 1))]);
        assert_eq!(kept.out.trim(), tip, "the nested commit lives on under a kept ref");
    }

    /// Real work in a nested module still keeps the tree.
    #[test]
    fn a_nested_submodule_with_uncommitted_work_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_keep, root) = repo_with_nested_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-nested-dirty", &root);
        let wt = PathBuf::from(&info.path);
        let nested = init_nested_module(&wt);
        std::fs::write(nested.join("base.txt"), "half done\n").unwrap();
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("uncommitted"), "{why}");
        assert_eq!(read(&nested.join("base.txt")), "half done\n");
    }

    /// A tree whose submodules cannot be listed cannot be checked, so it stays: an
    /// empty list must never read as "no submodules".
    #[test]
    fn a_tree_whose_submodules_cannot_be_listed_is_kept() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-unlisted", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "only in this tree\n");
        let tip = git::head(&module).unwrap();
        g(&wt, &["add", "mod"]);
        g(&wt, &["rm", "-q", ".gitmodules"]);
        g(&wt, &["commit", "-q", "-m", "drop the module mapping but keep the pointer"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        assert!(!run(&wt, &["submodule", "status", "--recursive"]).ok, "premise: git cannot list the modules");
        assert!(uncommitted_in(&wt).is_empty(), "premise: the tree looks clean");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("submodules could not be listed"), "{why}");
        assert_eq!(git::head(&module).as_deref(), Some(tip.as_str()), "the only copy of the commit is still there");
    }

    /// Real work in the module still keeps the tree, and nothing is saved from a tree
    /// that stays, so it stays exactly as it was.
    #[test]
    fn a_submodule_with_uncommitted_work_and_an_unpublished_commit_keeps_the_tree_and_saves_nothing() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-dirty-commit", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "committed\n");
        std::fs::write(module.join("base.txt"), "half done\n").unwrap();
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("mod") && why.contains("uncommitted"), "{why}");
        assert_eq!(read(&module.join("base.txt")), "half done\n");
        assert_eq!(kept_sha(&root, &kept_ref(&info, 1)), None);
    }

    /// With no module of that name set up in the main checkout there is nowhere to
    /// save the commits, so the tree stays rather than delete the only copy.
    #[test]
    fn a_submodule_commit_with_no_copy_of_the_module_in_the_main_checkout_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-nowhere", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "only in this tree\n");
        let tip = git::head(&module).unwrap();
        std::fs::remove_file(root.join("mod").join(".git")).unwrap();
        assert!(!root.join("mod").join(".git").exists(), "premise: the main checkout's module is not set up");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("mod") && why.contains("main checkout"), "{why}");
        assert!(wt.is_dir());
        assert_eq!(git::head(&module).as_deref(), Some(tip.as_str()), "the only copy of the commit is still there");
    }

    /// The keep reason names a module whose pointer moved, so the reader knows the commit it
    /// moved to is part of what is at stake.
    #[test]
    fn a_kept_tree_says_when_its_submodule_moved_to_another_commit() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (_id, info) = new_sub(&st, "module-moved-reason", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "only in this tree\n");
        std::fs::remove_file(root.join("mod").join(".git")).unwrap();
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("its submodule mod (moved to a commit the tree never recorded)"), "{why}");
    }

    #[test]
    fn a_submodule_at_a_pushed_commit_does_not_stop_the_removal() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-clean", &root);
        let wt = PathBuf::from(&info.path);
        init_module(&wt);
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists());
    }

    #[test]
    fn a_submodule_with_uncommitted_work_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-dirty", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        assert_eq!(land(&id, &info), Landing::Nothing);
        std::fs::write(module.join("base.txt"), "half done\n").unwrap();
        let Removal::Kept(_) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert_eq!(read(&module.join("base.txt")), "half done\n");
    }

    /// A difference with an empty diff (a file rewritten with other line endings,
    /// which is what `cargo tauri android init` does to two tracked files) still
    /// shows as modified in `git status`, makes `git rebase` refuse with "You have
    /// unstaged changes", and counted as uncommitted work forever.
    fn eol_only_dirty_tree() -> (tempfile::TempDir, PathBuf, Arc<DaemonState>, String, WorktreeInfo) {
        let (d, root) = test_repo::init();
        g(&root, &["config", "core.autocrlf", "true"]);
        std::fs::write(root.join("eol.txt"), "one\r\ntwo\r\n").unwrap();
        g(&root, &["add", "eol.txt"]);
        g(&root, &["commit", "-q", "-m", "a file with CRLF in the work tree"]);
        let st = state();
        let (id, info) = new_sub(&st, "eol", &root);
        std::fs::write(Path::new(&info.path).join("eol.txt"), "one\ntwo\n").unwrap();
        (d, root, st, id, info)
    }

    #[test]
    fn a_line_ending_only_difference_is_not_uncommitted_work() {
        let _data = TempDataDir::new();
        let (_d, _root, _st, _id, info) = eol_only_dirty_tree();
        let wt = PathBuf::from(&info.path);
        assert!(!run(&wt, &["status", "--porcelain"]).out.is_empty(), "precondition: git status lists the file");
        assert!(run(&wt, &["diff", "--name-only"]).out.is_empty(), "precondition: and its diff is empty");
        assert!(uncommitted_in(&wt).is_empty(), "no real change, so no uncommitted work");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
    }

    #[test]
    fn a_line_ending_only_difference_does_not_block_the_rebase_onto_a_moved_target() {
        let _data = TempDataDir::new();
        let (_d, root, _st, id, info) = eol_only_dirty_tree();
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "the sub's work\n");
        commit_file(&root, "peer.txt", "the target moved\n");
        assert_eq!(land(&id, &info), Landing::Merged, "the rebase must not stop at 'You have unstaged changes'");
        assert_eq!(read(&root.join("a.txt")), "the sub's work\n");
        assert_eq!(read(&root.join("peer.txt")), "the target moved\n");
    }

    /// Real edits stay real: settling the index must never hide work.
    #[test]
    fn a_real_edit_next_to_a_line_ending_only_difference_still_counts() {
        let _data = TempDataDir::new();
        let (_d, _root, _st, _id, info) = eol_only_dirty_tree();
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("base.txt"), "really changed\n").unwrap();
        assert_eq!(uncommitted_in(&wt), vec!["base.txt".to_string()]);
    }

    #[test]
    fn it_never_removes_a_folder_it_did_not_make() {
        let (_d, root) = test_repo::init();
        let info = WorktreeInfo {
            cwd: root.to_string_lossy().into_owned(),
            path: root.to_string_lossy().into_owned(),
            branch: "sub/none".into(),
            target: target_of(&root),
            repo: root.to_string_lossy().into_owned(),
            base: None,
        };
        assert!(matches!(remove_if_safe(&info), Removal::Kept(_)));
        assert!(root.join("base.txt").is_file());
    }

    #[test]
    fn ending_a_sub_removes_a_clean_merged_tree_and_keeps_an_unmerged_one_without_a_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (done, done_info) = new_sub(&st, "end-clean", &root);
        commit_file(Path::new(&done_info.path), "a.txt", "x\n");
        assert_eq!(land(&done, &done_info), Landing::Merged);
        assert!(crate::daemon::subchats::end_sub(&st, &done));
        assert!(!Path::new(&done_info.path).exists(), "it goes with the sub");
        let (open, open_info) = new_sub(&st, "end-open", &root);
        commit_file(Path::new(&open_info.path), "b.txt", "unmerged\n");
        assert!(crate::daemon::subchats::end_sub(&st, &open));
        assert!(Path::new(&open_info.path).is_dir(), "unmerged work is never thrown away");
        // Nothing waits on Joe (2026-11-17): the app log has the fact and the age
        // sweep retries the tree.
        assert!(blockers("end-open-main").is_empty(), "a kept tree draws no card");
        assert!(branch_exists(&root, &open_info.branch));
    }

    /// The age sweep takes a tree that had to stay once its work is merged: the
    /// unmerged sub is kept at its end with no card, merged later, and the sweep
    /// removes it.
    #[test]
    fn the_age_sweep_removes_a_kept_tree_once_its_work_is_merged() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "age", &root);
        commit_file(Path::new(&info.path), "late.txt", "x\n");
        assert!(crate::daemon::subchats::end_sub(&st, &id));
        assert!(Path::new(&info.path).is_dir(), "kept: its commit is unmerged");
        assert!(holder_of(&info).unwrap().join(CLOSED_MARK).is_file(), "the mark the sweep retries from is written by the end itself");
        sweep_ended(&st);
        assert!(Path::new(&info.path).is_dir(), "still unmerged, still kept");
        assert!(blockers("age-main").is_empty(), "the sweep never cards it either");
        assert_eq!(land(&id, &info), Landing::Merged);
        sweep_ended(&st);
        assert!(!Path::new(&info.path).exists(), "merged and clean, so the sweep removes it");
        assert!(!branch_exists(&root, &info.branch));
    }

    /// A finished sub whose commits are not merged is never auto-closed: closing it
    /// would make `subchat merge` refuse it and strand the branch.
    #[test]
    fn has_unmerged_is_true_until_the_commits_land() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "unm", &root);
        assert!(!has_unmerged(&id), "a fresh tree has nothing the target lacks");
        commit_file(Path::new(&info.path), "u.txt", "x\n");
        assert!(has_unmerged(&id));
        assert_eq!(land(&id, &info), Landing::Merged);
        assert!(!has_unmerged(&id));
    }

    /// A branch git cannot count against its target (the target ref is gone) is not
    /// "nothing unmerged": `remove_if_safe` keeps such a tree, so closing the sub
    /// would strand the commits on a branch `subchat merge` refuses.
    #[test]
    fn a_failed_count_on_an_existing_branch_counts_as_unmerged() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "unk", &root);
        commit_file(Path::new(&info.path), "k.txt", "x\n");
        let mut brief = chat_config::get(&id).and_then(|c| c.subchat).unwrap();
        brief.worktree_at.as_mut().unwrap().target = "no-such-branch".into();
        chat_config::set_subchat(&id, Some(brief));
        assert!(has_unmerged(&id), "the count failed, the branch holds commits");
        // A branch that is gone strands nothing.
        g(&root, &["worktree", "remove", "--force", &info.path]);
        g(&root, &["branch", "-D", &info.branch]);
        assert!(!has_unmerged(&id));
    }

    /// The age close asks `has_unmerged` from an async tick: its `git rev-list` must
    /// run on the blocking pool, never on the worker the tick runs on.
    #[tokio::test(flavor = "current_thread")]
    async fn the_age_close_counts_unmerged_commits_off_the_async_worker() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, _info) = new_sub(&st, "offw", &root);
        st.registry.set_subchat_finished(&id, true);
        let now = chrono::Utc::now();
        let data = tempfile::tempdir().unwrap();
        let record = super::super::finish::FinishRecord {
            sub_id: id.clone(),
            finished_at: (now - chrono::Duration::hours(20)).to_rfc3339(),
            ..Default::default()
        };
        super::super::finish::write_record_in(data.path(), &record).unwrap();
        assert_eq!(super::super::auto_close::due(&st, data.path(), now).await, [id.clone()]);
        let ran_on = counted_on(&id).expect("the count ran");
        assert_ne!(ran_on, std::thread::current().id(), "the count blocked the async worker");
    }

    /// A second sweep of the same daemon never starts while one runs: the boot sweep
    /// and the first hourly tick would otherwise both delete trees and sweep build
    /// folders, racing on the same holder folder.
    #[test]
    fn a_sweep_never_starts_while_another_one_of_the_daemon_runs() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        // A merged, closed tree for the sweep to take.
        let (id, info2) = new_sub(&st, "swp", &root);
        std::fs::write(holder_of(&info2).unwrap().join(CLOSED_MARK), "").unwrap();
        st.registry.mark_ended(&id, crate::types::EndReason::Manual, "2026-11-17T00:00:00Z");
        let running = begin_sweep(&st).expect("nothing runs yet");
        assert!(begin_sweep(&st).is_none(), "one at a time");
        sweep_ended(&st);
        assert!(Path::new(&info2.path).is_dir(), "the sweep that found another running did nothing");
        drop(running);
        sweep_ended(&st);
        assert!(!Path::new(&info2.path).exists(), "once the first is done a sweep runs again");
        assert!(begin_sweep(&st).is_some(), "and frees its slot when it ends");
    }

    /// A visiting sub's target is a branch of its home machine, so the host never counts
    /// its commits as unmerged: the home lands them.
    #[test]
    fn a_visiting_sub_is_never_unmerged_on_the_host() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "visit", &root);
        commit_file(Path::new(&info.path), "v.txt", "x\n");
        assert!(has_unmerged(&id));
        let mut brief = chat_config::get(&id).and_then(|c| c.subchat).unwrap();
        brief.home = Some(crate::daemon::subchats::brief::HomeRef { machine_id: "m1".into(), main_id: "visit-main".into() });
        chat_config::set_subchat(&id, Some(brief));
        assert!(!has_unmerged(&id));
    }

    /// The 12 hour sweep leaves a finished sub whose commits have not landed, and takes
    /// it once they have.
    #[tokio::test]
    async fn the_age_close_skips_a_sub_whose_commits_have_not_landed() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "ageun", &root);
        st.registry.set_subchat_finished(&id, true);
        let now = chrono::Utc::now();
        let data = tempfile::tempdir().unwrap();
        let record = super::super::finish::FinishRecord {
            sub_id: id.clone(),
            finished_at: (now - chrono::Duration::hours(20)).to_rfc3339(),
            ..Default::default()
        };
        super::super::finish::write_record_in(data.path(), &record).unwrap();
        commit_file(Path::new(&info.path), "u.txt", "x\n");
        assert!(super::super::auto_close::due(&st, data.path(), now).await.is_empty(), "unmerged commits keep it");
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(super::super::auto_close::due(&st, data.path(), now).await, [id]);
    }

    /// A Roblox-style tree: the only thing left is git-ignored package folders. Ignored
    /// is not source, so ending the sub removes the tree and raises no card (Joe
    /// 2026-11-17, the red "Worktree kept" cards).
    #[test]
    fn ending_a_merged_sub_whose_tree_holds_only_ignored_folders_removes_it_with_no_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", "Packages/\nServerPackages/\ntesting/DevPackages/\n");
        let st = state();
        let (id, info) = new_sub(&st, "roblox", &root);
        let wt = PathBuf::from(&info.path);
        for dir in ["Packages/a", "ServerPackages/b", "testing/DevPackages/c"] {
            std::fs::create_dir_all(wt.join(dir)).unwrap();
            std::fs::write(wt.join(dir).join("x.lua"), "return 1\n").unwrap();
        }
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert!(uncommitted_in(&wt).is_empty(), "precondition: git status calls the tree clean");
        assert!(crate::daemon::subchats::end_sub(&st, &id));
        assert!(!wt.exists(), "the tree and the ignored folders go");
        assert!(!branch_exists(&root, &info.branch));
        assert!(blockers("roblox-main").is_empty(), "no Worktree kept card");
    }

    #[test]
    fn only_a_tree_that_holds_work_is_a_card_and_housekeeping_goes_to_the_log() {
        for work in [
            "2 commits on branch sub/x are not merged into master",
            "it has uncommitted work: a.txt",
            "its HEAD is detached on commits no branch holds, and removing the tree would lose them",
            "its submodule vendor/k has uncommitted work: a.txt",
        ] {
            assert!(keeps_work(work), "{work}");
        }
        for housekeeping in [
            "C:/r is not a worktree this app made, so it was left alone",
            "git could not remove the folder: a delete left it half done (x)",
            "could not unlink C:/t/node_modules, so the folder was not removed",
            "C:/t is still there, so the folder around it was left alone",
        ] {
            assert!(!keeps_work(housekeeping), "{housekeeping}");
        }
    }

    // ---- leaving the sub role ----------------------------------------------------------------------

    /// Clearing the brief on "Move to sidebar" used to take the tree with it: nothing
    /// merged the branch, nothing removed the folder, and no card said so.
    #[tokio::test]
    async fn moving_a_worktree_sub_to_the_sidebar_merges_its_commits_and_draws_no_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "mv", &root);
        commit_file(Path::new(&info.path), "a.txt", "from the sub\n");

        crate::daemon::subchats::move_to_sidebar(&st, &id).await.unwrap();

        assert_eq!(read(&root.join("a.txt")), "from the sub\n", "its commits landed at once");
        assert!(st.registry.get(&id).unwrap().subchat_of.is_none());
        assert!(Path::new(&info.path).is_dir(), "the chat keeps its worktree as its folder");
        // A clean move is an FYI: it went to the app log, not to Waiting on you.
        let cards = blockers("mv-main");
        assert!(cards.is_empty(), "{cards:?}");
    }

    #[tokio::test]
    async fn a_conflict_on_move_is_a_blocker_card_naming_the_branch_and_path_and_loses_nothing() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "mvc", &root);
        commit_file(Path::new(&info.path), "base.txt", "the sub's line\n");
        commit_file(&root, "base.txt", "the main checkout's line\n");

        crate::daemon::subchats::move_to_sidebar(&st, &id).await.unwrap();

        let cards = blockers("mvc-main");
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0].verdict, "Merge conflict");
        assert!(cards[0].text.contains(&info.path) && cards[0].text.contains(&info.branch), "{}", cards[0].text);
        assert_eq!(cards[0].points, vec!["base.txt".to_string()]);
        assert!(cards[0].text.contains("tell it to resolve this and merge the branch"), "it says what Joe can do: {}", cards[0].text);
        assert_eq!(cards[0].tone.as_deref(), Some("bad"));
        assert_eq!(count(Path::new(&info.path), &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "the commit is safe");
        assert_eq!(read(&root.join("base.txt")), "the main checkout's line\n");
    }

    #[tokio::test]
    async fn a_sub_without_a_tree_moves_with_no_card() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("plain-main", Path::new("."), "proj", TS);
        st.registry.upsert_interactive("plain-sub", Path::new("."), "proj", TS);
        st.registry.set_subchat_of("plain-sub", Some("plain-main".into()));
        let mut brief = brief_json(false, "");
        brief.parent = "plain-main".into();
        chat_config::set_subchat("plain-sub", Some(brief));
        crate::daemon::subchats::move_to_sidebar(&st, "plain-sub").await.unwrap();
        assert!(card_log::read("plain-main").is_empty());
    }

    /// Closing the main chat ends its finished subs, and a tree with unmerged
    /// commits is kept with a card in a window that is closing.
    #[tokio::test]
    async fn closing_a_chat_whose_finished_sub_has_unmerged_commits_asks_and_names_them() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "cu", &root);
        st.registry.set_subchat_finished(&id, true);
        assert!(!crate::daemon::subchats::closing::needs_approval(&st, "cu-main"), "nothing unmerged yet");
        commit_file(Path::new(&info.path), "a.txt", "unmerged\n");
        assert_eq!(unmerged_subs(&st, "cu-main"), vec![("cu".to_string(), 1)]);
        assert!(crate::daemon::subchats::closing::needs_approval(&st, "cu-main"));

        assert!(crate::daemon::subchats::closing::request_close(&st, "cu-main"), "the close is held");
        let mut card = None;
        for _ in 0..200 {
            card = st.list_prompts().await.into_iter().find(|p| p["payload"]["card_kind"] == crate::daemon::subchats::closing::KIND);
            if card.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let card = card.expect("the approval card is raised");
        let question = card["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(question.contains("unmerged commits") && question.contains("**cu** (1)"), "{question}");
        let labels: Vec<&str> =
            card["payload"]["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Close anyway", "Keep it open"], "nothing is running, so there is nothing to wait for");

        assert_eq!(land(&id, &info), Landing::Merged);
        assert!(!crate::daemon::subchats::closing::needs_approval(&st, "cu-main"), "merged work holds nothing");
    }

    // ---- what a removal would lose without saying so ---------------------------------------------

    /// `git status` leaves ignored files out and `git worktree remove` deletes them. A
    /// merged, clean tree that holds ignored files which are not build output (a sub's
    /// own screenshots and todo notes) stays, with the files named; it goes once they do.
    #[test]
    fn a_tree_holding_a_sub_s_own_ignored_files_is_kept_and_goes_once_they_are_gone() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", ".for_bepy/\n.claude/todos/*\n!.claude/todos/keep.md\nnode_modules/\n");
        std::fs::create_dir_all(root.join(".claude").join("todos")).unwrap();
        commit_file(&root, ".claude/todos/keep.md", "tracked\n");
        let st = state();
        let (id, info) = new_sub(&st, "ign", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::create_dir_all(wt.join(".for_bepy").join("screenshots").join("1")).unwrap();
        std::fs::write(wt.join(".for_bepy").join("screenshots").join("1").join("a.png"), b"png").unwrap();
        std::fs::write(wt.join(".claude").join("todos").join("note.md"), "the sub wrote this\n").unwrap();
        std::fs::create_dir_all(wt.join("node_modules").join("pkg")).unwrap();
        std::fs::write(wt.join("node_modules").join("pkg").join("i.js"), "x\n").unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert!(uncommitted_in(&wt).is_empty(), "precondition: git status calls the tree clean");
        let listed = worktree_safety::ignored_work(&wt).join(" ");
        assert!(listed.contains(".for_bepy") && listed.contains("note.md") && !listed.contains("node_modules"), "{listed}");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("the sub's own ignored files would be deleted silently") };
        assert!(why.contains("git-ignored") && why.contains(".for_bepy") && why.contains("note.md"), "{why}");
        assert!(keeps_work(&why), "it is work the age sweep retries, not housekeeping");
        assert!(wt.join(".for_bepy").join("screenshots").join("1").join("a.png").is_file(), "nothing was deleted");
        assert!(branch_exists(&root, &info.branch));
        std::fs::remove_dir_all(wt.join(".for_bepy")).unwrap();
        std::fs::remove_file(wt.join(".claude").join("todos").join("note.md")).unwrap();
        assert_eq!(remove_if_safe(&info), Removal::Removed, "only build output is left");
        assert!(!wt.exists());
        assert!(!branch_exists(&root, &info.branch));
    }

    /// What the setup made (a bootstrap script's generated files) is ignored by git
    /// too and goes with the tree; a file the sub made later keeps it.
    #[test]
    fn setup_output_goes_with_the_tree_and_a_later_ignored_file_keeps_it() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", "gen/\nscratch/\n");
        let st = state();
        let (_id, info) = new_sub(&st, "gen", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::create_dir_all(wt.join("gen")).unwrap();
        std::fs::write(wt.join("gen").join("settings.gradle"), "generated\n").unwrap();
        ensure_setup(&info).unwrap();
        assert_eq!(remove_if_safe(&info), Removal::Removed, "the setup's own output alone does not keep a tree");
        let (_id2, info2) = new_sub(&st, "gen2", &root);
        let wt2 = PathBuf::from(&info2.path);
        std::fs::create_dir_all(wt2.join("gen")).unwrap();
        std::fs::write(wt2.join("gen").join("settings.gradle"), "generated\n").unwrap();
        ensure_setup(&info2).unwrap();
        std::fs::create_dir_all(wt2.join("scratch")).unwrap();
        std::fs::write(wt2.join("scratch").join("notes.txt"), "mine\n").unwrap();
        let Removal::Kept(why) = remove_if_safe(&info2) else { panic!("the sub's own ignored file would be deleted silently") };
        assert!(why.contains("scratch"), "{why}");
        assert!(wt2.join("scratch").join("notes.txt").is_file());
    }

    /// Commits made on a detached HEAD belong to no branch, so removing the tree
    /// made them unreachable.
    #[test]
    fn a_detached_head_with_commits_no_branch_holds_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (_id, info) = new_sub(&st, "detached", &root);
        let wt = PathBuf::from(&info.path);
        g(&wt, &["checkout", "-q", "--detach"]);
        commit_file(&wt, "lost.txt", "only on the detached HEAD\n");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("the commit would be lost") };
        assert!(why.contains("detached"), "{why}");
        assert!(wt.join("lost.txt").is_file());
        // A detached HEAD that a branch holds loses nothing.
        let (_id2, info2) = new_sub(&st, "detached-safe", &root);
        g(Path::new(&info2.path), &["checkout", "-q", "--detach"]);
        assert_eq!(remove_if_safe(&info2), Removal::Removed);
    }

    /// A merge that panics, or whose thread never started, must not leave the repo
    /// counted as merging: a gate sub waits on that for as long as the daemon runs.
    #[test]
    fn a_merge_in_flight_is_released_when_its_holder_panics_or_is_dropped_unrun() {
        let key = format!("guard-{}", uuid::Uuid::new_v4());
        let panicked = std::panic::catch_unwind(|| {
            let _in_flight = begin_merge(&key);
            assert!(merging(&key));
            panic!("the merge blew up");
        });
        assert!(panicked.is_err());
        assert!(!merging(&key), "a panic released it");
        let held = begin_merge(&key);
        let held_twice = begin_merge(&key);
        drop(held);
        assert!(merging(&key), "two merges: one is still running");
        // A closure that owns the guard and is dropped without running, as the
        // merge thread's is when the thread cannot start.
        let work = move || drop(held_twice);
        drop(work);
        assert!(!merging(&key), "an unstarted thread released it");
    }

    /// Starts a rebase that stops half way, the state a daemon killed during
    /// `git rebase` leaves: detached, `rebase-merge` in the git dir.
    fn half_rebased(st: &Arc<DaemonState>, tag: &str, root: &Path) -> (String, WorktreeInfo) {
        let (id, info) = new_sub(st, tag, root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "sub\n");
        commit_file(root, "peer.txt", "landed meanwhile\n");
        let stopped = run(&wt, &["rebase", "--exec", "exit 1", &branch_ref(&info.target)]);
        assert!(!stopped.ok, "precondition: the rebase stops");
        assert!(current_branch(&wt).is_none(), "precondition: the tree is detached");
        (id, info)
    }

    #[test]
    fn a_rebase_the_daemon_left_half_done_is_aborted_so_the_next_land_works() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = half_rebased(&st, "killed", &root);
        let wt = PathBuf::from(&info.path);
        // What update_branch writes before it starts a rebase.
        let git_dir = run(&wt, &["rev-parse", "--absolute-git-dir"]).out.trim().to_string();
        std::fs::write(Path::new(&git_dir).join("cc-rebasing"), "rebasing\n").unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(current_branch(&wt).as_deref(), Some(info.branch.as_str()), "re-attached to its branch");
        assert_eq!(read(&root.join("a.txt")), "sub\n");
        assert_eq!(read(&root.join("peer.txt")), "landed meanwhile\n");
        assert!(!Path::new(&git_dir).join("cc-rebasing").exists(), "the mark is gone with the rebase");
    }

    /// A sub in the middle of its own conflict resolution has a rebase going too:
    /// only a rebase the app itself started is the app's to abort.
    #[test]
    fn a_rebase_the_sub_is_running_itself_is_never_aborted_by_the_app() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = half_rebased(&st, "own-rebase", &root);
        let wt = PathBuf::from(&info.path);
        let Landing::Blocked(b) = land(&id, &info) else { panic!("it cannot land with a rebase going") };
        assert!(b.text.contains("rebase is in progress"), "{}", b.text);
        assert!(current_branch(&wt).is_none(), "the sub's rebase is untouched");
        assert!(run(&wt, &["rebase", "--abort"]).ok, "the sub can still finish or abort it itself");
    }

    // ---- a sub's private build folder ---------------------------------------------------------------

    /// Some build output in the sub's own build folder, as cargo leaves it.
    fn fill_build_folder(info: &WorktreeInfo) -> PathBuf {
        let target = holder_of(info).expect("a new tree has a folder around it").join("target");
        let deps = target.join("debug").join("deps");
        std::fs::create_dir_all(&deps).unwrap();
        std::fs::write(deps.join("libapp-0123.rlib"), vec![0u8; 4096]).unwrap();
        target
    }

    /// A finished sub's tree stays until its main chat closes, and its build folder
    /// (5 to 17GB of recompiled dependencies) stayed with it.
    #[test]
    fn a_sub_that_finished_and_landed_frees_its_build_folder_but_keeps_its_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "frees", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        let target = fill_build_folder(&info);
        assert!(defer(&st, &id, rest_probe));
        assert!(!target.exists(), "the build output is gone once its commits landed");
        let holder = holder_of(&info).unwrap();
        assert!(Path::new(&info.path).is_dir() && holder.join(".cargo").join("config.toml").is_file(), "the tree and its config stay, so a continued sub builds again");
        assert_eq!(read(&root.join("a.txt")), "sub\n");
    }

    /// The merge thread checks that the sub is idle and deletes afterwards; a nudge that
    /// continues the sub in between (a cargo may start in the folder) must win.
    #[tokio::test]
    async fn a_sub_continued_after_its_merge_started_keeps_its_build_folder() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "continued-mid-merge", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        let target = fill_build_folder(&info);
        let seen = continued_count(&id);
        // The continue path: runs before the sub's message, so before its busy flag.
        before_continue(&st, &id).await;
        free_build_folder(&st, &id, &info, seen);
        assert!(target.is_dir(), "a continued sub's build folder is not deleted under it");
        // Counted from the continue on, so a later finish frees it as usual.
        free_build_folder(&st, &id, &info, continued_count(&id));
        assert!(!target.exists());
    }

    /// A visiting sub has no merge thread: its build folder is freed from the finish
    /// hook, and a continue (which skips the rebase for a visiting sub) must still move
    /// the count, or the delete would run under the new turn's cargo.
    #[tokio::test]
    async fn a_visiting_sub_continued_after_its_finish_keeps_its_build_folder() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let base = git::head(&root).unwrap();
        let Ok(Prepare::Ready(p)) = prepare_at(&root, "c0c0c0c0-0000", &base, "pc-branch") else { panic!("ready") };
        let id = "visitor-build".to_string();
        st.registry.upsert_interactive(&id, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&id, Some("home-main".into()));
        crate::daemon::subchats::store_visiting_brief(&id, "home-main", "pc");
        let mut brief = chat_config::get(&id).unwrap().subchat.unwrap();
        brief.worktree_at = Some(p.info.clone());
        chat_config::set_subchat(&id, Some(brief));
        let target = fill_build_folder(&p.info);
        let seen = continued_count(&id);
        before_continue(&st, &id).await;
        free_build_folder(&st, &id, &p.info, seen);
        assert!(target.is_dir(), "the continue moved the count, so the delete that began before it skips");
        free_build_folder(&st, &id, &p.info, continued_count(&id));
        assert!(!target.exists(), "a later finish frees it as usual");
    }

    /// Generated sources and codegen output a cargo build rewrites are nobody's
    /// work: a sub that built must not be kept for them.
    #[test]
    fn codegen_output_and_generated_sources_do_not_count_as_the_subs_ignored_work() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", "**/gen/schemas/\n*.generated.ts\n");
        let st = state();
        let (_id, info) = new_sub(&st, "codegen", &root);
        let wt = PathBuf::from(&info.path);
        ensure_setup(&info).unwrap();
        std::fs::create_dir_all(wt.join("src-tauri/gen/schemas")).unwrap();
        std::fs::write(wt.join("src-tauri/gen/schemas/a.json"), "{}\n").unwrap();
        std::fs::write(wt.join("ipc.generated.ts"), "export {}\n").unwrap();
        assert_eq!(remove_if_safe(&info), Removal::Removed);
    }

    /// A git that cannot list the ignored files must refuse the removal, not read as "none".
    #[test]
    fn a_git_that_cannot_list_the_ignored_files_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (_id, info) = new_sub(&st, "nolist", &root);
        let wt = PathBuf::from(&info.path);
        // Not a repository: every git call there fails.
        let outside = tempfile::tempdir().unwrap();
        let listed = worktree_safety::ignored_work(outside.path());
        assert!(listed.iter().any(|p| p.contains("could not list")), "{listed:?}");
        assert!(wt.is_dir());
    }

    /// The build-output exclusion stays narrow: the sub's own ignored files under a
    /// different `gen` folder, or named like a target folder, are still listed by
    /// `ignored_work` and keep the tree.
    #[test]
    fn an_ignored_file_under_a_look_alike_of_build_output_is_listed_and_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", "scripts/gen/*\nnotes/*\n");
        let st = state();
        let (_id, info) = new_sub(&st, "lookalike", &root);
        let wt = PathBuf::from(&info.path);
        ensure_setup(&info).unwrap();
        std::fs::create_dir_all(wt.join("scripts/gen")).unwrap();
        std::fs::write(wt.join("scripts/gen/local.env"), "mine\n").unwrap();
        std::fs::create_dir_all(wt.join("notes")).unwrap();
        std::fs::write(wt.join("notes/target-plan.md"), "mine\n").unwrap();
        let listed = worktree_safety::ignored_work(&wt).join(" ");
        assert!(listed.contains("local.env") && listed.contains("target-plan.md"), "{listed}");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("the sub's own ignored files would be deleted silently") };
        assert!(why.contains("local.env") && why.contains("target-plan.md"), "{why}");
    }

    #[test]
    fn a_finish_whose_merge_is_refused_keeps_the_build_folder() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "keeps", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub's line\n");
        commit_file(&root, "base.txt", "peer's line\n");
        let target = fill_build_folder(&info);
        assert!(defer(&st, &id, rest_probe));
        assert!(target.is_dir(), "the sub has a conflict to fix and builds on");
    }

    #[test]
    fn the_start_up_sweep_frees_the_build_folder_of_idle_finished_subs_only() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let mut subs = Vec::new();
        for tag in ["sw-done", "sw-running", "sw-busy", "sw-task", "sw-orphan"] {
            let (id, info) = new_sub(&st, tag, &root);
            subs.push((id, fill_build_folder(&info), info));
        }
        let [done, running, busy, task, orphan] = &subs[..] else { unreachable!() };
        for (id, _, _) in [done, busy, task] {
            st.registry.set_subchat_finished(id, true);
        }
        st.registry.set_busy(&busy.0, true);
        st.registry.set_turn_activity(&task.0, crate::sessions::registry_turn::TurnActivity::Working);
        // A holder no registry row names: nothing says it is finished.
        st.registry.set_subchat_of(&orphan.0, None);
        let long_ago = std::time::SystemTime::now() + Duration::from_secs(4 * 3600);
        sweep_ended_at(&st, std::time::SystemTime::now());
        assert!(done.1.is_dir(), "written within the last three hours");
        sweep_ended_at(&st, long_ago);
        assert!(!done.1.exists(), "finished, idle and quiet: freed");
        assert!(Path::new(&done.2.path).is_dir(), "the tree stays");
        assert!(running.1.is_dir(), "a sub that has not finished keeps its build");
        assert!(busy.1.is_dir(), "a sub in a turn keeps its build");
        assert!(task.1.is_dir(), "a sub with a background task keeps its build");
        assert!(orphan.1.is_dir(), "a holder no row names is never touched");
    }

    // ---- facts ----------------------------------------------------------------------------------

    #[test]
    fn the_cards_facts_read_the_worktree_and_say_what_landed() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "facts", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "one\n");
        commit_file(&wt, "a.txt", "two\n");
        std::fs::write(wt.join("b.txt"), "not committed\n").unwrap();
        let transcript = test_repo::transcript(_d.path(), &[("Write", &wt.join("a.txt")), ("Write", &wt.join("b.txt"))]);
        let inst = st.registry.get(&id).unwrap();
        let facts_of = |inst: &crate::types::Instance| {
            card_log::sub_facts(inst, crate::types::SubchatCheck::FactsOnly, None, &[], Some(&transcript))
        };
        let f = facts_of(&inst);
        assert_eq!(f.commits, Some(2), "counted from the tree, not the main checkout");
        assert_eq!(f.uncommitted, Some(1), "{:?}", f.uncommitted_files);
        assert_eq!(f.uncommitted_files, vec!["b.txt".to_string()]);
        assert_eq!(f.pushed, None, "no remote: not pushed stays unknown, never a guess");
        assert_eq!(f.merged_into.as_deref(), Some(info.target.as_str()));
        assert_eq!(f.merged, Some(false), "nothing landed yet");
        std::fs::remove_file(wt.join("b.txt")).unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        let after = facts_of(&inst);
        assert_eq!(after.merged, Some(true));
        assert_eq!(after.commits, Some(2), "the base does not jump to the merged tip");
    }

    #[test]
    fn a_rebase_does_not_make_the_peers_commits_count_as_the_subs() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "rebased", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "mine\n");
        commit_file(&root, "peer1.txt", "p\n");
        commit_file(&root, "peer2.txt", "p\n");
        assert_eq!(land(&id, &info), Landing::Merged);
        let inst = st.registry.get(&id).unwrap();
        // Commits are attributed through the files the sub edited, so it needs a transcript.
        let transcript = test_repo::transcript(_d.path(), &[("Write", &wt.join("a.txt"))]);
        let f = card_log::sub_facts(&inst, crate::types::SubchatCheck::FactsOnly, None, &[], Some(&transcript));
        assert_eq!(f.commits, Some(1), "only the sub's own commit, not the two the peer made");
    }

    /// 2026-11-14: the sub's main chat was judged gone while its tree was being set
    /// up, the sub ended and its tree was removed, and the launch went on to report
    /// the missing tree to the main chat as a problem to fix.
    #[tokio::test]
    async fn a_sub_that_ended_while_its_tree_was_set_up_stops_the_launch_quietly() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, _info) = new_sub(&st, "endedsetup", &root);
        st.registry.mark_ended(&id, crate::types::EndReason::Manual, "2026-11-14T17:43:16Z");
        let err = before_launch(&st, &id).await.expect_err("an ended sub does not launch");
        assert_eq!(err, super::super::held::ENDED_BEFORE_START);
        assert_eq!(wakes(&st, "endedsetup-main"), 0, "nothing to tell the main chat");
    }

    /// 2026-11-14: the queued launch of a sub that ended while its tree was being set
    /// up drew a "could not start" wake to its main chat, which had nothing to retry.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_queued_sub_that_ends_during_its_setup_is_forgotten_without_a_wake() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        commit_file(&root, "scripts/bootstrap-worktree.ps1", "Start-Sleep -Seconds 3
");
        let st = state();
        let (id, info) = new_sub(&st, "endmid", &root);
        super::super::held::hold(
            &st,
            super::super::held::Held {
                sub_id: id.clone(),
                reason: SETUP_TEXT.to_string(),
                after: None,
                after_name: String::new(),
                cleared: Vec::new(),
                launch: super::super::held::LaunchSpec { cwd: PathBuf::from(&info.cwd), model: "sonnet".into(), effort: "high".into(), account_id: None, first_message: "go".into() },
            },
        )
        .unwrap();

        let running = tokio::spawn({
            let (st, id) = (st.clone(), id.clone());
            async move { super::super::writers::run_start(&st, super::super::writers::Start::Launch { sub_id: id }).await }
        });
        tokio::time::sleep(Duration::from_millis(1200)).await;
        st.registry.mark_ended(&id, crate::types::EndReason::Manual, "2026-11-14T17:43:16Z");
        running.await.unwrap();

        assert!(!super::super::held::is_held(&id), "its recipe is gone");
        assert!(super::super::plumbing::current(&id).is_none(), "no start failure is recorded for the main chat");
        assert_eq!(wakes(&st, "endmid-main"), 0);
    }
