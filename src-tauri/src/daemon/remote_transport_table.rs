//! The phone/peer-machine RPC allowlist consulted by `remote_handlers::rpc_dispatch`
//! and by `machines/forward.rs` before relaying a call to a paired peer. Split out of
//! `remote_handlers.rs` (ai_todo 934): the table's own per-method rationale comments
//! (required by this repo's `CLAUDE.md`) and its coupled `#[cfg(test)] mod tests` were
//! most of that file's regrowth past its size convention. `remote_handlers.rs`
//! re-exports `TransportMask`, `TRANSPORT_TABLE`, and `allowed` so every existing
//! `remote_handlers::...` path (`machines/forward.rs`'s import, doc comments across
//! `daemon/methods/`, `remote_server.rs`'s glob import) keeps resolving unchanged.

use crate::daemon::rpc::Transport;

/// Which transports may invoke one daemon RPC method. `phone` is the
/// original (and only, pre-federation) remote surface; `machine` is a
/// paired peer daemon mirroring/forwarding a session. `Transport::Local`
/// (the desktop pipe) is never gated - see `allowed`.
#[derive(Clone, Copy)]
pub(crate) struct TransportMask {
    pub phone: bool,
    pub machine: bool,
}
const P: TransportMask = TransportMask { phone: true, machine: false };
const PM: TransportMask = TransportMask { phone: true, machine: true };
// Machine-only: session mirroring control-plane RPCs a phone has no
// business calling. First user: `peer_unpaired` below.
const M: TransportMask = TransportMask { phone: false, machine: true };

