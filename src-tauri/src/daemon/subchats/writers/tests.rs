    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{git::test_repo, store_sub_brief, SubchatArgs, SubchatBrief, TempDataDir};
    use crate::types::Settings;
    use std::path::PathBuf;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A parent plus a sub in `cwd`. `writes` is stored on its brief.
    fn sub(st: &DaemonState, tag: &str, cwd: &Path, writes: bool) -> String {
        let (parent, id) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&id, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, tag.to_string());
        store_sub_brief(&id, &parent);
        set_writes(&id, writes);
        id
    }

    fn set_writes(id: &str, writes: bool) {
        let mut brief: SubchatBrief = crate::sessions::chat_config::get(id).unwrap().subchat.unwrap();
        brief.writes = writes;
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn set_gate(id: &str) {
        let mut brief: SubchatBrief = crate::sessions::chat_config::get(id).unwrap().subchat.unwrap();
        brief.gate = true;
        brief.writes = true;
        brief.files = Vec::new();
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn brief(writes: bool) -> SubchatBrief {
        serde_json::from_str(&format!(r#"{{"parent":"m","task":"t","goal":"g","done_when":"d","writes":{writes}}}"#)).unwrap()
    }

    /// A project folder of its own, so no test shares a slot with another.
    fn project() -> (tempfile::TempDir, PathBuf) {
        test_repo::init()
    }

    fn spec(cwd: &Path, first: &str) -> LaunchSpec {
        LaunchSpec {
            cwd: cwd.to_path_buf(),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: first.into(),
        }
    }

    /// Takes the slot for a writer the way a spawn does, then registers its row;
    /// a queued one gets its held recipe, as `register_queued` stores it.
    fn spawn_writer(st: &DaemonState, tag: &str, cwd: &Path, first: &str) -> (String, bool) {
        let d = decide_spawn(st, &brief(true), cwd);
        let (parent, id) = (format!("{tag}-main"), d.sid.clone());
        st.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&id, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, tag.to_string());
        store_sub_brief(&id, &parent);
        set_writes(&id, true);
        if d.queued {
            held::hold(
                st,
                Held { sub_id: id.clone(), reason: QUEUED_TEXT.into(), after: None, after_name: String::new(), cleared: Vec::new(), launch: spec(cwd, first) },
            )
            .unwrap();
        }
        (id, d.queued)
    }

    /// The slot reads the row, not the process: a finished holder whose `claude`
    /// is still running (dash-answers on 2026-11-10 kept pid 27316 after its
    /// finish) is not alive to the slot, so it never holds it for good.
    #[test]
    fn a_finished_holder_lets_the_next_writer_in_whatever_its_process_does() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "linger-a", &root, "A");
        let (next, queued) = spawn_writer(&st, "linger-b", &root, "B");
        assert!(queued);
        assert!(!nothing_in_the_way(&st, &next), "a live holder is in the way");
        st.registry.set_subchat_finished(&first, true);
        assert!(nothing_in_the_way(&st, &next), "a finished holder is not");
        let starts = {
            let mut t = table();
            advance_locked(&st, t.get_mut(&project_key(&root)).unwrap())
        };
        assert_eq!(starts, vec![Start::Launch { sub_id: next.clone() }]);
        assert!(nothing_in_the_way(&st, "linger-nobody"), "a sub no queue names can never be reached");
    }

    #[test]
    fn a_read_only_sub_never_takes_the_slot_and_a_writer_takes_a_free_one() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let ro = decide_spawn(&st, &brief(false), &root);
        assert!(!ro.queued);
        assert_eq!(holder_of(&root), None, "a read-only sub holds nothing");
        let w = decide_spawn(&st, &brief(true), &root);
        assert!(!w.queued);
        assert_eq!(holder_of(&root).as_deref(), Some(w.sid.as_str()));
    }

    #[test]
    fn a_gate_on_an_idle_project_takes_the_slot_at_once_and_is_not_read_as_read_only() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let mut gate = brief(true);
        gate.gate = true;
        let d = decide_spawn(&st, &gate, &root);
        assert!(!d.queued, "nobody is writing");
        assert_eq!(gate_holder_of(&root).as_deref(), Some(d.sid.as_str()), "it holds the gate slot while it pushes");
        release(&st, &d.sid);
        let g = sub(&st, "gate-g", &root, true);
        set_gate(&g);
        assert_eq!(check_write(&st, &g), WriteCheck::Allow, "empty files is not read as writes nothing: the free slot is its");
        assert_eq!(gate_holder_of(&root).as_deref(), Some(g.as_str()));
    }

    /// The notes once said "Tell Joe it is waiting", and the main chat then sent a
    /// card next to the sub's own card saying the same thing (2026-11-11).
    #[test]
    fn queue_notes_do_not_tell_the_main_chat_to_message_joe() {
        let spawn = queued_text("alerts-build", false);
        let send = send_note("Header", "Footer");
        for note in [&spawn, &send] {
            assert!(!note.contains("Tell Joe"), "{note}");
            assert!(note.contains("send no message or card of your own"), "{note}");
            assert!(note.contains("window shows no card for it"), "{note}");
        }
        assert!(!spawn.contains("use worktrees"), "every writer gets a worktree, so there is nothing to offer: {spawn}");
    }

    #[test]
    fn a_queued_writer_and_a_queued_gate_are_each_told_what_they_wait_for() {
        let writer = queued_text("alerts-build", false);
        assert!(writer.contains("\"alerts-build\" has the writer slot") && writer.contains("no worktree of its own"), "{writer}");
        assert!(!writer.contains("gate"), "a plain writer gets no gate advice: {writer}");
        let gate = queued_text("alerts-build", true);
        assert!(gate.contains("only one gate sub pushes") && gate.contains("\"alerts-build\" is ahead of it"), "{gate}");
        assert!(!gate.contains("hold back its commit"), "a gate never waits for a writer, so nothing can deadlock on it: {gate}");
    }

    /// Every writer works in its own tree, so a gate pushing from the main checkout
    /// has no writer to wait for there, and a writer never waits for a gate.
    #[test]
    fn a_gate_and_a_main_checkout_writer_never_queue_behind_each_other() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_writer, queued) = spawn_writer(&st, "writer", &root, "do A");
        assert!(!queued);
        let mut gate_brief = brief(true);
        gate_brief.gate = true;
        let d = decide_spawn(&st, &gate_brief, &root);
        assert!(!d.queued, "the gate has a slot of its own");
        let (_late, late_queued) = spawn_writer(&st, "late", &root, "do B");
        assert!(late_queued, "two writers on the main checkout still take turns");
        assert_eq!(queue_of(&root).len(), 1, "only the writer queues, never behind the gate");
    }

    #[test]
    fn a_second_writer_is_queued_and_the_tool_result_says_so() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, q1) = spawn_writer(&st, "first", &root, "do A");
        assert!(!q1);
        let (second, q2) = spawn_writer(&st, "second", &root, "do B");
        assert!(q2, "the slot is taken");
        assert_eq!(queue_of(&root), vec![second.clone()]);
        let note = spawn_note(&st, &second).expect("a queued sub reports it");
        assert_eq!(note["queued"], true);
        let text = note["note"].as_str().unwrap();
        assert!(text.contains("Queued, not started") && text.contains("first") && text.contains("not woken"), "{text}");
        assert!(text.contains("no worktree of its own"), "says why it shares the main checkout: {text}");
        assert!(spawn_note(&st, &first).is_none(), "a sub that started has nothing to say");
        assert!(!text.contains('\u{2014}'));
    }

    #[test]
    fn registering_a_queued_writer_holds_it_through_held_without_an_after_and_counts_it_toward_the_cap() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_first, _) = spawn_writer(&st, "reg-a", &root, "A");
        st.registry.upsert_interactive("reg-main", &root, "proj", "2026-11-05T00:00:00Z");
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["footer.ts".into()]),
            ..Default::default()
        };
        let mut plan = super::super::spawn::plan(&st, "reg-main", &cfg, &root.to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        let decision = decide_spawn(&st, &plan.brief, &root);
        assert!(decision.queued);
        let first_message = plan.first_message.clone();
        let sid = register_queued_row(&st, "reg-main", Some("footer"), &cfg, spec(&root, &first_message), &mut plan, &decision.sid).unwrap();
        assert_eq!(sid, decision.sid, "the row has the id the slot queued");
        let inst = st.registry.get(&sid).unwrap();
        assert_eq!(inst.progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        assert_eq!(inst.progress.queue_place, Some(1), "registering stamps the place the slot gave it");
        assert_eq!(inst.progress.queue_behind.as_deref(), Some("reg-a"), "and the sub it waits behind");
        assert_eq!(super::super::tool::status_word(&inst), "queued");
        assert!(super::super::spawn::running_subs(&st.registry, "reg-main").iter().any(|i| i.session_id == sid), "it is an unfinished sub (closing waits on it) but holds no cap slot");
        assert!(!super::super::spawn::started_subs(&st, "reg-main").iter().any(|i| i.session_id == sid));
        let entry = held::all().into_iter().find(|h| h.sub_id == sid).expect("held keeps the recipe");
        assert_eq!(entry.after, None, "release_ready must leave a writer-queue hold alone");
        assert!(entry.launch.first_message.contains("Footer"));
        assert!(held::is_held(&sid), "so the dead and ceiling sweeps leave it alone");
    }

    #[test]
    fn a_registration_that_fails_gives_the_slot_entry_back() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_first, _) = spawn_writer(&st, "badreg-a", &root, "A");
        st.registry.upsert_interactive("badreg-main", &root, "proj", "2026-11-05T00:00:00Z");
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["a.ts".into()]),
            ..Default::default()
        };
        let mut plan = super::super::spawn::plan(&st, "badreg-main", &cfg, &root.to_string_lossy(), None, None, None, Some("n"), &args, &[])
            .unwrap()
            .unwrap();
        let decision = decide_spawn(&st, &plan.brief, &root);
        assert_eq!(queue_of(&root), vec![decision.sid.clone()]);
        let mut gone = spec(&root, "x");
        gone.cwd = std::env::temp_dir().join(format!("cc-writers-missing-{}", uuid::Uuid::new_v4()));
        assert!(register_queued_row(&st, "badreg-main", Some("n"), &cfg, gone, &mut plan, &decision.sid).is_err());
        assert!(queue_of(&root).is_empty(), "a sub that could not be registered is not left in line");
    }

    #[test]
    fn a_queued_sub_holds_no_cap_slot_and_shows_as_queued() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        spawn_writer(&st, "cap1", &root, "A");
        let (second, _) = spawn_writer(&st, "cap1b", &root, "B");
        let row = st.registry.get(&second).unwrap();
        assert_eq!(row.progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        assert!(
            !super::super::spawn::started_subs(&st, "cap1b-main").iter().any(|i| i.session_id == second),
            "an unstarted sub has no process, so it holds no cap slot"
        );
        assert_eq!(tool::status_word(&row), "queued");
    }

    #[tokio::test]
    async fn the_queued_sub_starts_when_the_first_finishes_without_waking_the_main_agent() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "chain", &root, "do A");
        let (second, queued) = spawn_writer(&st, "chain2", &root, "do B");
        assert!(queued);
        assert_eq!(queue_of(&root), vec![second.clone()]);
        release(&st, &first);
        assert_eq!(holder_of(&root).as_deref(), Some(second.as_str()), "the head took the slot");
        assert!(queue_of(&root).is_empty());
        // The start is a launch of the held sub and nothing else: no message to the
        // main chat and no wake for the main agent.
        assert!(super::super::back::peek("chain2-main").is_none());
        assert!(st.repo_channel_wakes.lock().unwrap().values().all(|q| q.is_empty()));
    }

    #[tokio::test]
    async fn a_queued_writers_place_rides_its_row_and_moves_up_as_those_ahead_leave() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "plc-a", &root, "A");
        let (b, _) = spawn_writer(&st, "plc-b", &root, "B");
        let (c, _) = spawn_writer(&st, "plc-c", &root, "C");
        assert!(stamp_places_of(&st, &b));
        let place = |id: &str| {
            let p = st.registry.get(id).unwrap().progress;
            (p.queue_place, p.queue_behind)
        };
        assert_eq!(place(&b), (Some(1), Some("plc-a".to_string())));
        assert_eq!(place(&c), (Some(2), Some("plc-a".to_string())));
        assert!(!stamp_places_of(&st, &b), "nothing moved, nothing to publish");

        release(&st, &b);
        assert_eq!(place(&b), (None, None), "a sub that left the line has no place");
        assert_eq!(place(&c), (Some(1), Some("plc-a".to_string())), "the one behind it moved up");

        release(&st, &first);
        assert_eq!(holder_of(&root).as_deref(), Some(c.as_str()));
        assert_eq!(place(&c), (None, None), "once it holds the slot it is starting, not waiting in line");
    }

    #[test]
    fn advance_hands_out_the_head_as_a_launch_in_queue_order() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_first, _) = spawn_writer(&st, "ord", &root, "A");
        let (b, _) = spawn_writer(&st, "ord-b", &root, "message for B");
        let (c, _) = spawn_writer(&st, "ord-c", &root, "message for C");
        assert_eq!(queue_of(&root), vec![b.clone(), c.clone()]);
        let starts = {
            let mut table = table();
            let slot = table.get_mut(&project_key(&root)).unwrap();
            slot.holder = None;
            advance_locked(&st, slot)
        };
        assert_eq!(starts, vec![Start::Launch { sub_id: b.clone() }]);
        assert_eq!(held::all().into_iter().find(|h| h.sub_id == b).unwrap().launch.first_message, "message for B");
        assert_eq!(queue_of(&root), vec![c], "only one sub holds the slot at a time");
    }

    #[tokio::test]
    async fn a_writer_waiting_on_joe_with_its_work_committed_lets_the_queued_one_start() {
        let _data = TempDataDir::new();
        let (dir, root) = project();
        let st = state();
        let (header, _) = spawn_writer(&st, "hdr", &root, "A");
        let (footer, queued) = spawn_writer(&st, "ftr", &root, "B");
        assert!(queued);
        let mine = root.join("header.txt");
        std::fs::write(&mine, "x").unwrap();
        test_repo::git(&root, &["add", "header.txt"]);
        test_repo::git(&root, &["commit", "-q", "-m", "header"]);
        let tp = test_repo::transcript(dir.path(), &[("Write", &mine)]);
        on_waiting_on_joe_with(&st, &header, Some(tp)).await;
        assert_eq!(holder_of(&root).as_deref(), Some(footer.as_str()), "the footer took the released slot");
    }

    #[tokio::test]
    async fn a_writer_waiting_on_joe_with_uncommitted_work_keeps_the_slot() {
        let _data = TempDataDir::new();
        let (dir, root) = project();
        let st = state();
        let (header, _) = spawn_writer(&st, "hdr-dirty", &root, "A");
        let (footer, _) = spawn_writer(&st, "ftr-dirty", &root, "B");
        let mine = root.join("half-written.txt");
        std::fs::write(&mine, "x").unwrap();
        let tp = test_repo::transcript(dir.path(), &[("Write", &mine)]);
        on_waiting_on_joe_with(&st, &header, Some(tp)).await;
        assert_eq!(holder_of(&root).as_deref(), Some(header.as_str()), "the queued one stays queued until he answers");
        assert_eq!(queue_of(&root), vec![footer]);
    }

    #[tokio::test]
    async fn the_writer_takes_the_slot_back_when_joe_answers_if_it_is_free_and_otherwise_is_told_at_its_next_write() {
        let _data = TempDataDir::new();
        let (dir, root) = project();
        let st = state();
        let (header, _) = spawn_writer(&st, "ans-h", &root, "A");
        // Released while waiting, nobody queued: nothing holds the slot.
        let tp = test_repo::transcript(dir.path(), &[]);
        on_waiting_on_joe_with(&st, &header, Some(tp)).await;
        assert_eq!(holder_of(&root), None);
        // He answers; its next write takes the free slot back.
        assert_eq!(check_write(&st, &header), WriteCheck::Allow);
        assert_eq!(holder_of(&root).as_deref(), Some(header.as_str()));
        // Released again, and this time another writer takes the slot meanwhile.
        on_waiting_on_joe_with(&st, &header, Some(test_repo::transcript(dir.path(), &[]))).await;
        let (other, queued) = spawn_writer(&st, "ans-o", &root, "B");
        assert!(!queued, "the slot was free");
        // He answers: the answering sub is NOT held back, it is told at its write.
        match check_write(&st, &header) {
            WriteCheck::Wait { holder } => assert_eq!(holder, "ans-o"),
            other => panic!("expected to wait, got {other:?}"),
        }
        assert_eq!(queue_of(&root), vec![header.clone()], "it waits its turn as a woken sub");
        assert_eq!(st.registry.get(&header).unwrap().progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        // The other sub finishes: the answering one gets the slot and a wake.
        let starts = {
            let mut table = table();
            let slot = table.get_mut(&project_key(&root)).unwrap();
            assert_eq!(slot.holder.as_deref(), Some(other.as_str()));
            slot.holder = None;
            advance_locked(&st, slot)
        };
        assert_eq!(starts, vec![Start::Wake { sub_id: header.clone() }]);
        assert!(st.registry.get(&header).unwrap().progress.waiting_for.is_none(), "no longer waiting");
        assert_eq!(check_write(&st, &header), WriteCheck::Allow);
    }

    #[tokio::test]
    async fn the_slot_is_released_on_end_crash_and_move_to_sidebar() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        for (tag, how) in [("rel-end", "end"), ("rel-crash", "crash"), ("rel-move", "move")] {
            let (holder, _) = spawn_writer(&st, tag, &root, "A");
            let (next, queued) = spawn_writer(&st, &format!("{tag}-n"), &root, "B");
            assert!(queued, "{how}");
            match how {
                "end" => {
                    // `end_sub` is what Joe's "End it" and the stalled card call.
                    super::super::end_sub(&st, &holder);
                }
                "crash" => {
                    // A mid-turn death nobody asked for, through the pump's own hook.
                    assert!(super::super::turn_end::note_death(&st, &holder, false, true, None).is_some());
                }
                _ => {
                    super::super::move_to_sidebar(&st, &holder).await.unwrap();
                }
            }
            assert_eq!(holder_of(&root).as_deref(), Some(next.as_str()), "{how}: the next sub has the slot");
            release(&st, &next);
            assert_eq!(holder_of(&root), None);
        }
    }

    #[test]
    fn a_finished_writer_that_is_continued_takes_the_slot_again_the_same_way() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (w, _) = spawn_writer(&st, "cont", &root, "A");
        st.registry.set_subchat_finished(&w, true);
        release(&st, &w);
        assert_eq!(holder_of(&root), None, "finishing let go");
        st.registry.set_subchat_finished(&w, false);
        assert_eq!(request_slot(&st, &w), SlotOutcome::Granted, "continuing asks for it");
        assert_eq!(holder_of(&root).as_deref(), Some(w.as_str()));
        // And with the slot taken, the continued one queues.
        release(&st, &w);
        let (other, _) = spawn_writer(&st, "cont-o", &root, "B");
        let _ = other;
        match request_slot(&st, &w) {
            SlotOutcome::Queued { behind, position } => assert_eq!((behind.as_str(), position), ("cont-o", 1)),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn a_follow_up_with_writes_true_queues_the_sub_when_the_slot_is_taken() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "fu-h", &root, "A");
        let reader = sub(&st, "fu-r", &root, false);
        set_writes(&reader, true);
        match request_slot(&st, &reader) {
            SlotOutcome::Queued { behind, position } => assert_eq!((behind.as_str(), position), ("fu-h", 1)),
            o => panic!("{o:?}"),
        }
        assert_eq!(st.registry.get(&reader).unwrap().progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        assert!(matches!(request_slot(&st, &reader), SlotOutcome::Queued { position: 1, .. }), "asking twice does not queue twice");
        assert_eq!(queue_of(&root).len(), 1);
    }

    #[test]
    fn a_read_only_sub_has_its_edits_refused_and_a_writer_does_not() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let reader = sub(&st, "guard-r", &root, false);
        assert_eq!(check_write(&st, &reader), WriteCheck::ReadOnly);
        let writer = sub(&st, "guard-w", &root, true);
        assert_eq!(check_write(&st, &writer), WriteCheck::Allow);
        assert!(READ_ONLY_REFUSAL.contains("guard, not a sandbox") && READ_ONLY_REFUSAL.contains("writes: true"));
        assert!(!READ_ONLY_REFUSAL.contains('\u{2014}') && !wait_refusal("x").contains('\u{2014}'));
    }

    #[test]
    fn a_sub_that_writes_without_holding_the_slot_is_refused() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let holder = sub(&st, "nh-a", &root, true);
        assert_eq!(check_write(&st, &holder), WriteCheck::Allow);
        let other = sub(&st, "nh-b", &root, true);
        match check_write(&st, &other) {
            WriteCheck::Wait { holder } => assert_eq!(holder, "nh-a"),
            o => panic!("{o:?}"),
        }
        assert!(wait_refusal("nh-a").contains("nh-a") && wait_refusal("nh-a").contains("queued"));
    }

    #[test]
    fn a_chat_that_is_not_a_sub_is_never_guarded() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        st.registry.upsert_interactive("plain-chat", &root, "proj", "2026-11-05T00:00:00Z");
        assert_eq!(check_write(&st, "plain-chat"), WriteCheck::Allow);
        assert_eq!(check_write(&st, "unknown-chat"), WriteCheck::Allow);
        assert_eq!(holder_of(&root), None, "a plain chat takes no slot");
    }

    #[test]
    fn a_stale_holder_does_not_hold_the_slot_forever() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (stale, _) = spawn_writer(&st, "stale", &root, "A");
        // Ended by a path that never called `release`.
        st.registry.mark_ended(&stale, crate::types::EndReason::Manual, "2026-11-05T01:00:00Z");
        let (fresh, queued_fresh) = spawn_writer(&st, "stale-f", &root, "B");
        assert!(!queued_fresh, "a dead holder is dropped, so the slot was free");
        // The sweep also starts a queued sub behind a holder that ended unnoticed.
        let (next, queued) = spawn_writer(&st, "stale-n", &root, "C");
        assert!(queued);
        st.registry.mark_ended(&fresh, crate::types::EndReason::Manual, "2026-11-05T01:00:00Z");
        sweep(&st);
        assert_eq!(holder_of(&root).as_deref(), Some(next.as_str()));
    }

    #[test]
    fn the_queue_survives_a_restart_through_held_and_the_head_starts_when_the_slot_is_free() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "boot-h", &root, "A");
        let (b, _) = spawn_writer(&st, "boot-b", &root, "message for B");
        let (c, _) = spawn_writer(&st, "boot-c", &root, "message for C");
        // The daemon restarts: the in-memory table is gone, the rows were restored
        // from the snapshot, and the held file still has the recipes.
        forget_project_for_test(&root);
        let starts = restore_inner(&st);
        assert_eq!(starts, vec![Start::Launch { sub_id: b.clone() }], "nothing holds the slot after a restart, so the head starts");
        assert_eq!(queue_of(&root), vec![c.clone()]);
        assert_eq!(holder_of(&root).as_deref(), Some(b.as_str()));
        assert!(held::all().iter().any(|h| h.sub_id == b && h.launch.first_message == "message for B"), "its recipe is still there to launch from");
    }

    #[test]
    fn a_restored_entry_whose_row_is_ended_never_starts() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "drop-h", &root, "A");
        let (ended, _) = spawn_writer(&st, "drop-e", &root, "C");
        forget_project_for_test(&root);
        st.registry.mark_ended(&ended, crate::types::EndReason::Manual, "2026-11-05T01:00:00Z");
        let starts = restore_inner(&st);
        assert!(starts.iter().all(|s| !matches!(s, Start::Launch { sub_id } if sub_id == &ended)), "an ended sub never starts");
        assert!(queue_of(&root).is_empty());
    }

    /// A rebuilt hold (`lost_hold`) has no `after`, so it used to be read as a
    /// writer's and queued for the slot even when the brief said `writes: false`.
    fn read_only_hold(st: &DaemonState, tag: &str, cwd: &Path) -> String {
        let id = sub(st, tag, cwd, false);
        held::hold(
            st,
            Held { sub_id: id.clone(), reason: QUEUED_TEXT.into(), after: None, after_name: String::new(), cleared: Vec::new(), launch: spec(cwd, "A") },
        )
        .unwrap();
        id
    }

    #[test]
    fn a_read_only_hold_with_no_after_starts_at_once_and_never_joins_the_writer_queue() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let id = read_only_hold(&st, "ro-hold", &root);
        let starts = restore_inner(&st);
        assert_eq!(starts, vec![Start::Launch { sub_id: id.clone() }], "nobody is in its way");
        assert!(queue_of(&root).is_empty(), "no place in the writer queue");
        assert_eq!(holder_of(&root), None, "it takes no slot");
        assert!(held::is_held(&id), "the recipe stays until the launch releases it");
    }

    #[test]
    fn a_read_only_hold_does_not_wait_behind_a_writer_and_a_parked_one_is_not_retried() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (holder, _) = spawn_writer(&st, "ro-holder", &root, "W");
        let id = read_only_hold(&st, "ro-behind", &root);
        let starts = restore_inner(&st);
        assert!(starts.contains(&Start::Launch { sub_id: id.clone() }), "a writer holding the slot is no reason to hold a read-only sub: {starts:?}");
        assert_eq!(holder_of(&root).as_deref(), Some(holder.as_str()));
        assert!(queue_of(&root).is_empty());
        held::set_parked(&id, true);
        assert!(!restore_inner(&st).contains(&Start::Launch { sub_id: id.clone() }), "a launch that failed is left to subchat retry");
        held::set_parked(&id, false);
    }

    #[tokio::test]
    async fn a_queued_sub_is_not_called_dead_by_the_sweep() {
        use super::super::stuck::{sweep_dead, Env};
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "dead-h", &root, "A");
        let (queued, _) = spawn_writer(&st, "dead-q", &root, "B");
        let none = |_: &crate::types::Instance| None;
        let never_live = |_: &str| false;
        let env = |now| Env { now, resumed_at: None, transcript_mtime: &none, is_live: &never_live };
        let t0 = chrono::Utc::now();
        // Twice, past the grace period: a childless sub that was not held would be carded.
        sweep_dead(&st, &env(t0)).await;
        let carded = sweep_dead(&st, &env(t0 + chrono::Duration::minutes(5))).await;
        assert!(!carded.contains(&queued), "a held sub has no child on purpose: {carded:?}");
        assert!(st.list_prompts().await.iter().all(|p| p["payload"]["sub_id"] != queued.as_str()));
    }

    #[tokio::test]
    async fn the_after_pass_leaves_a_writer_queue_hold_alone() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "after-h", &root, "A");
        let (queued, _) = spawn_writer(&st, "after-q", &root, "B");
        let started = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = started.clone();
        held::release_ready(&st, move |_st, id| {
            seen.lock().unwrap().push(id);
            std::future::ready(Ok(()))
        })
        .await;
        assert!(started.lock().unwrap().is_empty(), "only the slot starts it");
        assert!(held::is_held(&queued));
    }

    #[tokio::test]
    async fn a_follow_up_to_a_queued_sub_is_refused_because_it_has_not_started() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "fol-h", &root, "A");
        let (queued, _) = spawn_writer(&st, "fol-q", &root, "B");
        let err = super::super::continue_sub(&st, &queued, "also fix the footer").await.unwrap_err();
        assert!(matches!(err, ContinueError::Held(_)), "{err:?}");
        assert!(!st.registry.get(&queued).unwrap().busy, "no turn was opened");
    }

    #[tokio::test]
    async fn a_launch_that_fails_releases_the_slot_to_the_next_sub_keeps_the_recipe_and_tells_the_main_chat() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "fail-1", &root, "A");
        let (second, _) = spawn_writer(&st, "fail-2", &root, "B");
        let (third, _) = spawn_writer(&st, "fail-3", &root, "C");
        // The first finishes: the second is handed the slot. Its launch fails (a
        // unit test has no account or `claude`), which must not strand the third.
        {
            let mut table = table();
            let slot = table.get_mut(&project_key(&root)).unwrap();
            assert_eq!(slot.holder.as_deref(), Some(first.as_str()));
            slot.holder = Some(second.clone());
            slot.queue.retain(|e| e.sub_id != second);
        }
        run_start(&st, Start::Launch { sub_id: second.clone() }).await;
        // The failed start released the slot, so the third was handed it and its own
        // launch was tried (and failed the same way): the main chat is told of both,
        // and Joe gets no card about either.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        for (id, what) in [(&second, "the one that failed"), (&third, "the one behind it")] {
            let rec = crate::daemon::subchats::plumbing::current(id);
            assert!(rec.is_some_and(|r| r.problem == crate::daemon::subchats::plumbing::Problem::CouldNotStart), "the main chat is told {what} never started");
        }
        assert!(st.list_prompts().await.is_empty(), "no card for Joe");
        assert!(held::is_held(&second), "the recipe stays, so subchat retry can start it");
        assert_ne!(holder_of(&root).as_deref(), Some(second.as_str()));
    }

    fn tree_info() -> crate::daemon::subchats::WorktreeInfo {
        crate::daemon::subchats::WorktreeInfo {
            cwd: "C:/x/.claude/worktrees/sub-1".into(),
            path: "C:/x/.claude/worktrees/sub-1".into(),
            branch: "sub/1".into(),
            target: "main".into(),
            repo: "C:/x".into(),
            base: None,
        }
    }

    #[test]
    fn a_worktree_sub_has_no_slot_and_a_read_only_sub_has_none_either() {
        let (_d, root) = project();
        let mut writer = brief(true);
        assert!(slot_key(&writer, &root).is_some(), "a writer on the main checkout shares the slot: a folder that could not have a worktree falls back to it");
        assert!(slot_key(&brief(false), &root).is_none(), "a read-only sub holds nothing");
        writer.worktree_at = Some(tree_info());
        assert!(slot_key(&writer, &root).is_none(), "its own tree is what keeps it apart");
    }

    #[test]
    fn a_worktree_writer_never_queues_behind_a_writer_on_the_main_checkout() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, queued) = spawn_writer(&st, "wt-holder", &root, "A");
        assert!(!queued);
        let mut b = brief(true);
        b.worktree_at = Some(tree_info());
        let d = decide_spawn(&st, &b, &root);
        assert!(!d.queued, "two writers run at once when one has a worktree");
        assert_eq!(queue_of(&root), Vec::<String>::new());
    }

    #[test]
    fn a_gate_behind_another_gate_is_told_to_wait_not_read_as_read_only() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let first = sub(&st, "gate-w", &root, true);
        set_gate(&first);
        assert_eq!(check_write(&st, &first), WriteCheck::Allow);
        let g = sub(&st, "gate-g2", &root, true);
        set_gate(&g);
        assert!(matches!(check_write(&st, &g), WriteCheck::Wait { .. }), "empty files must not read as read-only, and two gates must not push at once");
    }

    /// Writers hold no slot, so a gate takes a project-wide slot that only other
    /// gates contend for.
    #[test]
    fn a_gate_contends_only_with_other_gates() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let mut gate = brief(true);
        gate.gate = true;
        let first = decide_spawn(&st, &gate, &root);
        assert!(!first.queued);
        assert_eq!(gate_holder_of(&root).as_deref(), Some(first.sid.as_str()));
        assert_eq!(holder_of(&root), None, "the project's own slot is untouched");
        let mut writer = brief(true);
        writer.worktree_at = Some(tree_info());
        assert!(!decide_spawn(&st, &writer, &root).queued, "a worktree writer runs beside the gate");
        let second = decide_spawn(&st, &gate, &root);
        assert!(second.queued, "a second gate waits for the first");
    }

    #[test]
    fn a_gate_waits_for_a_merge_in_flight_and_starts_when_it_ends() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let key = project_key(&root);
        super::super::worktree::begin_merge_for_test(&key);
        let mut gate = brief(true);
        gate.gate = true;
        let d = decide_spawn(&st, &gate, &root);
        assert!(d.queued, "the worktree sub's commits are not in the main checkout yet");
        st.registry.upsert_interactive(&d.sid, &root, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&d.sid, Some("g-main".into()));
        store_sub_brief(&d.sid, "g-main");
        set_gate(&d.sid);
        sweep(&st);
        assert_eq!(gate_holder_of(&root), None, "still merging");
        super::super::worktree::end_merge_for_test(&key);
        sweep(&st);
        assert_eq!(gate_holder_of(&root).as_deref(), Some(d.sid.as_str()), "it runs after the merge");
    }
