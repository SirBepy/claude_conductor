    use super::*;

    #[test]
    fn allowlist_excludes_dangerous_methods() {
        for m in [
            "shutdown_daemon", "set_settings",
            "attach_session", "detach_session", "subscribe_global",
            "externalize_session", "takeover_manual",
            // schedule mutators became remote-callable in ai_todo 259 (they are
            // strictly weaker than start_session/send_message, which remote
            // already grants). schedule_list_external stays desktop-only: it's a
            // Windows Task Scheduler filesystem read with no daemon RPC at all.
            "schedule_list_external",
        ] {
            assert!(
                !allowed(m, &Transport::Phone),
                "{m} must NOT be remotely callable"
            );
        }
    }

    #[test]
    fn allowlist_includes_core_chat_methods() {
        for m in [
            "list_instances", "send_message", "cancel_turn", "respond_question",
            "freeze_session", "unfreeze_session",
            "get_hidden_chats", "update_hidden_chats",
            "confirm_question_rendered",
            "get_skipped_question_marks",
            "respond_permission", "load_history_page", "load_event_detail", "list_history", "load_history",
            "transcript_stats",
            "register_historical", "read_attachment",
            "paste_attachment", "list_characters", "list_project_groups", "new_session_bundle",
            "character_asset_url", "resolve_voiceline", "resolve_whitelist_characters", "list_projects",
            "project_last_activity_at", "get_project_tech", "get_project_icon",
            "count_ai_todos", "list_ai_todos", "list_ai_backlog", "read_ai_todo",
            "get_history", "get_history_meta", "get_token_history", "get_active_sessions",
            "get_usage_map", "get_auth_state_map", "context_status",
            "get_api_credit_status", "refresh_api_credit_status", "get_provider_usage",
            "list_accounts", "list_slash_commands", "ensure_session_character",
            "schedule_list", "schedule_create", "schedule_update",
            "schedule_delete", "schedule_fire_now", "list_previews", "get_preview", "read_image_file",
            "end_session", "mark_session_ended",
            "list_worktree_details", "create_worktree", "remove_worktree", "get_recent_branches",
            "get_range_files", "get_file_diff", "resolve_commit_refs", "get_ticket_tracker", "get_file_at_rev",
            "list_branch_files",
            "get_git_info", "get_git_dirty", "get_commit_sync", "get_commit_history",
            "push_commits", "list_project_files", "chat_drains", "instance_token_stats", "chat_drain",
            "create_project_folder", "github_search_repos", "github_clone_repo", "list_project_servers",
            "list_claude_md_scopes",
            "get_session_drafts", "set_composer_draft", "clear_composer_draft",
            "set_auq_draft", "clear_auq_draft", "add_held_message",
            "update_held_message", "remove_held_message", "clear_held_messages",
            "tail_waiting_log",
            "list_user_todos", "set_user_todo_state", "mark_todos_seen",
            "set_todo_columns", "clear_archived_todos",
            "voice_clean_transcript",
            "list_message_drafts", "set_draft_body", "set_draft_version",
            "set_draft_state",
            "ensure_jarvis_session", "report_link_journal",
            "list_machines", "list_machine_projects", "list_machine_accounts", "set_machine_project_account",
            "set_machine_profile", "add_project_to_skill_scope", "restart_session_process",
        ] {
            assert!(allowed(m, &Transport::Phone), "{m} should be remotely callable");
        }
    }

    #[test]
    fn move_session_to_account_is_phone_only() {
        assert!(allowed("move_session_to_account", &Transport::Phone));
        assert!(!allowed("move_session_to_account", &Transport::PeerMachine("m".into())));
    }

    #[test]
    fn ensure_jarvis_session_is_phone_only() {
        assert!(allowed("ensure_jarvis_session", &Transport::Phone));
        assert!(!allowed("ensure_jarvis_session", &Transport::PeerMachine("m".into())));
    }

    /// A long-press on a phone posts into the chat that owns the element; a peer
    /// machine must not post into this machine's chats through a preview.
    #[test]
    fn message_shared_element_is_phone_only() {
        assert!(allowed("message_shared_element", &Transport::Phone));
        assert!(!allowed("message_shared_element", &Transport::PeerMachine("m".into())));
    }

    #[test]
    fn report_link_journal_is_phone_only() {
        assert!(allowed("report_link_journal", &Transport::Phone));
        assert!(!allowed("report_link_journal", &Transport::PeerMachine("m".into())));
    }

    /// The voice-note upload writes files on the PC: a paired phone only, never a
    /// peer machine, and it must stay out of any broader mask.
    #[test]
    fn voice_upload_methods_are_phone_only() {
        for m in ["voice_upload_begin", "voice_upload_chunk", "voice_transcription_status"] {
            assert!(allowed(m, &Transport::Phone), "{m} must be callable by a phone");
            assert!(!allowed(m, &Transport::PeerMachine("m".into())), "{m} must not be callable by a peer machine");
            let (_, mask) = TRANSPORT_TABLE.iter().find(|(n, _)| *n == m).expect("row exists");
            assert!(mask.phone && !mask.machine);
        }
    }

    /// A triage run is a billed model call per note and writes todos into project
    /// folders, so it stays on the desktop pipe: no row, nothing remote reaches it.
    #[test]
    fn voice_triage_run_is_desktop_pipe_only() {
        assert!(!allowed("voice_triage_run", &Transport::Phone));
        assert!(!allowed("voice_triage_run", &Transport::PeerMachine("m".into())));
        assert!(allowed("voice_triage_run", &Transport::Local));
        assert!(!TRANSPORT_TABLE.iter().any(|(n, _)| *n == "voice_triage_run"));
    }

    /// Every `machine:true` entry is `PM` (phone subset) or a named `M`-only
    /// exception like `peer_unpaired`, never an unreviewed superset.
    #[test]
    fn peer_machine_mask_is_phone_subset_or_a_named_machine_only_exception() {
        const MACHINE_ONLY_EXCEPTIONS: &[&str] =
            &[
            "peer_unpaired",
            "spawn_chat",
            "peer_channel_post",
            "peer_accounts",
            "peer_set_project_account",
            "peer_profile_changed",
            "settings_sync",
            "character_assets_manifest",
            "character_asset_chunk",
            "sub_git_have",
            "sub_spawn",
            "sub_host_info",
            "sub_event",
            "sub_update_branch",
            "sub_fetch_branch",
            "sub_cleanup",
            "respond_secret",
            "sub_deliver",
            "sub_status",
            "sub_start",
            "sub_end",
            "sub_drop",
            "sub_to_sidebar",
            "sub_reparent",
            "sub_pause",
            "sub_resume",
            "sub_gallery_image",
        ];
        for (m, mask) in TRANSPORT_TABLE {
            if mask.machine && !mask.phone {
                assert!(
                    MACHINE_ONLY_EXCEPTIONS.contains(m),
                    "{m} is machine-only but not in MACHINE_ONLY_EXCEPTIONS"
                );
            }
        }
    }

    /// Hiding a mirrored chat is forwarded to the machine hosting it, so that
    /// machine must accept both hidden-chat methods from a peer.
    #[test]
    fn hidden_chat_methods_are_callable_by_a_peer_machine() {
        for m in ["get_hidden_chats", "update_hidden_chats"] {
            assert!(allowed(m, &Transport::PeerMachine("x".into())), "{m} must be callable by a peer machine");
            assert!(allowed(m, &Transport::Phone), "{m} must stay callable by a phone");
        }
    }

    #[test]
    fn machine_transport_is_refused_for_phone_only_methods() {
        let peer = Transport::PeerMachine("x".into());
        for m in ["push_commits", "get_settings", "schedule_create", "list_accounts"] {
            assert!(!allowed(m, &peer), "{m} must not be callable by a peer machine");
        }
    }

    /// `peer_unpaired` is the one machine-only method: callable by a peer,
    /// never by a phone.
    #[test]
    fn peer_unpaired_is_machine_only() {
        assert!(allowed("peer_unpaired", &Transport::PeerMachine("x".into())));
        assert!(!allowed("peer_unpaired", &Transport::Phone));
    }

    /// A profile edit is open to a phone and a peer; the peer's own announcement
    /// of it is machine-only.
    #[test]
    fn profile_methods_have_the_intended_reach() {
        let peer = Transport::PeerMachine("x".into());
        assert!(allowed("set_machine_profile", &peer));
        assert!(allowed("set_machine_profile", &Transport::Phone));
        assert!(allowed("peer_profile_changed", &peer));
        assert!(!allowed("peer_profile_changed", &Transport::Phone));
    }

    /// Personal settings travel between paired machines only: a phone cannot send
    /// them, and a method that writes settings is never open to it.
    #[test]
    fn settings_sync_is_machine_only() {
        for m in ["settings_sync", "character_assets_manifest", "character_asset_chunk"] {
            assert!(allowed(m, &Transport::PeerMachine("x".into())), "{m}");
            assert!(!allowed(m, &Transport::Phone), "{m}");
        }
    }

    /// A sub is started on a paired machine by its home daemon only: a phone has
    /// no main chat there to be a sub of.
    #[test]
    fn the_cross_machine_sub_spawn_methods_are_machine_only() {
        for m in [
            "sub_git_have", "sub_spawn", "sub_host_info", "sub_event", "sub_update_branch", "sub_fetch_branch", "sub_cleanup", "sub_deliver", "sub_status", "sub_start", "sub_end", "sub_drop", "sub_to_sidebar", "sub_reparent", "sub_pause", "sub_resume", "sub_gallery_image",
        ] {
            assert!(allowed(m, &Transport::PeerMachine("x".into())), "{m}");
            assert!(!allowed(m, &Transport::Phone), "{m}");
        }
    }

    /// The multi-machine chat-parity methods (`spawn_chat`/`peer_channel_post`
    /// forwarded FROM a peer) are machine-only, same as `peer_unpaired` above.
    #[test]
    fn chat_parity_methods_are_machine_only() {
        for m in ["spawn_chat", "peer_channel_post"] {
            assert!(allowed(m, &Transport::PeerMachine("x".into())), "{m} must be callable by a peer machine");
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
        }
    }

    /// `respond_secret` is the desktop's, and a paired machine's only to answer a
    /// visiting sub's card (the handler checks that): a phone token can never submit a
    /// secret.
    #[test]
    fn respond_secret_is_desktop_and_paired_machine_only() {
        assert!(!allowed("respond_secret", &Transport::Phone));
        assert!(allowed("respond_secret", &Transport::PeerMachine("x".into())));
        assert!(allowed("respond_secret", &Transport::Local));
    }

    /// `pair_machine`/`unpair_machine`/`set_machine_label` are desktop-pipe-only:
    /// absent from `TRANSPORT_TABLE`, so neither remote transport can call them.
    #[test]
    fn machine_identity_mutators_are_desktop_pipe_only() {
        for m in ["pair_machine", "unpair_machine", "set_machine_label", "set_machine_can_drive", "set_machine_sync_settings", "rename_machine"] {
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
            assert!(
                !allowed(m, &Transport::PeerMachine("x".into())),
                "{m} must not be callable by a peer machine"
            );
            assert!(allowed(m, &Transport::Local), "{m} must stay callable over the desktop pipe");
        }
    }

    /// The API broker has no RPC surface: a chat uses `api_read`/`api_write` through its own MCP
    /// child, and a remote RPC caller would name a session id of its own choosing. Neither the
    /// tools' names nor anything broker-shaped may ever be a row.
    #[test]
    fn broker_tools_are_desktop_pipe_only() {
        for m in ["api_read", "api_write", "api_call", "api_broker_http", "cc_api", "broker_call", "broker_policy_write", "broker_import", "broker_set_secret", "api_card", "respond_broker_card", "broker_friction"] {
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
            assert!(!allowed(m, &Transport::PeerMachine("x".into())), "{m} must not be callable by a peer machine");
        }
        for (m, _) in TRANSPORT_TABLE {
            assert!(!m.starts_with("api_") && !m.contains("broker"), "{m} looks like a broker method: it must stay off the remote allowlist");
        }
    }

    #[test]
    fn local_transport_is_never_gated() {
        assert!(allowed("shutdown_daemon", &Transport::Local));
        assert!(allowed("not_a_real_method", &Transport::Local));
    }

    /// Session-scoped methods a paired peer must accept so this daemon can
    /// forward a mirrored chat's call: each was phone-only (`P`) and is now
    /// `PM`, no new trust class since a peer already carries
    /// send_message/respond_permission/cancel_turn.
    #[test]
    fn mirrored_chat_control_methods_are_machine_callable() {
        let peer = Transport::PeerMachine("x".into());
        for m in [
            "list_pending_prompts", "confirm_question_rendered", "get_skipped_question_marks",
            "set_session_effort", "set_session_model", "set_auto_accept", "list_auto_accept",
            "set_subchats_on", "list_subchats_on", "list_subchat_cards",
            "freeze_session", "unfreeze_session", "paste_attachment", "read_attachment",
            "transcript_stats", "load_history", "context_status",
            "instance_token_stats", "chat_drain",
        ] {
            assert!(allowed(m, &peer), "{m} must be callable by a peer machine mirroring the chat");
        }
    }

    /// Code mode / commits popover / git chips / dirty-files reads
    /// for a session mirrored from a paired peer machine - each was
    /// phone-only (`P`) and is now `PM`, routed by `machines/forward.rs`
    /// once `session_id` resolves to a mirrored row. `resolve_cwd`
    /// (pr_review.rs) resolves the real cwd from the OWNING daemon's own
    /// registry whenever `session_id` is present, so a forwarding peer's
    /// `cwd` is never trusted - no new trust class over the
    /// send_message/load_history_page a peer already carries.
    #[test]
    fn mirrored_git_and_file_read_methods_are_machine_callable() {
        let peer = Transport::PeerMachine("x".into());
        for m in [
            "get_git_info", "get_git_dirty", "get_commit_sync", "get_commit_history",
            "get_recent_branches", "get_range_files", "get_file_diff", "get_file_at_rev",
            "list_branch_files", "list_project_files", "count_ai_todos", "list_ai_todos", "list_ai_backlog", "read_ai_todo",
        ] {
            assert!(allowed(m, &peer), "{m} must be callable by a peer machine mirroring the chat");
        }
    }

    /// The Backlog panel edits PLAN.md, moves todos to `done/` and spawns chats:
    /// desktop-pipe only, like the machine-identity mutators.
    #[test]
    fn backlog_panel_writes_are_desktop_pipe_only() {
        for m in [
            "ai_todo_archive", "ai_todo_unarchive", "ai_todo_plan_move",
            "ai_todo_plan_reorder_groups", "ai_todo_start_chat",
        ] {
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
            assert!(!allowed(m, &Transport::PeerMachine("x".into())), "{m} must not be callable by a peer machine");
            assert!(allowed(m, &Transport::Local), "{m} must stay callable over the desktop pipe");
        }
    }

    /// `get_project_icon`/`get_project_tech` are a DIFFERENT forward shape
    /// than the git/file reads above - no `session_id` to route by, so
    /// `project_meta.rs::forward_project_read_if_peer` forwards by an
    /// explicit `machine_id` param instead (same idea as
    /// `list_machine_projects`). The forwarding daemon's own call still lands
    /// on the peer's `/api/rpc`, so the peer must accept it from a
    /// `PeerMachine` caller too - each was phone-only (`P`) and is now `PM`.
    #[test]
    fn project_icon_and_tech_are_machine_callable() {
        let peer = Transport::PeerMachine("x".into());
        for m in ["get_project_icon", "get_project_tech"] {
            assert!(allowed(m, &peer), "{m} must be callable by a peer machine for the machine_id forward");
        }
    }

    /// `list_machine_projects` forwards `new_session_bundle` to the picked
    /// machine, which answers a peer caller with a slim `{groups, stats}`
    /// (pinned in registry.rs's bundle tests), so it must be `PM`. The phone
    /// keeps the full bundle, and the picker RPC itself stays phone-only.
    #[test]
    fn new_session_bundle_is_machine_callable_for_the_project_picker() {
        assert!(allowed("new_session_bundle", &Transport::PeerMachine("x".into())));
        assert!(allowed("new_session_bundle", &Transport::Phone));
    }

    /// A mirrored chat's previews and option-preview images live on its host,
    /// so the host must answer a peer for them. `push_preview` (the write) and
    /// the desktop-only unrestricted image read stay off both remote transports.
    #[test]
    fn preview_and_image_reads_are_machine_callable_but_the_write_is_not() {
        let peer = Transport::PeerMachine("x".into());
        for m in ["list_previews", "get_preview", "read_image_file"] {
            assert!(allowed(m, &peer), "{m} must be callable by a peer machine");
            assert!(allowed(m, &Transport::Phone), "{m} must stay callable by a phone");
        }
        assert!(!allowed("push_preview", &peer));
        assert!(!allowed("push_preview", &Transport::Phone));
    }

    /// The write/mutating counterparts stay phone-only: this follow-up proxies
    /// reads only, never a mirrored chat's git mutations (step 6 of the
    /// todo). `push_commits` has no local-disk write of its own beyond
    /// `git push`, but it still mutates a remote the owning peer, not this
    /// daemon, is authoritative for - the frontend keeps it hidden/disabled
    /// for a mirrored chat (session-statusbar.ts / git-fold.ts) rather than
    /// proxying it.
    #[test]
    fn mirrored_git_write_methods_stay_phone_only() {
        let peer = Transport::PeerMachine("x".into());
        assert!(allowed("push_commits", &Transport::Phone));
        assert!(!allowed("push_commits", &peer), "push_commits must not be callable by a peer machine");
    }

    /// The phone's machine picker RPCs are P, never M: a peer machine already
    /// knows its own federation state and must not learn about this daemon's
    /// OTHER peers through a forwarded call.
    #[test]
    fn machine_picker_methods_are_phone_only() {
        let peer = Transport::PeerMachine("x".into());
        for m in ["list_machines", "list_machine_projects", "list_machine_accounts", "set_machine_project_account"] {
            assert!(allowed(m, &Transport::Phone), "{m} must be callable by the phone");
            assert!(!allowed(m, &peer), "{m} must not be callable by a peer machine");
        }
    }

    /// Reading a sub in place is a phone surface too, so its way out must reach
    /// the phone. A peer machine never holds a sub, so it gets no row.
    #[test]
    fn move_sub_to_sidebar_is_phone_only_and_send_message_stays_open_to_both() {
        assert!(allowed("move_sub_to_sidebar", &Transport::Phone));
        assert!(!allowed("move_sub_to_sidebar", &Transport::PeerMachine("x".into())));
        assert!(allowed("send_message", &Transport::Phone));
    }

    #[test]
    fn the_subchats_card_methods_are_phone_only_but_the_brief_which_a_home_reads_from_its_host() {
        assert!(allowed("set_sub_pinned", &Transport::Phone));
        assert!(!allowed("set_sub_pinned", &Transport::PeerMachine("x".into())));
        // The brief and the images of a sub that runs on a paired machine are read from that machine.
        for m in ["get_sub_brief", "list_session_images"] {
            assert!(allowed(m, &Transport::Phone), "{m}");
            assert!(allowed(m, &Transport::PeerMachine("x".into())), "{m}");
        }
    }

    /// The gallery reader that takes an id naming a file stays phone-only: a paired machine
    /// reads a sub's image only through `sub_gallery_image`, which checks the id against the
    /// sub's own transcript.
    #[test]
    fn the_gallery_reader_that_takes_a_path_id_stays_phone_only_and_a_hosts_image_call_is_machine_only() {
        assert!(allowed("dashboard_gallery_image", &Transport::Phone));
        assert!(!allowed("dashboard_gallery_image", &Transport::PeerMachine("x".into())));
        assert!(allowed("sub_gallery_image", &Transport::PeerMachine("x".into())));
        assert!(!allowed("sub_gallery_image", &Transport::Phone));
    }

    #[test]
    fn flagging_a_card_shown_badly_is_phone_only() {
        assert!(allowed("flag_shown_badly", &Transport::Phone));
        assert!(!allowed("flag_shown_badly", &Transport::PeerMachine("x".into())));
    }

    #[test]
    fn moving_a_chat_into_a_main_chat_is_phone_only() {
        for m in ["move_chat_into_main", "former_main_chat"] {
            assert!(allowed(m, &Transport::Phone), "{m}");
            assert!(!allowed(m, &Transport::PeerMachine("x".into())), "{m}");
        }
    }

    /// The Android push handle is enrolled by the phone only.
    #[test]
    fn register_fcm_handle_is_phone_only() {
        assert!(allowed("register_fcm_handle", &Transport::Phone));
        assert!(!allowed("register_fcm_handle", &Transport::PeerMachine("x".into())));
    }

    /// The phone's one settings write; a peer machine has no such toggle.
    #[test]
    fn set_push_show_chat_name_is_phone_only() {
        assert!(allowed("set_push_show_chat_name", &Transport::Phone));
        assert!(!allowed("set_push_show_chat_name", &Transport::PeerMachine("x".into())));
    }

    /// The phone's durable head order is one narrow settings write: phone and desktop
    /// pipe only, and `save_settings` stays out of reach.
    #[test]
    fn set_chat_heads_order_is_phone_only_and_save_settings_stays_refused() {
        assert!(allowed("set_chat_heads_order", &Transport::Phone));
        assert!(allowed("set_chat_heads_order", &Transport::Local));
        assert!(!allowed("set_chat_heads_order", &Transport::PeerMachine("x".into())));
        assert!(!allowed("save_settings", &Transport::Phone));
    }

    /// The viewed mark clears a head's badge on every device: the phone and a peer machine
    /// both send and read it, so a view on one device reaches the others. `save_settings`
    /// stays out of reach, and neither method is a broker or secret method.
    #[test]
    fn the_viewed_mark_methods_are_callable_by_the_phone_and_a_peer_machine() {
        let peer = Transport::PeerMachine("x".into());
        for m in ["chat_seen_mark", "chat_seen_list"] {
            assert!(allowed(m, &Transport::Phone), "{m} must be callable by the phone");
            assert!(allowed(m, &peer), "{m} must be callable by a peer machine mirroring the chat");
            assert!(allowed(m, &Transport::Local));
        }
        assert!(!allowed("save_settings", &Transport::Phone));
    }

    /// The phone's "Enable here": add one project to a skill's scope, then restart
    /// the chat. Phone and desktop pipe only; a peer machine edits neither this
    /// machine's scopes nor restarts its chats through them.
    #[test]
    fn skill_scope_enable_and_restart_are_phone_only() {
        for m in ["add_project_to_skill_scope", "restart_session_process"] {
            assert!(allowed(m, &Transport::Phone), "{m} must be callable by the phone");
            assert!(!allowed(m, &Transport::PeerMachine("x".into())), "{m} must not be callable by a peer machine");
            assert!(allowed(m, &Transport::Local), "{m} must stay callable over the desktop pipe");
        }
        // The scope write is narrow by name: no generic scope setter is exposed.
        for m in ["set_skill_scope", "set_skill_scopes", "remove_project_from_skill_scope"] {
            assert!(!allowed(m, &Transport::Phone), "{m} must not be remotely callable");
        }
    }

    /// The host halves of the cross-machine account picker are machine-only:
    /// a peer reaches them through the wrappers above, and a phone connected
    /// straight to this daemon has no business calling them (nor the full
    /// `list_accounts` shape being what a peer receives).
    #[test]
    fn peer_account_methods_are_machine_only() {
        let peer = Transport::PeerMachine("x".into());
        for m in ["peer_accounts", "peer_set_project_account"] {
            assert!(allowed(m, &peer), "{m} must be callable by a peer machine");
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
            assert!(allowed(m, &Transport::Local), "{m} stays callable over the desktop pipe");
        }
    }