/// Daemon RPC methods a remote client (phone or peer machine) may invoke via
/// `POST /api/rpc`, and which of the two may. This is the load-bearing
/// security allowlist: anything NOT here is 403, so adding a method is a
/// deliberate, reviewable act. Deliberately EXCLUDED: `shutdown_daemon`,
/// `set_settings` (could disable security), all `*_channel` (automation/bridge
/// control), and the streaming methods `attach_session` /
/// `detach_session` / `subscribe_global` (connection-scoped; the WS endpoint
/// handles streaming instead). See the tests below.
pub(crate) const TRANSPORT_TABLE: &[(&str, TransportMask)] = &[
    // Session-mirroring surface: a peer machine needs these to list, spawn,
    // drive and read a chat it mirrors, same as the phone always could.
    ("list_instances", PM),
    ("list_pending_prompts", P),
    // Write: spawns a claude process rooted at any client-supplied cwd. The
    // baseline capability every "strictly weaker" rationale below is measured against.
    ("start_session", PM),
    // Write: session_id is looked up in the live session map, not a path.
    ("send_message", PM),
    ("cancel_turn", PM),
    // Write: Chat menu's Freeze/Unfreeze and the composer's "Send now
    // (unfreezes chat)" choice. Freeze is `cancel_turn` plus a registry flag
    // on a session_id the caller already knows; unfreeze clears that flag and
    // at most re-sends "continue" - both strictly weaker than send_message.
    ("freeze_session", P),
    ("unfreeze_session", P),
    ("respond_permission", PM),
    ("respond_question", PM),
    // Write: resolves one render-confirmation waiter by client-supplied id.
    // Strictly weaker than `respond_question` above, which takes the same kind
    // of id and also delivers an answer. A phone is a legitimate renderer, so
    // excluding it would ack false for every phone-delivered question (todo 735).
    ("confirm_question_rendered", P),
    // Read-only: durable Skip marks for one session_id, so a phone reopening
    // a chat sees "Skipped" instead of "awaiting answer" forever (todo 661).
    ("get_skipped_question_marks", P),
    ("set_session_effort", P),
    ("set_session_model", P),
    ("set_auto_accept", P),
    ("list_auto_accept", P),
    // Read-only transcript paging - the chat pane's own render path, so a
    // peer machine mirroring a session needs it too.
    ("load_history_page", PM),
    // Read-only: fetch one ToolResult's untruncated output (the "Load full
    // output" affordance on a page-truncated tool row). Same read-only
    // transcript access as load_history_page, just addressed by seq.
    ("load_event_detail", PM),
    // Read-only past-session browsing for the phone History view (mirrors
    // desktop's `list_history` / `load_history` Tauri commands). Without
    // these HttpTransport had no case for either name, so the view silently
    // rendered empty.
    ("list_history", P),
    ("load_history", P),
    // Read-only: the same transcript as load_history, folded to a message count
    // and a model name so the session-detail cards never ship the file itself.
    ("transcript_stats", P),
    // Write: re-registers an ended session as Interactive (History's "Continue
    // this chat"). Narrow mutation, strictly weaker than start_session
    // (already remote-callable). Without this the button silently no-op'd on
    // remote (403, swallowed by the caller).
    ("register_historical", P),
    // Read-only: path is canonicalized and prefix-checked against
    // <app-data>/chat-attachments/ in read_attachment_impl.
    ("read_attachment", P),
    // Write: phone composer paperclip upload. Bytes land in the path-validated
    // chat-attachments dir (write_attachment rejects path-traversal session ids),
    // so this is not an arbitrary-write primitive.
    ("paste_attachment", P),
    ("list_characters", P),
    ("list_project_groups", P),
    // Read-only: `file` is canonicalized and prefix-checked against the
    // character's own dir via Character::asset_path_checked (todo 656).
    ("character_asset_url", P),
    // Read-only: resolves the same character/slot voiceline rule
    // `notifications::fire` uses natively (mute/whitelist/character gating
    // included) and returns a data URL instead of playing bytes, so the
    // remote client can mirror the sound the desktop app just played.
    ("resolve_voiceline", P),
    ("resolve_whitelist_characters", P),
    ("list_session_characters", P),
    // Write: assigns a character to a freshly-created remote session (the
    // desktop-only Tauri command `ensure_session_character` had no remote
    // mirror, so remote-started chats never got an avatar - ai_todo fix).
    // Only mutates `session_characters` for the given session_id via
    // whitelist pick_random; cannot touch any other settings field.
    ("ensure_session_character", P),
    // Read-only project list. PM (not just P): a peer daemon needs this too -
    // `list_machine_projects`'s RPC forwards this SAME method name to
    // whichever machine the desktop's new-chat picker asked about, verbatim.
    ("list_projects", PM),
    // Read-only, gated by reject_unknown(cwd) in registry.rs (todo 656).
    ("project_last_activity_at", P),
    // Read-only account-pin resolution, gated by reject_unknown(cwd) in the
    // handler (registry.rs) since cwd is client-supplied.
    ("resolve_project_account", P),
    // Read-only, gated by reject_unknown(root) in registry.rs (todo 656).
    ("get_project_tech", P),
    // Read-only fs read + base64 return; gated by reject_unknown(root) in
    // registry.rs - was the worst of the four todo-656 findings (unguarded).
    ("get_project_icon", P),
    // Read-only usage/token history for the remote homescreen + statistics.
    ("get_history", P),
    ("get_token_history", P),
    ("get_active_sessions", P),
    // Read-only current-usage-percentage + per-account login-state maps for the
    // phone Dashboard (mirrors desktop's `get_usage_map` / `get_auth_state_map`
    // Tauri commands). See their handlers in `daemon/methods/registry.rs` for
    // the cross-process derivation notes.
    ("get_usage_map", P),
    ("get_auth_state_map", P),
    // Write-ish but narrow: triggers a live claude.ai poll on the connected
    // desktop app (click-to-refresh usage dials) - it cannot mutate anything
    // besides the usage snapshot cache/DB the read-only methods above already
    // expose, and only refreshes (never adds/removes) an account.
    ("request_live_usage_refresh", P),
    // Read-only, transcript-derived context-window status for a session
    // (mirrors desktop's `context_status` Tauri command). Without this the
    // phone had no daemon RPC for it at all - it silently fell back to a
    // frontend heuristic using a possibly-stale cached model, which could
    // show a wildly different % than desktop for the same session.
    ("context_status", P),
    // Read-only account registry so the phone's new-chat picker lists the same
    // accounts as desktop (ai_todo 241). Read-only: no add/remove/logout/default
    // mutators are exposed - the phone can pick an account to spawn under, not
    // reconfigure the desktop's accounts.
    ("list_accounts", P),
    // Visual settings (theme, colors) so the phone mirrors the desktop appearance.
    // set_settings is deliberately NOT here (phone must not mutate desktop settings).
    ("get_settings", P),
    // Read-only filesystem scan of the slash-command/skill dirs so the phone's
    // `/` autocomplete popup populates like desktop's (was always empty otherwise).
    // Guarded by reject_unknown(project_dir) in registry.rs when project_dir is set.
    ("list_slash_commands", P),
    // Scheduled-items list + mutators (ai_todo 257 shipped the read; ai_todo 259
    // added the writes). Rationale for exposing the mutators remotely: a paired
    // client can already `start_session` + `send_message` (spawn and drive an
    // arbitrary `claude` run) and `respond_permission`, so every schedule
    // mutator is strictly WEAKER than the remote surface already granted -
    // `schedule_fire_now` just fires a pre-composed message `send_message`
    // could already send, and create/update/delete only manage a queue of
    // future sends. The trust boundary is the same pairing token for all of
    // them. `schedule_list_external` stays desktop-only (it's a Windows Task
    // Scheduler read, not a daemon RPC).
    ("schedule_list", P),
    ("schedule_create", P),
    ("schedule_update", P),
    ("schedule_delete", P),
    ("schedule_fire_now", P),
    // Read-only HTML preview store (ai_todo 138), phone-ready per the design's
    // "RPC-mirrored like read_attachment" decision. The WRITE path
    // (`push_preview`) is deliberately NOT here: pushes go through the
    // unauthenticated `/hooks/preview` hook-server endpoint instead, mirroring
    // the existing push(hook server)/read(remote RPC) split for this feature.
    ("list_previews", P),
    ("get_preview", P),
    // Close-chat (ai_todo: phone's "clear_session" had no remote path at all,
    // so the button silently no-op'd). Strictly weaker than the remote surface
    // already granted: a paired client can already `start_session` +
    // `send_message` to spawn and drive an arbitrary `claude` run, so ending
    // one it already knows the id of is not a new capability class. Mirrors
    // desktop's `ipc::clear_session` (builtins.rs): `end_session` kills the
    // underlying process for daemon-hosted (interactive) sessions and marks
    // the registry entry ended; `mark_session_ended` alone is the fallback for
    // sessions `end_session` doesn't know about (e.g. External, not in the
    // daemon's SessionMap) so the sidebar entry still clears instead of
    // leaving a ghost row. Without both, remote close-chat would either 403
    // or silently leak the subprocess (the exact bug `clear_session` exists
    // to prevent - see builtins.rs's doc comment).
    ("end_session", PM),
    ("mark_session_ended", PM),
    // Read/write worktree picker data (ai_todo 434): phone had no daemon RPC
    // for any of these, so the picker silently showed nothing. Same git
    // subprocess calls the desktop Tauri commands already run locally.
    // All path params reject_unknown-gated in worktrees.rs (verified todo 656).
    ("list_worktree_details", P),
    ("create_worktree", P),
    ("remove_worktree", P),
    ("get_recent_branches", P),
    // Read-only PR-review file browsing (ai_todo 244), mirrors desktop's
    // `ipc::git_diff` commands; pr_review.rs rejects any unknown `cwd`.
    ("get_range_files", P),
    ("get_file_diff", P),
    // Read-only statusbar chips + location-picker scan (mirrors desktop's
    // `ipc::git` / `ipc::servers` / `ipc::claude_scopes` commands), path
    // params reject_unknown-gated in statusbar.rs. Missing here was the
    // confirmed root cause of the phone's forever-loading git chips.
    ("get_git_info", P),
    ("get_git_dirty", P),
    ("get_commit_sync", P),
    ("get_commit_history", P),
    // Write action off the commits chip's push button (path gated by
    // reject_unknown in statusbar.rs, same as the worktree writes above).
    ("push_commits", P),
    ("list_project_servers", P),
    ("list_claude_md_scopes", P),
    // Cross-surface draft sync: composer text, AUQ answers, held messages.
    // Session-scoped, not path-scoped - same "session_id known to this
    // daemon" boundary as send_message/respond_permission above. In-memory
    // (draft_store.rs), capped + LRU-evicted, never touches disk.
    ("get_session_drafts", PM),
    ("set_composer_draft", PM),
    ("clear_composer_draft", PM),
    ("set_auq_draft", PM),
    ("clear_auq_draft", PM),
    ("add_held_message", PM),
    ("update_held_message", PM),
    ("remove_held_message", PM),
    ("clear_held_messages", PM),
    // Read-only local-process log tail for a `waiting_on` chip (todo 675).
    // NETWORK-REACHABLE FILE READ: `path` is re-validated by `safe_local_path`
    // against the session's OWN registered cwd at the point the daemon
    // actually opens the file (methods/registry/waiting_tail.rs).
    ("tail_waiting_log", P),
    // Todos panel: the phone's FAB dial mounts it unconditionally (no
    // isRemote() guard in fab-dial.ts); read and edit the same user-todo
    // board as desktop (todo 1007). Backend handlers already existed
    // (methods/user_todos.rs) - only the allowlist entry was missing.
    ("list_user_todos", P),
    ("set_user_todo_state", P),
    ("mark_todos_seen", P),
    ("set_todo_columns", P),
    ("clear_archived_todos", P),
    // Ask panel: same fab-dial reachability as Todos above (todo 1007).
    ("ask_list_threads", P),
    ("ask_send", P),
    ("ask_delete_thread", P),
    // Drafts panel: same fab-dial reachability as Todos above (todo 1007).
    // A DIFFERENT command namespace than get_session_drafts/set_composer_draft
    // (composer/AUQ draft sync, PM above) - this is the Drafts panel's own
    // list/edit/delete store (methods/drafts_store/routes.rs).
    ("list_message_drafts", P),
    ("set_draft_body", P),
    ("set_draft_version", P),
    ("set_draft_state", P),
    ("delete_draft", P),
    // Machine-only: `unpair_machine`'s outbound half. Removes ctx.transport's
    // own entry, never a params-supplied id (see methods/machines.rs).
    ("peer_unpaired", M),
    // Machine-only: the peer-facing half of `spawn_chat`'s `machine` param
    // (multi-machine chat parity) - a phone has its own `start_session`
    // already and never relays a chat spawn between two OTHER machines.
    // Registered by `methods::spawn_chat::register_spawn_chat_rpc`.
    ("spawn_chat", M),
    // Machine-only: the peer-facing half of `post_message`'s `to` param when
    // it addresses a session mirrored from a paired peer - a phone never
    // relays a repo-channel post between two OTHER machines either.
    // Registered by `methods::channel::register_channel_rpc`.
    ("peer_channel_post", M),
];

