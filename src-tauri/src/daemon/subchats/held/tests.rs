    use super::*;
    use crate::daemon::subchats::lost_hold::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{store_sub_brief, SubchatArgs, TempDataDir};
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn here() -> PathBuf {
        std::env::current_dir().unwrap()
    }

    fn row(st: &DaemonState, id: &str) {
        if st.registry.get(id).is_none() {
            st.registry.upsert_interactive(id, &here(), "proj", "2026-11-05T00:00:00Z");
        }
    }

    /// A sub of `parent` named `name`, with a stored brief so it reads as a sub everywhere.
    fn sub_of(st: &DaemonState, parent: &str, id: &str, name: &str) {
        row(st, parent);
        row(st, id);
        st.registry.set_subchat_of(id, Some(parent.into()));
        st.registry.set_name(id, name.into());
        store_sub_brief(id, parent);
    }

    fn spec(first: &str) -> LaunchSpec {
        LaunchSpec {
            cwd: here(),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: first.into(),
        }
    }

    /// `sub` (named `name`) held behind `target` (named `target_name`).
    fn hold_behind(st: &DaemonState, parent: &str, sub: &str, name: &str, target: &str, target_name: &str) {
        sub_of(st, parent, sub, name);
        hold(
            st,
            Held {
                sub_id: sub.into(),
                reason: format!("waiting for {target_name}"),
                after: Some(target.into()),
                after_name: target_name.into(),
                cleared: Vec::new(),
                launch: spec("do the footer"),
            },
        )
        .unwrap();
    }

    type Calls = Arc<Mutex<Vec<String>>>;

    /// A launcher that records the sub it was asked to start and releases it, as a
    /// real start would, without spawning a `claude`.
    fn launcher(calls: &Calls) -> impl Fn(Arc<DaemonState>, String) -> std::future::Ready<Result<(), String>> {
        let calls = calls.clone();
        move |st, id| {
            calls.lock().unwrap().push(id.clone());
            release(&st, &id);
            std::future::ready(Ok(()))
        }
    }

    fn failing_launcher(calls: &Calls) -> impl Fn(Arc<DaemonState>, String) -> std::future::Ready<Result<(), String>> {
        let calls = calls.clone();
        move |_st, id| {
            calls.lock().unwrap().push(id);
            std::future::ready(Err("no account is set up".to_string()))
        }
    }

    fn calls() -> Calls {
        Arc::new(Mutex::new(Vec::new()))
    }

    async fn cards_of_kind(st: &Arc<DaemonState>) -> Vec<serde_json::Value> {
        st.list_prompts().await.into_iter().filter(|p| p["payload"]["card_kind"] == CARD_KIND).collect()
    }

    /// The main chat's queued wakes, oldest first.
    fn wakes(st: &DaemonState, main: &str) -> Vec<String> {
        st.repo_channel_wakes.lock().unwrap().get(main).map(|q| q.iter().map(|l| l.text.clone()).collect()).unwrap_or_default()
    }

    fn option_labels(card: &serde_json::Value) -> Vec<String> {
        card["payload"]["questions"][0]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["label"].as_str().unwrap().to_string())
            .collect()
    }

    // ── what counts as blocked ─────────────────────────────────────────────

    #[test]
    fn a_blocked_verdict_or_a_bad_tone_is_blocked_and_an_ordinary_finish_is_not() {
        let rec = |verdict: &str, tone: Option<&str>| FinishRecord {
            verdict: verdict.into(),
            tone: tone.map(str::to_string),
            ..FinishRecord::default()
        };
        assert!(is_blocked_finish(&rec("Blocked", None)));
        assert!(is_blocked_finish(&rec("Blocked on auth", None)));
        assert!(is_blocked_finish(&rec("Stuck, blocked.", None)));
        assert!(is_blocked_finish(&rec("Tests still failing", Some("bad"))), "a bad tone is a bad outcome");
        assert!(!is_blocked_finish(&rec("Built, not pushed", None)));
        assert!(!is_blocked_finish(&rec("Unblocked the build", Some("good"))), "a different word");
        assert!(!is_blocked_finish(&rec("", None)));
    }

    #[test]
    fn the_target_is_pending_while_it_runs_clean_when_finished_and_blocked_when_ended_or_gone() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "as-main", "as-run", "running");
        assert_eq!(after_state(&st, "as-run"), AfterState::Pending);

        sub_of(&st, "as-main", "as-ok", "ok");
        st.registry.set_subchat_finished("as-ok", true);
        assert_eq!(after_state(&st, "as-ok"), AfterState::Clean, "no readable record: unknown never blocks");
        test_support::finish_record("as-ok", "Built, not pushed", Some("good"));
        assert_eq!(after_state(&st, "as-ok"), AfterState::Clean);

        sub_of(&st, "as-main", "as-blk", "blk");
        st.registry.set_subchat_finished("as-blk", true);
        test_support::finish_record("as-blk", "Blocked on the schema", None);
        assert!(matches!(after_state(&st, "as-blk"), AfterState::Blocked(w) if w.contains("Blocked on the schema")));

        sub_of(&st, "as-main", "as-end", "end");
        st.registry.mark_ended("as-end", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(matches!(after_state(&st, "as-end"), AfterState::Blocked(_)));

        // Finished first, closed afterwards: still blocked, since closing drops a refused
        // merge and the waiting job would build on commits that never landed.
        sub_of(&st, "as-main", "as-closed", "closed");
        st.registry.set_subchat_finished("as-closed", true);
        st.registry.mark_ended("as-closed", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(matches!(after_state(&st, "as-closed"), AfterState::Blocked(_)));
        assert!(matches!(after_state(&st, "as-gone"), AfterState::Blocked(_)));
    }

    // ── resolving `after` ──────────────────────────────────────────────────

    #[test]
    fn after_resolves_among_the_parents_subs_finished_or_running_and_refuses_none_or_several() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "pa-main", "pa-fix-a", "fix-a");
        sub_of(&st, "pa-main", "pa-fix-b", "fix-b");
        sub_of(&st, "pa-main", "pa-docs", "docs");
        sub_of(&st, "pa-other", "pa-foreign", "foreign");

        let hold_plan = plan_after(&st, "pa-main", "docs").unwrap().expect("a running target holds");
        assert_eq!(hold_plan.targets, vec![("pa-docs".to_string(), "docs".to_string())]);

        let err = plan_after(&st, "pa-main", "fix").unwrap_err();
        assert!(err.starts_with("after: ") && err.contains("more than one sub") && err.contains("fix-a") && err.contains("fix-b"), "{err}");

        let err = plan_after(&st, "pa-main", "nothing-like-it").unwrap_err();
        assert!(err.contains("No sub named") && err.contains("docs") && err.contains("fix-a"), "{err}");

        let err = plan_after(&st, "pa-main", "foreign").unwrap_err();
        assert!(err.contains("No sub named"), "another main chat's sub is not an option: {err}");
    }

    /// A dropped sub's name is reused in a long-lived main chat: `after` waits for
    /// the live one, the same as the `subchat` tool resolves it.
    #[test]
    fn after_a_reused_name_waits_for_the_live_sub_and_not_the_dropped_one() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "pr-main", "pr-dropped", "docs");
        st.registry.mark_ended("pr-dropped", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        sub_of(&st, "pr-main", "pr-live", "docs");
        let plan = plan_after(&st, "pr-main", "docs").unwrap().expect("the live sub runs, so it holds");
        assert_eq!(plan.targets[0].0, "pr-live");
    }

    #[test]
    fn an_already_finished_target_means_start_now_and_an_already_blocked_one_is_refused() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "pb-main", "pb-done", "done");
        st.registry.set_subchat_finished("pb-done", true);
        test_support::finish_record("pb-done", "Built, not pushed", None);
        assert_eq!(plan_after(&st, "pb-main", "done").unwrap(), None, "nothing to wait for");

        sub_of(&st, "pb-main", "pb-bad", "bad");
        st.registry.set_subchat_finished("pb-bad", true);
        test_support::finish_record("pb-bad", "Blocked", None);
        let err = plan_after(&st, "pb-main", "bad").unwrap_err();
        assert!(err.contains("ended blocked") && err.contains("without after"), "{err}");
        assert!(!err.contains("Tell Joe") && err.contains("say nothing of your own"), "the blocked sub's card tells Joe: {err}");
    }

    // ── holding ────────────────────────────────────────────────────────────

    #[test]
    fn a_hold_persists_marks_the_row_waiting_and_a_second_hold_replaces_the_first() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "h1-main", "h1-sub", "footer", "h1-target", "header");
        assert!(is_held("h1-sub") && !is_held("h1-other"));
        assert_eq!(st.registry.get("h1-sub").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));
        let mut again = all().into_iter().find(|h| h.sub_id == "h1-sub").unwrap();
        again.reason = "waiting for the writer slot".into();
        hold(&st, again).unwrap();
        assert_eq!(all().iter().filter(|h| h.sub_id == "h1-sub").count(), 1);
        assert_eq!(st.registry.get("h1-sub").unwrap().progress.waiting_for.as_deref(), Some("waiting for the writer slot"));
        let taken = release(&st, "h1-sub").expect("it was held");
        assert_eq!(taken.launch.first_message, "do the footer");
        assert!(!is_held("h1-sub") && st.registry.get("h1-sub").unwrap().progress.waiting_for.is_none());
        assert!(release(&st, "h1-sub").is_none());
    }

    #[test]
    fn registering_makes_a_counted_waiting_row_with_its_brief_and_a_released_slot() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "rg-main", "rg-header", "header");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(false),
            after: Some("header".into()),
            ..Default::default()
        };
        let mut plan = super::super::spawn::plan(&st, "rg-main", &cfg, &here().to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        assert_eq!(plan.hold.as_ref().map(|h| h.targets[0].0.as_str()), Some("rg-header"));
        let sid = register_row(&st, "rg-main", Some("footer"), &cfg, spec(&plan.first_message), &mut plan).unwrap();

        let inst = st.registry.get(&sid).unwrap();
        assert_eq!(inst.subchat_of.as_deref(), Some("rg-main"));
        assert!(!inst.busy && inst.ended_at.is_none() && !inst.subchat_finished);
        assert_eq!(inst.progress.waiting_for.as_deref(), Some("waiting for header"));
        let brief = crate::sessions::chat_config::get(&sid).unwrap().subchat.expect("brief stored");
        assert_eq!((brief.task.as_str(), brief.after.as_deref()), ("Footer", Some("header")));
        let entry = all().into_iter().find(|h| h.sub_id == sid).unwrap();
        assert_eq!(entry.after.as_deref(), Some("rg-header"));
        assert!(entry.launch.first_message.contains("Footer"), "{}", entry.launch.first_message);
        // The row is an unfinished sub (header + footer) but holds no cap slot: it has no process yet.
        assert_eq!(super::super::spawn::running_subs(&st.registry, "rg-main").len(), 2);
        assert!(!super::super::spawn::started_subs(&st, "rg-main").iter().any(|i| i.session_id == sid));
        assert_eq!(super::super::tool::status_word(&inst), "queued");
    }

    #[test]
    fn a_held_sub_does_not_count_toward_the_cap_of_started_subs() {
        let _d = TempDataDir::new();
        let st = state();
        let cap = super::super::spawn::MAX_RUNNING;
        for n in 0..cap - 1 {
            sub_of(&st, "cp-main", &format!("cp-run{n}"), &format!("job-{n}"));
            st.registry.set_busy(&format!("cp-run{n}"), true);
        }
        hold_behind(&st, "cp-main", "cp-held", "queued-job", "cp-run0", "job-0");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(false),
            ..Default::default()
        };
        // One slot is left: the held sub has no process, so it does not use it.
        let mut last = super::super::spawn::plan(&st, "cp-main", &cfg, &here().to_string_lossy(), None, None, None, Some("last"), &args, &[])
            .unwrap()
            .expect("the held sub holds no slot");
        // That plan now holds the last slot until its row exists.
        let err = super::super::spawn::plan(&st, "cp-main", &cfg, &here().to_string_lossy(), None, None, None, Some("over"), &args, &[])
            .err()
            .expect("the cap is reached by started subs plus the plan in flight");
        assert!(err.contains("job-0") && !err.contains("queued-job"), "only started subs are named: {err}");
        last.release_slot();
    }

    /// A sub registered to wait (`after`) starts nothing, so a main chat chaining 25 of
    /// them in one burst must not spend the chat start budget (2026-11-21: the 16th was
    /// refused and a card went to Joe). Its start is counted by `launch_claimed`.
    #[tokio::test]
    async fn registering_a_queued_chain_counts_no_starts() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "qc-main", "qc-header", "header");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let before = crate::daemon::spawn_rate::test_admits();
        for n in 0..25 {
            let args = SubchatArgs {
                task: Some("t".into()),
                goal: Some("g".into()),
                done_when: Some("d".into()),
                writes: Some(false),
                after: Some("header".into()),
                ..Default::default()
            };
            let name = format!("job{n}");
            let plan = super::super::spawn::plan(&st, "qc-main", &cfg, &here().to_string_lossy(), None, None, None, Some(&name), &args, &[])
                .unwrap()
                .unwrap();
            assert!(plan.hold.is_some());
            // Whether the row registers depends on an accounts file; the count must not move either way.
            let _ = crate::daemon::methods::spawn_chat::spawn_chat(&st, "qc-main", ".", "x", None, None, Some(&name), false, Some(plan)).await;
        }
        assert_eq!(crate::daemon::spawn_rate::test_admits(), before, "queued registrations counted as starts");
    }

    #[test]
    fn continuing_a_held_sub_is_refused_before_anything_is_cleared() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "ms-main", "ms-held", "footer", "ms-target", "header");
        let err = super::super::resume::prepare_continue(&st, "ms-held").unwrap_err();
        assert!(matches!(err, super::super::ContinueError::Held(_)), "{err:?}");
        assert!(err.to_string().contains("has not started yet"), "{err}");
        assert!(st.registry.get("ms-held").unwrap().subchat_of.is_some());
    }

    #[tokio::test]
    async fn moving_a_held_sub_to_the_sidebar_and_typing_to_it_are_refused() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "mv-main", "mv-held", "footer", "mv-target", "header");
        let moved = super::super::move_to_sidebar(&st, "mv-held").await.unwrap_err();
        assert!(matches!(moved, super::super::MoveError::Held(_)), "{moved:?}");
        assert!(st.registry.get("mv-held").unwrap().subchat_of.is_some(), "still a sub");
        let typed = super::super::route_send(&st, "mv-held", "also blue").await.expect("routed, not ordinary");
        assert!(matches!(typed, Err(super::super::ContinueError::Held(_))), "{typed:?}");
    }

    // ── starting and the restart ───────────────────────────────────────────

    #[tokio::test]
    async fn the_target_finishing_starts_the_held_sub_and_only_it_without_touching_the_main_chat() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "go-main", "go-target", "header");
        hold_behind(&st, "go-main", "go-held", "footer", "go-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "the target still runs");

        st.registry.set_subchat_finished("go-target", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["go-held"]);
        assert!(!is_held("go-held"), "started, so no longer held");
        let main = st.registry.get("go-main").unwrap();
        assert!(!main.busy && main.awaiting.is_none(), "the main agent is not woken");
        assert!(st.list_prompts().await.is_empty(), "and Joe is not asked anything");
    }

    #[tokio::test]
    async fn a_chain_starts_one_link_at_a_time() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ch-main", "ch-c", "c");
        hold_behind(&st, "ch-main", "ch-b", "b", "ch-c", "c");
        hold_behind(&st, "ch-main", "ch-a", "a", "ch-b", "b");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty());

        st.registry.set_subchat_finished("ch-c", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["ch-b"], "a waits on b, which has only just started");

        st.registry.set_subchat_finished("ch-b", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["ch-b", "ch-a"]);
    }

    #[tokio::test]
    async fn the_hold_survives_a_restart_and_a_finish_while_the_daemon_was_down_releases_it_at_boot() {
        let _d = TempDataDir::new();
        let before = state();
        sub_of(&before, "rs-main", "rs-target", "header");
        hold_behind(&before, "rs-main", "rs-held", "footer", "rs-target", "header");
        // The target finishes and the daemon dies before anyone looks.
        before.registry.set_subchat_finished("rs-target", true);
        test_support::finish_record("rs-target", "Built, not pushed", None);
        crate::sessions::persistence::save_snapshot_default(&before.registry);

        // A new process: a fresh registry restored from the snapshot, same data dir.
        let after = state();
        let path = crate::settings::paths::interactive_sessions_file().unwrap();
        crate::sessions::persistence::populate_registry(&after.registry, crate::sessions::persistence::load_snapshot(&path));
        assert!(after.registry.get("rs-held").is_some(), "the row came back");
        assert!(after.registry.get("rs-held").unwrap().progress.waiting_for.is_none(), "the mark is in memory only");
        restamp(&after);
        assert_eq!(after.registry.get("rs-held").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));
        assert!(is_held("rs-held"), "the recipe was on disk");

        let seen = calls();
        release_ready(&after, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["rs-held"], "the finish that happened while down releases it");
    }

    /// Fails on the old code, which put a "could not start: Try again / Drop it" card
    /// in front of Joe.
    #[tokio::test]
    async fn a_failed_start_keeps_the_sub_held_wakes_the_main_chat_once_and_asks_joe_nothing() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "fl-main", "fl-target", "header");
        st.registry.set_subchat_finished("fl-target", true);
        hold_behind(&st, "fl-main", "fl-held", "footer", "fl-target", "header");
        let seen = calls();
        release_ready(&st, failing_launcher(&seen)).await;
        release_ready(&st, failing_launcher(&seen)).await;
        assert_eq!(seen.lock().unwrap().len(), 1, "a failure is the main chat's to retry, not the tick's");
        assert!(is_held("fl-held"), "nothing is lost");
        assert!(st.list_prompts().await.is_empty(), "no card for Joe");
        assert_eq!(wakes(&st, "fl-main").len(), 1, "the main chat is woken once");
        assert!(wakes(&st, "fl-main")[0].contains("could not start") && wakes(&st, "fl-main")[0].contains("action retry"));
        let rec = super::super::plumbing::current("fl-held").unwrap();
        assert!(rec.detail.contains("no account is set up"), "status carries the error: {}", rec.detail);
        super::super::plumbing::clear("fl-held");
    }

    /// Two chains finishing together each run a pass over one snapshot of the held set; the
    /// pass that loses the claim race finds the hold gone ("is not held"). Live run
    /// 2026-11-21: that read as a failed start, woke the main chat and parked a running sub.
    #[tokio::test]
    async fn a_pass_that_lost_the_start_race_neither_wakes_the_main_chat_nor_parks_the_sub() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "rc-main", "rc-target", "header");
        st.registry.set_subchat_finished("rc-target", true);
        hold_behind(&st, "rc-main", "rc-held", "footer", "rc-target", "header");
        let seen = calls();
        let lost = {
            let seen = seen.clone();
            move |st: Arc<DaemonState>, id: String| {
                seen.lock().unwrap().push(id.clone());
                // The winner started it and removed the hold before this launch looked.
                release(&st, &id);
                std::future::ready(Err(format!("{id} is not held")))
            }
        };
        release_ready(&st, lost).await;
        assert_eq!(*seen.lock().unwrap(), ["rc-held"]);
        assert!(wakes(&st, "rc-main").is_empty(), "no could-not-start wake: {:?}", wakes(&st, "rc-main"));
        assert!(super::super::plumbing::current("rc-held").is_none());
        assert!(!parked("rc-held"));
    }

    /// `subchat retry` starts it by the code behind the old "Try again", and the
    /// problem is gone once it runs.
    #[tokio::test]
    async fn retry_starts_a_sub_whose_start_failed_and_refuses_one_that_merely_waits() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "rt-main", "rt-target", "header");
        hold_behind(&st, "rt-main", "rt-waits", "footer", "rt-target", "header");
        let seen = calls();
        let err = retry_with(&st, "rt-waits", launcher(&seen)).await.unwrap_err();
        assert!(err.contains("no failed start"), "{err}");
        assert!(seen.lock().unwrap().is_empty(), "a sub that only waits is not started out of order");

        st.registry.set_subchat_finished("rt-target", true);
        release_ready(&st, failing_launcher(&seen)).await;
        assert!(super::super::plumbing::current("rt-waits").is_some());
        // Still failing: the tool says so, and the main chat is not woken a second time.
        let err = retry_with(&st, "rt-waits", failing_launcher(&seen)).await.unwrap_err();
        assert!(err.contains("still could not start") && err.contains("no account is set up"), "{err}");
        assert_eq!(wakes(&st, "rt-main").len(), 1);
        assert!(is_held("rt-waits"));
        // Fixed: it starts.
        retry_with(&st, "rt-waits", launcher(&seen)).await.unwrap();
        assert_eq!(seen.lock().unwrap().last().map(String::as_str), Some("rt-waits"));
        assert!(!is_held("rt-waits"));
        assert!(super::super::plumbing::current("rt-waits").is_none(), "resolved");
    }

    /// A held card still open when the sub starts comes down with the problem.
    #[tokio::test]
    async fn a_held_card_still_open_closes_when_the_sub_starts() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "hc-main", "hc-target", "header");
        st.registry.mark_ended("hc-target", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        hold_behind(&st, "hc-main", "hc-held", "footer", "hc-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(cards_of_kind(&st).await.len(), 1, "the blocked target asks Joe");
        super::super::plumbing::report(&st, "hc-held", super::super::plumbing::Problem::CouldNotStart, "x".into(), vec![]);
        retry_with(&st, "hc-held", launcher(&seen)).await.unwrap();
        let mut gone = false;
        for _ in 0..200 {
            if cards_of_kind(&st).await.is_empty() {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(gone, "the card about it closed once it started");
    }

    #[tokio::test]
    async fn launching_reaches_the_spawn_and_a_failure_there_loses_nothing() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ln-main", "ln-held", "footer");
        let mut missing = spec("go");
        missing.cwd = std::env::temp_dir().join(format!("cc-held-missing-{}", uuid::Uuid::new_v4()));
        hold(
            &st,
            Held { sub_id: "ln-held".into(), reason: "waiting for header".into(), after: None, after_name: String::new(), cleared: Vec::new(), launch: missing },
        )
        .unwrap();
        let err = launch_held(&st, "ln-held").await.unwrap_err();
        assert!(err.contains("cwd does not exist"), "it got as far as the spawn: {err}");
        assert!(is_held("ln-held"), "still queued for the next try");
        assert_eq!(st.registry.get("ln-held").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));
        assert!(launch_held(&st, "nobody").await.unwrap_err().contains("not held"));
    }

    // ── target ends blocked ────────────────────────────────────────────────

    /// A hold on several subs (`after: ["a", "b"]`) starts only when every one has
    /// finished cleanly, in either order, and a blocked one raises the card naming it.
    #[tokio::test]
    async fn a_hold_on_several_subs_starts_after_all_of_them_and_a_blocked_one_names_itself() {
        let _d = TempDataDir::new();
        let st = state();
        for (id, name) in [("ma-a", "alpha"), ("ma-b", "beta")] {
            sub_of(&st, "ma-main", id, name);
        }
        let queries = vec!["alpha".to_string(), "beta".to_string(), "alpha".to_string()];
        let plan = plan_after_all(&st, "ma-main", &queries).unwrap().expect("both run, so it holds");
        assert_eq!(plan.targets, vec![("ma-a".to_string(), "alpha".to_string()), ("ma-b".to_string(), "beta".to_string())], "a repeated name counts once");
        sub_of(&st, "ma-main", "ma-gate", "gate");
        hold(
            &st,
            Held {
                sub_id: "ma-gate".into(),
                reason: "waiting for alpha, beta".into(),
                after: Some("ma-a\nma-b".into()),
                after_name: "alpha\nbeta".into(),
                cleared: Vec::new(),
                launch: spec("release"),
            },
        )
        .unwrap();

        let seen = calls();
        st.registry.set_subchat_finished("ma-b", true);
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "alpha still runs, so the gate waits");
        assert!(is_held("ma-gate"));

        st.registry.set_subchat_finished("ma-a", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), vec!["ma-gate".to_string()], "both finished: it starts");

        // One of the two ends blocked while the other still runs: Joe is asked at once.
        sub_of(&st, "ma-main", "ma-c", "gamma");
        sub_of(&st, "ma-main", "ma-d", "delta");
        sub_of(&st, "ma-main", "ma-gate2", "gate2");
        hold(
            &st,
            Held {
                sub_id: "ma-gate2".into(),
                reason: "waiting for gamma, delta".into(),
                after: Some("ma-c\nma-d".into()),
                after_name: "gamma\ndelta".into(),
                cleared: Vec::new(),
                launch: spec("release"),
            },
        )
        .unwrap();
        st.registry.set_subchat_finished("ma-d", true);
        test_support::finish_record("ma-d", "Blocked on the schema", None);
        release_ready(&st, launcher(&seen)).await;
        let cards = cards_of_kind(&st).await;
        assert_eq!(cards.len(), 1);
        assert!(cards[0].to_string().contains("**delta** ended blocked"), "the card names the blocked sub: {}", cards[0]);
        assert_eq!(seen.lock().unwrap().len(), 1, "gate2 did not start");
    }

    /// Two targets, one finished and merged then closed while the other still runs:
    /// the closed one finished cleanly, so the wait stays pending instead of raising
    /// "ended before it finished". Another one that finished with a refused merge and
    /// was closed later has never read clean, so it still blocks.
    #[tokio::test]
    async fn a_target_that_finished_cleanly_and_was_closed_stays_cleared_while_a_sibling_runs() {
        let _d = TempDataDir::new();
        let st = state();
        for (id, name) in [("cl-a", "alpha"), ("cl-b", "beta"), ("cl-c", "gamma")] {
            sub_of(&st, "cl-main", id, name);
        }
        sub_of(&st, "cl-main", "cl-gate", "gate");
        let entry = Held {
            sub_id: "cl-gate".into(),
            reason: "waiting for alpha, beta".into(),
            after: Some("cl-a\ncl-b".into()),
            after_name: "alpha\nbeta".into(),
            cleared: Vec::new(),
            launch: spec("release"),
        };
        hold(&st, entry).unwrap();
        let seen = calls();

        st.registry.set_subchat_finished("cl-a", true);
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty() && cards_of_kind(&st).await.is_empty(), "beta still runs");
        assert_eq!(all().into_iter().find(|h| h.sub_id == "cl-gate").unwrap().cleared, vec!["cl-a".to_string()]);

        st.registry.mark_ended("cl-a", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        release_ready(&st, launcher(&seen)).await;
        assert!(cards_of_kind(&st).await.is_empty(), "alpha finished and merged, closing it blocks nothing");
        assert!(seen.lock().unwrap().is_empty() && is_held("cl-gate"));

        st.registry.set_subchat_finished("cl-b", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), vec!["cl-gate".to_string()], "beta finished too: the gate starts");

        // A cleared target that goes back to work (a nudge, a merge conflict) holds the gate again.
        sub_of(&st, "cl-main", "cl-d", "delta");
        sub_of(&st, "cl-main", "cl-e", "epsilon");
        sub_of(&st, "cl-main", "cl-gate3", "gate3");
        hold(
            &st,
            Held {
                sub_id: "cl-gate3".into(),
                reason: "waiting for delta, epsilon".into(),
                after: Some("cl-d\ncl-e".into()),
                after_name: "delta\nepsilon".into(),
                cleared: Vec::new(),
                launch: spec("release"),
            },
        )
        .unwrap();
        st.registry.set_subchat_finished("cl-d", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(all().into_iter().find(|h| h.sub_id == "cl-gate3").unwrap().cleared, vec!["cl-d".to_string()]);
        st.registry.set_subchat_finished("cl-d", false);
        st.registry.set_subchat_finished("cl-e", true);
        release_ready(&st, launcher(&seen)).await;
        assert!(is_held("cl-gate3"), "delta is working again, so the gate keeps waiting");
        assert!(all().into_iter().find(|h| h.sub_id == "cl-gate3").unwrap().cleared == vec!["cl-e".to_string()], "delta's mark is dropped while it works");
        // Its second finish never lands and Joe closes it: now it counts as ended early.
        st.registry.mark_ended("cl-d", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        let gate3 = all().into_iter().find(|h| h.sub_id == "cl-gate3").unwrap();
        assert!(matches!(after_all(&st, &gate3).0, AfterState::Blocked(_)));
        assert_eq!(*seen.lock().unwrap(), vec!["cl-gate".to_string()]);

        // Finished with its merge refused (never read clean) and closed: still blocked.
        sub_of(&st, "cl-main", "cl-gate2", "gate2");
        hold(
            &st,
            Held {
                sub_id: "cl-gate2".into(),
                reason: "waiting for gamma".into(),
                after: Some("cl-c".into()),
                after_name: "gamma".into(),
                cleared: Vec::new(),
                launch: spec("release"),
            },
        )
        .unwrap();
        st.registry.set_subchat_finished("cl-c", true);
        st.registry.mark_ended("cl-c", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        let held = all().into_iter().find(|h| h.sub_id == "cl-gate2").unwrap();
        assert!(matches!(after_all(&st, &held).0, AfterState::Blocked(_)));
        assert!(all().into_iter().find(|h| h.sub_id == "cl-gate2").unwrap().cleared.is_empty());
    }

    #[test]
    fn an_entry_written_before_the_cleared_list_loads_with_it_empty() {
        let old: Held = serde_json::from_str(r#"{"sub_id":"s","after":"t-1\nt-2","after_name":"a\nb"}"#).unwrap();
        assert!(old.cleared.is_empty());
    }

    /// An `after` list reads as one name per line, from a string or an array, and an
    /// entry written before lists existed (one id) still reads as one target.
    #[test]
    fn after_reads_a_string_or_a_list_and_an_old_entry_has_one_target() {
        use super::super::brief::{after_names, SubchatArgs};
        let one: SubchatArgs = serde_json::from_value(serde_json::json!({"after": "alpha"})).unwrap();
        assert_eq!(one.after.as_deref(), Some("alpha"));
        let many: SubchatArgs = serde_json::from_value(serde_json::json!({"after": ["alpha", " beta ", ""]})).unwrap();
        assert_eq!(after_names(many.after.as_deref().unwrap()), vec!["alpha", "beta"]);
        let none: SubchatArgs = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(none.after.is_none());

        let old: Held = serde_json::from_str(r#"{"sub_id":"s","after":"t-1","after_name":"header"}"#).unwrap();
        assert_eq!(old.target_ids(), vec!["t-1"]);
        assert_eq!(old.names_display(), "header");
    }

    #[tokio::test]
    async fn a_blocked_target_raises_one_card_and_start_anyway_runs_the_sub() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "bk-main", "bk-target", "header");
        st.registry.set_subchat_finished("bk-target", true);
        test_support::finish_record("bk-target", "Blocked on the schema", None);
        hold_behind(&st, "bk-main", "bk-held", "footer", "bk-target", "header");

        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "never started behind Joe's back");
        let cards = cards_of_kind(&st).await;
        assert_eq!(cards.len(), 1, "one card per wait, not one per tick");
        assert_eq!(cards[0]["payload"]["display_session_id"], "bk-main");
        assert_eq!(cards[0]["payload"]["sub_id"], "bk-held");
        assert_eq!(option_labels(&cards[0]), [START_ANYWAY, DROP_IT]);
        let text = cards[0]["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("header") && text.contains("footer") && text.contains("Blocked on the schema"), "{text}");

        apply_answer(&st, "bk-held", CardAnswer::Picked(START_ANYWAY.into()), &launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["bk-held"]);
    }

    #[tokio::test]
    async fn drop_it_ends_the_waiting_sub_so_it_leaves_the_cap_and_the_list() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "dr-main", "dr-target", "header");
        st.registry.mark_ended("dr-target", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        hold_behind(&st, "dr-main", "dr-held", "footer", "dr-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(cards_of_kind(&st).await.len(), 1, "an ended target is blocked too");

        apply_answer(&st, "dr-held", CardAnswer::Picked(DROP_IT.into()), &launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty());
        assert!(!is_held("dr-held"));
        let row = st.registry.get("dr-held").unwrap();
        assert!(row.ended_at.is_some() && row.progress.waiting_for.is_none());
        assert!(super::super::spawn::running_subs(&st.registry, "dr-main").is_empty(), "the slot is free again");
    }

    #[tokio::test]
    async fn skipping_the_card_parks_the_sub_instead_of_asking_every_minute() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "sk-main", "sk-target", "header");
        st.registry.mark_ended("sk-target", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        hold_behind(&st, "sk-main", "sk-held", "footer", "sk-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        let card = cards_of_kind(&st).await.remove(0);
        apply_answer(&st, "sk-held", CardAnswer::Skipped, &launcher(&seen)).await;
        // The answered card is gone from the list, as it is in the app.
        crate::daemon::methods::permission::respond_question_inner(&st, card["id"].as_str().unwrap(), serde_json::json!({}), true).await;
        release_ready(&st, launcher(&seen)).await;
        assert!(cards_of_kind(&st).await.is_empty(), "a skip is left alone until the next restart");
        assert!(is_held("sk-held"));
    }

    // ── the main chat going away ───────────────────────────────────────────

    #[tokio::test]
    async fn a_held_sub_whose_main_chat_is_gone_is_dropped_not_promoted_but_a_respawn_keeps_it() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "gone-main", "gone-target", "header");
        hold_behind(&st, "gone-main", "gone-held", "footer", "gone-target", "header");
        // The main chat is respawned: it ends, and a row names it as its predecessor.
        row(&st, "gone-successor");
        st.registry.set_successor_of("gone-successor", "gone-main");
        st.registry.mark_ended("gone-main", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(is_held("gone-held"), "a respawn moves the subs, it does not end them");

        // A crash: no successor.
        sub_of(&st, "crash-main", "crash-target", "header");
        hold_behind(&st, "crash-main", "crash-held", "footer", "crash-target", "header");
        st.registry.mark_ended("crash-main", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        release_ready(&st, launcher(&seen)).await;
        assert!(!is_held("crash-held"));
        let row = st.registry.get("crash-held").unwrap();
        assert!(row.ended_at.is_some(), "ended, never run");
        assert_eq!(row.subchat_of.as_deref(), Some("crash-main"), "and not promoted to a sidebar chat");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn ending_a_queued_sub_forgets_its_recipe_so_it_can_never_start_later() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "en-main", "en-held", "footer", "en-target", "header");
        assert!(super::super::resume::end_sub(&st, "en-held"));
        assert!(!is_held("en-held"));
        assert!(st.registry.get("en-held").unwrap().progress.waiting_for.is_none());
    }

    #[tokio::test]
    async fn a_queued_row_that_ended_by_another_path_is_forgotten_not_started() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ex-main", "ex-target", "header");
        st.registry.set_subchat_finished("ex-target", true);
        hold_behind(&st, "ex-main", "ex-held", "footer", "ex-target", "header");
        st.registry.mark_ended("ex-held", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "an ended sub is never launched");
        assert!(!is_held("ex-held"));
        assert!(cards_of_kind(&st).await.is_empty(), "and Joe is not asked about it");
    }

    // ── a damaged file ──────────────────────────────────────────────────────

    fn held_file() -> PathBuf {
        file_path().unwrap()
    }

    fn bad_copies() -> Vec<String> {
        let dir = held_file().parent().unwrap().to_path_buf();
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(&format!("{}.bad", held_file().file_name().unwrap().to_string_lossy())))
            .collect()
    }

    /// One entry that will not decode used to make the whole file read as empty,
    /// and the next write then dropped every queued sub.
    #[test]
    fn one_unreadable_entry_does_not_empty_the_set_and_is_kept_aside() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "bad-main", "bad-one", "footer", "bad-t", "header");
        let mut entries: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(held_file()).unwrap()).unwrap();
        entries.push(serde_json::json!({ "reason": "no sub id, so nobody to start" }));
        std::fs::write(held_file(), serde_json::to_string(&entries).unwrap()).unwrap();

        assert!(is_held("bad-one"), "the readable entry is still held");
        hold_behind(&st, "bad-main", "bad-two", "docs", "bad-t", "header");
        assert!(is_held("bad-one") && is_held("bad-two"), "a write does not drop the queue");
        let copies = bad_copies();
        assert_eq!(copies.len(), 1, "{copies:?}");
        let kept = std::fs::read_to_string(held_file().with_file_name(&copies[0])).unwrap();
        assert!(kept.contains("no sub id"), "the unreadable entry is kept: {kept}");
    }

    #[test]
    fn a_file_that_is_not_json_is_kept_aside_before_the_next_write_replaces_it() {
        let _d = TempDataDir::new();
        let st = state();
        std::fs::create_dir_all(held_file().parent().unwrap()).unwrap();
        std::fs::write(held_file(), "{ half a file").unwrap();
        assert!(all().is_empty());
        hold_behind(&st, "junk-main", "junk-one", "footer", "junk-t", "header");
        let copies = bad_copies();
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert_eq!(std::fs::read_to_string(held_file().with_file_name(&copies[0])).unwrap(), "{ half a file");
        assert!(is_held("junk-one"));
    }

    /// A read that fails for a reason other than "not there" used to read as an empty
    /// set, and the next hold then replaced the file with one entry.
    #[test]
    fn a_file_that_is_not_utf8_is_kept_byte_for_byte_before_a_write_replaces_it() {
        let _d = TempDataDir::new();
        let st = state();
        std::fs::create_dir_all(held_file().parent().unwrap()).unwrap();
        let bytes: &[u8] = b"[{\"sub_id\":\"q\",\"name\":\"\xff\xfe\"}]";
        std::fs::write(held_file(), bytes).unwrap();
        assert!(all().is_empty());
        hold_behind(&st, "u8-main", "u8-one", "footer", "u8-t", "header");
        let copies = bad_copies();
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert_eq!(std::fs::read(held_file().with_file_name(&copies[0])).unwrap(), bytes);
    }

    /// A read that fails while the file holds queued subs (a share-locked file here, a
    /// scanner or a backup tool in practice) read as an empty set, and the next hold then
    /// replaced the file with one entry. The lock allows a replace (`FILE_SHARE_DELETE`),
    /// which is the case a write could get through.
    #[cfg(windows)]
    #[test]
    fn a_file_that_cannot_be_read_is_never_overwritten_by_a_write() {
        use std::os::windows::fs::OpenOptionsExt;
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "locked-main", "locked-one", "footer", "locked-t", "header");
        let lock = std::fs::OpenOptions::new().read(true).share_mode(4).open(held_file()).unwrap();
        sub_of(&st, "locked-main", "locked-two", "docs");
        let entry = Held {
            sub_id: "locked-two".into(),
            reason: "waiting for header".into(),
            after: Some("locked-t".into()),
            after_name: "header".into(),
            cleared: Vec::new(),
            launch: spec("do the docs"),
        };
        assert!(hold(&st, entry).is_err(), "the write stops on a file it could not read");
        drop(lock);
        assert!(is_held("locked-one"), "the queued sub is still there");
        assert!(!is_held("locked-two"));
    }

    /// `release` read a locked file as "not held", so a launch that had just started the
    /// child left the sub looking held; the checked release says the file was the problem.
    #[cfg(windows)]
    #[test]
    fn a_release_on_a_file_that_cannot_be_read_is_an_error_not_a_not_held() {
        use std::os::windows::fs::OpenOptionsExt;
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "rel-main", "rel-one", "footer", "rel-t", "header");
        let lock = std::fs::OpenOptions::new().read(true).share_mode(4).open(held_file()).unwrap();
        assert!(release_checked(&st, "rel-one").is_err());
        assert!(release_checked(&st, "rel-nobody").is_err(), "it cannot even say who is held");
        drop(lock);
        assert!(release_checked(&st, "rel-nobody").unwrap().is_none(), "readable again: not held");
        assert!(release_checked(&st, "rel-one").unwrap().is_some(), "the entry survived the lock");
    }

    /// A hold a started sub could not shed (its file was locked at that moment) is still in
    /// the file; the next pass must drop it, not start the job a second time.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_hold_left_behind_by_a_sub_that_already_runs_is_dropped_not_launched_again() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "dup-main", "dup-one", "footer", "dup-t", "header");
        let mut child = crate::daemon::session_test_support::spawn_fake_session(&st.sessions, "dup-one").await;
        st.registry.set_busy("dup-one", true); // the turn it started
        let before = crate::daemon::spawn_rate::test_admits();
        assert_eq!(launch_claimed(&st, "dup-one").await, Ok(()));
        assert_eq!(crate::daemon::spawn_rate::test_admits(), before, "no child started, so no start was counted");
        assert!(!is_held("dup-one"), "the stale entry is gone");
        assert_eq!(st.sessions.len(), 1, "no second child was started");
        let _ = child.kill().await;
    }

    /// An entry written by an older build lacks a field a newer one added.
    #[test]
    fn an_entry_missing_a_field_still_loads() {
        let _d = TempDataDir::new();
        std::fs::create_dir_all(held_file().parent().unwrap()).unwrap();
        std::fs::write(held_file(), r#"[{"sub_id":"old-one","launch":{"first_message":"do it"}}]"#).unwrap();
        let held = all();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].launch.first_message, "do it");
        assert!(bad_copies().is_empty(), "nothing was unreadable");
    }

    #[test]
    fn dropping_a_parents_held_subs_leaves_other_parents_alone() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "dp-a", "dp-a-held", "x", "dp-a-t", "t");
        hold_behind(&st, "dp-b", "dp-b-held", "y", "dp-b-t", "t");
        assert_eq!(drop_held_of_parent(&st, "dp-a"), ["dp-a-held"]);
        assert!(!is_held("dp-a-held") && is_held("dp-b-held"));
    }

    // ── a second daemon on the same data folder ───────────────────────────

    /// 2026-11-10: the `test-pclient` lib test booted a daemon on the live data
    /// folder, its boot pass found no row for the live app's held subs, and it
    /// forgot all of them, so four queued lanes never started.
    #[tokio::test]
    async fn a_second_daemon_instance_on_the_same_data_dir_leaves_the_live_held_set_alone() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "si-main", "si-sub", "footer", "si-target", "header");
        std::env::set_var("CC_DAEMON_INSTANCE", "test-other");
        let other = state();
        let c = calls();
        release_ready(&other, launcher(&c)).await;
        std::env::remove_var("CC_DAEMON_INSTANCE");
        assert!(is_held("si-sub"), "a daemon whose registry does not know the sub must not forget it");
        assert!(c.lock().unwrap().is_empty());
    }

    // ── a hold that was lost ───────────────────────────────────────────────

    /// A sub of `parent` whose brief says it waits for `after` by name.
    fn lost_sub(st: &DaemonState, parent: &str, id: &str, name: &str, after: Option<&str>) {
        sub_of(st, parent, id, name);
        let mut brief: super::super::SubchatBrief = serde_json::from_str(&format!(
            r#"{{"parent":"{parent}","task":"Build the footer","goal":"g","done_when":"d","writes":true,"files":["src/"]}}"#
        ))
        .unwrap();
        brief.after = after.map(str::to_string);
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn no_transcript(_: &str) -> bool {
        false
    }

    #[tokio::test]
    async fn a_never_started_sub_whose_hold_was_lost_is_rebuilt_from_its_brief_and_starts_when_its_target_is_done() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "lh-main", "lh-target", "header");
        st.registry.set_subchat_finished("lh-target", true);
        lost_sub(&st, "lh-main", "lh-lost", "footer", Some("header"));
        lost_sub(&st, "lh-main", "lh-later", "sidebar", Some("footer"));

        let (mut rebuilt, for_slot) = recover_lost_with(&st, &no_transcript, &|_| true);
        rebuilt.sort();
        assert_eq!(rebuilt, ["lh-later", "lh-lost"]);
        assert!(!for_slot, "both wait for a named sub");
        let entry = all().into_iter().find(|h| h.sub_id == "lh-lost").expect("held again");
        assert_eq!((entry.after.as_deref(), entry.after_name.as_str()), (Some("lh-target"), "header"));
        assert!(entry.launch.first_message.starts_with("Job: Build the footer"), "{}", entry.launch.first_message);
        assert_eq!(st.registry.get("lh-lost").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));

        let c = calls();
        release_ready(&st, launcher(&c)).await;
        assert_eq!(*c.lock().unwrap(), ["lh-lost"], "the one whose target finished starts; the next keeps waiting");
        assert!(is_held("lh-later"));
    }

    /// `after: "docs"` meant the `docs` that existed at spawn; a later sub reusing the
    /// name must not become the target when the hold is rebuilt.
    #[test]
    fn a_rebuilt_hold_waits_for_the_sub_that_existed_at_spawn_not_a_later_one_with_the_same_name() {
        let _d = TempDataDir::new();
        let st = state();
        let at = |id: &str, when: &str| st.registry.upsert_interactive(id, &here(), "proj", when);
        at("rn-docs-old", "2026-11-01T00:00:00Z");
        sub_of(&st, "rn-main", "rn-docs-old", "docs");
        st.registry.set_subchat_finished("rn-docs-old", true);
        at("rn-waiter", "2026-11-02T00:00:00Z");
        lost_sub(&st, "rn-main", "rn-waiter", "footer", Some("docs"));
        at("rn-docs-new", "2026-11-03T00:00:00Z");
        sub_of(&st, "rn-main", "rn-docs-new", "docs");
        st.registry.set_busy("rn-docs-new", true);

        let (rebuilt, _) = recover_lost_with(&st, &no_transcript, &|i| i.session_id == "rn-waiter");
        assert_eq!(rebuilt, ["rn-waiter"]);
        let entry = all().into_iter().find(|h| h.sub_id == "rn-waiter").expect("held again");
        assert_eq!(entry.after.as_deref(), Some("rn-docs-old"));
    }

    #[test]
    fn a_lost_hold_is_rebuilt_once_and_a_sub_that_ran_is_never_rebuilt() {
        let _d = TempDataDir::new();
        let st = state();
        lost_sub(&st, "lo-main", "lo-lost", "footer", None);
        lost_sub(&st, "lo-main", "lo-ran", "header", None);
        let has = |id: &str| id == "lo-ran";
        let (rebuilt, for_slot) = recover_lost_with(&st, &has, &|_| true);
        assert_eq!(rebuilt, ["lo-lost"]);
        assert!(for_slot, "no after: it waits for the writer slot");
        release(&st, "lo-lost");
        assert!(recover_lost_with(&st, &has, &|_| true).0.is_empty(), "rebuilt once per run; a second loss goes to the watchdog");
    }

    #[test]
    fn only_a_recent_lost_hold_is_rebuilt_on_its_own() {
        let _d = TempDataDir::new();
        let st = state();
        lost_sub(&st, "ag-main", "ag-old", "footer", None);
        let inst = st.registry.get("ag-old").unwrap();
        let registered = chrono::DateTime::parse_from_rfc3339(&inst.started_at).unwrap().with_timezone(&chrono::Utc);
        assert!(recent_enough(&inst, registered + RECOVER_WITHIN));
        assert!(!recent_enough(&inst, registered + RECOVER_WITHIN + chrono::Duration::minutes(1)));
        let now = registered + chrono::Duration::hours(8);
        assert!(recover_lost_with(&st, &no_transcript, &|i| recent_enough(i, now)).0.is_empty(), "an hours-old job is the main chat's call");
        assert!(never_started(&st, &inst, &no_transcript));
    }

    #[tokio::test]
    async fn joes_nudge_on_a_sub_that_never_started_starts_it_and_a_sub_that_ran_is_left_to_the_real_nudge() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ns-main", "ns-target", "header");
        st.registry.set_subchat_finished("ns-target", true);
        lost_sub(&st, "ns-main", "ns-lost", "footer", Some("header"));
        lost_sub(&st, "ns-main", "ns-ran", "sidebar", None);
        let has = |id: &str| id == "ns-ran";
        let c = calls();
        assert!(start_never_started_with(&st, "ns-lost", &has, launcher(&c)).await);
        assert_eq!(*c.lock().unwrap(), ["ns-lost"]);
        assert!(!start_never_started_with(&st, "ns-ran", &has, launcher(&c)).await, "it has a conversation to resume");
    }

    /// A sub queued for the writer slot has no `after`, so the held pass never
    /// starts it: a nudge that stopped at "handled" started nothing and said nothing.
    /// Behind a live holder it is left queued (the writer queue starts it in order,
    /// a launch from here would let two writers in) and the launcher is not touched.
    #[tokio::test]
    async fn a_nudge_on_a_sub_queued_for_the_writer_slot_starts_nothing_ahead_of_the_queue() {
        let _d = TempDataDir::new();
        let st = state();
        let cwd = tempfile::tempdir().unwrap();
        sub_of(&st, "sq-main", "sq-sub", "footer");
        st.registry.upsert_interactive("sq-sub", cwd.path(), "proj", "2026-11-05T00:00:00Z");
        hold(&st, Held { sub_id: "sq-sub".into(), reason: "writer slot".into(), after: None, after_name: String::new(), cleared: Vec::new(), launch: spec("go") }).unwrap();
        super::super::writers::queue_behind_for_test(cwd.path(), "sq-holder", "sq-sub");
        let c = calls();
        assert!(start_never_started_with(&st, "sq-sub", &no_transcript, launcher(&c)).await, "handled: a nudge must not resume a sub with no conversation");
        assert!(c.lock().unwrap().is_empty(), "the held pass launches nothing for a slot-queued sub");
        assert!(is_held("sq-sub"), "it is still queued, not started");
        assert!(super::super::writers::waiting_behind(&st, "sq-sub").is_some(), "and still waits behind the holder");
        assert!(super::super::plumbing::current("sq-sub").is_none(), "waiting its turn is not a problem");
        super::super::writers::forget_project_for_test(cwd.path());
        release(&st, "sq-sub");
    }

    /// A worktree sub's hold is not rebuilt here (its tree has its own start path),
    /// so a nudge that reports "handled" would spend Joe's answer with nothing started.
    #[tokio::test]
    async fn a_nudge_on_a_never_started_sub_that_cannot_be_rebuilt_wakes_the_main_chat_instead_of_doing_nothing() {
        let _d = TempDataDir::new();
        let st = state();
        lost_sub(&st, "nw-main", "nw-tree", "footer", None);
        let mut brief: super::super::SubchatBrief = crate::sessions::chat_config::get("nw-tree").unwrap().subchat.unwrap();
        brief.worktree_at = Some(serde_json::from_value(serde_json::json!({"cwd": "x", "path": "x", "branch": "b"})).unwrap());
        crate::sessions::chat_config::set_subchat("nw-tree", Some(brief));
        let c = calls();
        assert!(start_never_started_with(&st, "nw-tree", &no_transcript, launcher(&c)).await, "it is a never-started sub, so the nudge is handled");
        assert!(c.lock().unwrap().is_empty(), "nothing could be launched");
        assert!(!is_held("nw-tree"));
        assert!(cards_of_kind(&st).await.is_empty(), "no card for Joe");
        assert_eq!(wakes(&st, "nw-main").len(), 1, "the main chat is told, so the answer is not spent on nothing");
        assert!(super::super::plumbing::current("nw-tree").unwrap().detail.contains("could not be rebuilt"));
        super::super::plumbing::clear("nw-tree");
    }

    /// `recover_lost` tells every window its sub is queued again; a rebuild for one sub
    /// (a send, Joe's nudge) must too, or the row keeps drawing as lost until the next
    /// unrelated change.
    #[test]
    fn rebuilding_one_lost_hold_tells_the_windows_the_sub_is_queued_again() {
        let _d = TempDataDir::new();
        let st = state();
        // Waiting for a named sub, so the writer queue (which publishes on its own) is not involved.
        sub_of(&st, "rp-main", "rp-target", "header");
        lost_sub(&st, "rp-main", "rp-lost", "footer", Some("header"));
        let mut rx = st.notifier.subscribe();
        assert!(rebuild_lost_hold(&st, "rp-lost", &no_transcript));
        let mut told = false;
        while let Ok(frame) = rx.try_recv() {
            told |= frame["method"] == "instances_changed";
        }
        assert!(told, "no instances_changed after the rebuild");
    }

    /// An unresolvable transcript path (moved cwd, mirrored row) reads as "never ran",
    /// and a send would relaunch the brief of a sub that did run. A recorded turn is
    /// the second witness.
    #[test]
    fn a_sub_that_ran_is_not_a_lost_hold_just_because_its_transcript_does_not_resolve() {
        let _d = TempDataDir::new();
        let st = state();
        lost_sub(&st, "rr-main", "rr-never", "footer", None);
        lost_sub(&st, "rr-main", "rr-ran", "header", None);
        crate::sessions::chat_state::set_busy("rr-ran", true);
        crate::sessions::chat_state::set_busy("rr-ran", false);
        let held = all();
        assert!(is_lost_hold(&st, &st.registry.get("rr-never").unwrap(), &held, &no_transcript));
        assert!(!is_lost_hold(&st, &st.registry.get("rr-ran").unwrap(), &held, &no_transcript), "it had a turn");
        assert!(recover_lost_with(&st, &no_transcript, &|_| true).0 == ["rr-never"], "only the one that never ran is rebuilt");
    }

    /// 2026-11-14: a main chat whose row had ended (a SessionEnd hook closed it) was
    /// resumed by a schedule; the sub it spawned next was dropped as orphaned and
    /// its worktree went with it. A chat the daemon holds a child for is still there.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_main_chat_with_a_live_child_is_not_gone_whatever_its_row_says() {
        let _data = TempDataDir::new();
        let st = state();
        sub_of(&st, "live-parent", "live-sub", "worker");
        st.registry.mark_ended("live-parent", crate::types::EndReason::HookSessionEnd, "2026-11-14T17:16:02Z");
        assert!(orphaned(&st, "live-sub"), "an ended row with no child is gone");

        let mut child = crate::daemon::session_test_support::spawn_fake_session(&st.sessions, "live-parent").await;
        assert!(!orphaned(&st, "live-sub"), "its child is running again");
        let _ = child.kill().await;
    }

    /// A held sub visiting from another machine has its main chat there, so the
    /// registry never has the parent and the sweep must not drop it as orphaned.
    #[tokio::test]
    async fn a_visiting_sub_is_never_orphaned_by_a_parent_this_machine_does_not_have() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("v-sub", std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
        st.registry.set_subchat_of("v-sub", Some("home-main".into()));
        assert!(orphaned(&st, "v-sub"), "a local sub whose parent is missing is orphaned");
        crate::daemon::subchats::store_visiting_brief("v-sub", "home-main", "pc");
        assert!(!orphaned(&st, "v-sub"), "a visiting sub's parent is on its home machine");
    }

    /// A start that failed because the sub ended is not a problem for its main chat
    /// to fix, whichever path launched it (the after pass, retry, the writer queue).
    #[tokio::test]
    async fn a_launch_that_failed_because_the_sub_ended_tells_nobody() {
        let _data = TempDataDir::new();
        let st = state();
        hold_behind(&st, "endl-main", "endl-sub", "worker", "endl-target", "target");
        let entry = all().into_iter().find(|h| h.sub_id == "endl-sub").unwrap();

        raise_decision(&st, &entry, Why::LaunchFailed(ENDED_BEFORE_START.to_string())).await;
        assert!(super::super::plumbing::current("endl-sub").is_none(), "an ended sub has nothing to retry");

        raise_decision(&st, &entry, Why::LaunchFailed("cwd does not exist".to_string())).await;
        assert!(super::super::plumbing::current("endl-sub").is_some(), "a real failure still reaches the main chat");
    }

    #[tokio::test]
    async fn retrying_a_sub_that_ended_since_its_failed_start_clears_the_problem() {
        let _data = TempDataDir::new();
        let st = state();
        hold_behind(&st, "endr-main", "endr-sub", "worker", "endr-target", "target");
        super::super::plumbing::report(&st, "endr-sub", super::super::plumbing::Problem::CouldNotStart, "boom".into(), Vec::new());

        let err = retry_with(&st, "endr-sub", |_, _| std::future::ready(Err(ENDED_BEFORE_START.to_string()))).await.unwrap_err();

        assert!(err.contains("nothing to retry"), "{err}");
        assert!(super::super::plumbing::current("endr-sub").is_none(), "no start failure is left for an ended sub");
    }