/// True when `t` may invoke `method`. `Transport::Local` (the desktop pipe)
/// is never gated. Absent from the table means refused for every remote
/// transport.
pub(crate) fn allowed(method: &str, t: &Transport) -> bool {
    if matches!(t, Transport::Local) {
        return true;
    }
    let Some((_, mask)) = TRANSPORT_TABLE.iter().find(|(m, _)| *m == method) else {
        return false;
    };
    match t {
        Transport::Local => true,
        Transport::Phone => mask.phone,
        Transport::PeerMachine(_) => mask.machine,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_excludes_dangerous_methods() {
        for m in [
            "shutdown_daemon", "set_settings", "start_channel", "stop_channel",
            "restart_channel", "show_channel", "hide_channel",
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
            "confirm_question_rendered",
            "get_skipped_question_marks",
            "respond_permission", "load_history_page", "load_event_detail", "list_history", "load_history",
            "transcript_stats",
            "register_historical", "read_attachment",
            "paste_attachment", "list_characters", "list_project_groups",
            "character_asset_url", "resolve_voiceline", "resolve_whitelist_characters", "list_projects",
            "project_last_activity_at", "get_project_tech", "get_project_icon",
            "get_history", "get_token_history", "get_active_sessions",
            "get_usage_map", "get_auth_state_map", "context_status",
            "list_accounts", "list_slash_commands", "ensure_session_character",
            "schedule_list", "schedule_create", "schedule_update",
            "schedule_delete", "schedule_fire_now", "list_previews", "get_preview",
            "end_session", "mark_session_ended",
            "list_worktree_details", "create_worktree", "remove_worktree", "get_recent_branches",
            "get_range_files", "get_file_diff",
            "get_git_info", "get_git_dirty", "get_commit_sync", "get_commit_history",
            "push_commits", "list_project_servers",
            "list_claude_md_scopes",
            "get_session_drafts", "set_composer_draft", "clear_composer_draft",
            "set_auq_draft", "clear_auq_draft", "add_held_message",
            "update_held_message", "remove_held_message", "clear_held_messages",
            "tail_waiting_log",
            "list_user_todos", "set_user_todo_state", "mark_todos_seen",
            "set_todo_columns", "clear_archived_todos",
            "ask_list_threads", "ask_send", "ask_delete_thread",
            "list_message_drafts", "set_draft_body", "set_draft_version",
            "set_draft_state", "delete_draft",
        ] {
            assert!(allowed(m, &Transport::Phone), "{m} should be remotely callable");
        }
    }

    /// Every `machine:true` entry is `PM` (phone subset) or a named `M`-only
    /// exception like `peer_unpaired`, never an unreviewed superset.
    #[test]
    fn peer_machine_mask_is_phone_subset_or_a_named_machine_only_exception() {
        const MACHINE_ONLY_EXCEPTIONS: &[&str] = &["peer_unpaired", "spawn_chat", "peer_channel_post"];
        for (m, mask) in TRANSPORT_TABLE {
            if mask.machine && !mask.phone {
                assert!(
                    MACHINE_ONLY_EXCEPTIONS.contains(m),
                    "{m} is machine-only but not in MACHINE_ONLY_EXCEPTIONS"
                );
            }
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

    /// The multi-machine chat-parity methods (`spawn_chat`/`peer_channel_post`
    /// forwarded FROM a peer) are machine-only, same as `peer_unpaired` above.
    #[test]
    fn chat_parity_methods_are_machine_only() {
        for m in ["spawn_chat", "peer_channel_post"] {
            assert!(allowed(m, &Transport::PeerMachine("x".into())), "{m} must be callable by a peer machine");
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
        }
    }

    /// `pair_machine`/`unpair_machine`/`set_machine_label` are desktop-pipe-only:
    /// absent from `TRANSPORT_TABLE`, so neither remote transport can call them.
    #[test]
    fn machine_identity_mutators_are_desktop_pipe_only() {
        for m in ["pair_machine", "unpair_machine", "set_machine_label"] {
            assert!(!allowed(m, &Transport::Phone), "{m} must not be callable by a phone");
            assert!(
                !allowed(m, &Transport::PeerMachine("x".into())),
                "{m} must not be callable by a peer machine"
            );
            assert!(allowed(m, &Transport::Local), "{m} must stay callable over the desktop pipe");
        }
    }

    #[test]
    fn local_transport_is_never_gated() {
        assert!(allowed("shutdown_daemon", &Transport::Local));
        assert!(allowed("not_a_real_method", &Transport::Local));
    }
}
