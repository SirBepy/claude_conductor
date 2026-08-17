# Comments for Bepy

## 2026-07-07 - /autopilot: multi-account implementation (docs/multi-account 01-08, plan @ edba2bbe)

GOAL (Joe): implement the revised multi-account plan end to end. Design settled with Joe live this session (CLAUDE_CONFIG_DIR profiles, /login-only auth, ~/.claude = observed terminal identity, junction recipe, two-plane wizard). Oracle: each milestone's acceptance code-complete; cargo build + pnpm tsc --noEmit + scoped tests green per chunk; /login + CDP live QA parked to BEPY_TODOS.

RUN_LEDGER (chunk -> outcome -> sha):
- M01 backend (accounts module, profile-dir factory w/ junction recipe, identity read, login-step plumbing, per-account cookie store, 10 IPC cmds; 31 new tests green, build+tsc+export_types clean) -> d2144791. Deviations: cross-check compares org_uuid only (org-list API email field unverified); API-key logins surface as wizard timeout rather than explicit error.
- M01 frontend (4-step wizard modal per mockup + Settings>Accounts stub w/ terminal row; 25 logic tests, tsc+build green; added optional "skip browser login" per backend doc) -> 73006557. Parked: re-entry path to add a cookie later (M07 account-row action).
- M02 routing (CLAUDE_CONFIG_DIR inject at 3 spawn sites incl. Win32 env-block, cred-var scrub, account_id threaded + dual-persisted, billing gate on child env, drift guard, reader audit comments, per-account models probe; scoped tests + build + tsc green) -> 9e9aee36. NOTE: hard cliff - chats refuse to spawn until first account added; BEPY_TODO Urgent written. Deviation: account_id Option + daemon-side default resolve (keeps phone HTTP path working).
- M03 usage (per-account poll w/ org-by-uuid + failure isolation, legacy session.txt path byte-identical, snapshot account_id + DB migration v2, per-account capacity files, get_usage_map/get_auth_state_map IPC; 57 scoped tests green, build+tsc green; run interrupted once by session limit, resumed same agent) -> 18a01e89. Parked to M08: org_uuid history re-key; per-account CDP auto-relogin stays wizard-driven.
- M04 binding (ProjectConfig.preferred_account_id + dedupe carry-forward, Automation "Claude account" row, reverse projects list on account rows, collapsed/expand modal picker w/ remember-for-project, shared account-chip component, explicit account_id threaded through start_session incl. phone transport; 45+ scoped cargo + 514 vitest green, build+tsc green) -> 1567d179. Parked: open_chats_new_chat path already drops modal extras pre-existing (falls back to default account, no regression).
- M05 dashboard (account-selector cards w/ usage%/safepace% + glow, widget registry global/account scope, pinnedCards->dashboardWidgets one-time migration, Statistics view deleted w/ all widgets migrated incl. new project-list; 544 vitest + tsc + build green) -> 1e23a269. Deviations: reorder = up/down buttons not drag; chart project-breakdown still global (token records lack account_id, out of scope); refresh on mount/events not live push.
- M06 tray+overlay (glyph/number/nothing modes w/ legacy defaultDisplay migration, per-account tray render + multi-account tab-aligned tooltip, left-click toggles new frameless always-on-top overlay listing all accounts translucent->opaque-on-hover; 43 Rust + 8 vitest new tests, 552 vitest total, build+tsc green) -> bdda535f. Deviations: overlay window label session-overlay reuses existing session-* capability (no capabilities edit); left-click no longer cycles display modes (replaced by overlay toggle, dashboard still in right-click menu). Settings UI for tray mode/overlay opacity -> M07.
- M07 settings (removed display_mode/threshold_warn/threshold_crit/sync w/ old-settings.json load regression tests, colorApplyTo.overlay in both colour twins, accounts UI polish: live identity surface w/ email/tier/expiry/red drift warning + re-auth + connect-usage re-entry, get_account_identity/reauth_account/recapture_account_cookie IPC, tray+overlay settings section, old single Log Out removed; 566 vitest + scoped cargo + build + tsc green) -> 10e04b34. Deviation: pinnedCards KEPT (live one-time migration trigger from M05, removing would break existing users).
- M08 final (per-account thresholdCrossed + {account} token, migration module: setup-prompt banner + org_uuid history re-key + session.txt->.bak retire, daemon spawn-env e2e (#[ignore], written not run), WDIO multi-account spec (written not run), README multi-account section; 9+4+2 new Rust tests green) -> 279dd825.
- FINAL VERIFY (cumulative tree, run by orchestrator): cargo build clean, pnpm tsc --noEmit ZERO errors, vitest 566 passed / 19 pre-existing skips, pnpm build green, no orphan node processes. NOT pushed/deployed - the hard cliff (below) means Joe should QA the wizard live before pushnbump.
- ITERATE-IT ESCALATIONS USED: 0/3. All judgment calls were direct (each logged per-chunk above).
- POST-RUN QA SWEEP (Joe asked "anything missed + run everything"): FULL cargo test --lib 571/571 + ALL integration binaries green (this killed the dev daemon once, expected). Found + fixed: icon_render_renders integration test missed M06 IconSettings fields (compile break no scoped filter caught); hook_installer_merge test could NEVER run on Windows (UAC installer-name heuristic, os error 740) -> renamed hook_merge_behavior, its 9 tests now run -> 5a6ccef9. Audit subagent found 1 CRITICAL (overlay window never loaded settings - opacity + colours dead there) + 2 MEDIUM (no tray refresh on account add/remove; daemon settings cache only pushed at handshake so stale default_account_id for resumed uncached sessions) + 2 minor - all five fixed -> 633153af. The #[ignore] daemon spawn-env e2e HANGS when run alongside the live daemon (killed after 10 min, no residue; accounts.json untouched) - it needs a dedicated run with the app closed. /code-check over the whole feature: 4 structural findings -> ai_todos 158-161 (2 file splits, bak_path dup, lite-account type triplication), nothing blocking.

## 2026-06-28 - /autopilot: rename "Claude Usage" -> "Claude Conductor" (CC)

GOAL (Joe): full naming consistency across the app identity; sole user, fine reinstalling; approved bundle-id + app-data + daemon-bin + pipe lockstep changes. Don't break anything.

Naming map applied (LIVE files only; archival docs/.for_bepy left as historical record):
- Display "Claude Usage" -> "Claude Conductor"
- pkg/bin/app-data/log `claude-usage-tauri` -> `claude-conductor`
- lib crate `claude_usage_tauri_lib` -> `claude_conductor_lib`
- daemon bin/pipe/sock `cc-companion-daemon` -> `cc-conductor-daemon`
- MCP server + daemon-src-file `cc_companion`/`cc_companion_daemon` -> `cc_conductor`/`cc_conductor_daemon`
- bundle id `com.aiusage.taskbar.tauri` -> `com.sirbepy.claudeconductor`

Decision needed: rename hook matcher `aiusage-taskbar` (Joe unsure, "3.3")?
Resolved via: direct judgment (Explore confirmed it's not live identity).
Picked: KEEP `aiusage-taskbar` + `aiusage-hook`. Reason: live hook entries are matcher-less; `aiusage-taskbar` is only a LEGACY_MATCHER compat shim that strips OLD v1 entries on next launch, and `aiusage-hook.{ps1,sh}` are pinned global hook-script filenames referenced by ~/.claude/settings.json. Renaming breaks old-install cleanup / orphans global hooks for zero user-visible gain. Where: hooks/installer.rs, daemon/hooks_server. Revisit: no.

Decision needed: daemon internal name (Joe ambivalent, "cc-companion isn't horrible").
Resolved via: direct judgment toward stated consistency goal. Picked: cc-conductor-daemon (CC prefix retained). Revisit: no.

Decision needed: bundle identifier value.
Picked: com.sirbepy.claudeconductor (reverse-DNS, no hyphens for macOS cleanliness, matches publisher SirBepy). Revisit: no.

Done 2026-08-17: GitHub repo renamed to `SirBepy/claude_conductor` on Joe's go-ahead, and every in-code GitHub URL now points at the new slug. GitHub's 301 redirect keeps the old updater URL working for already-installed builds.

Still parked (manual/external): the on-disk project folder stays `claude_usage_in_taskbar`. It cannot be renamed from a session whose own working directory sits inside it, and `walker.rs` keeps it as a path fixture regardless.

RUN_LEDGER:
- inventory sweep (Explore) -> complete, drove the map above

## 2026-06-27 03:59 - /autopilot: todo 140 session-menu rework (merged top-right ⋮, draft handling)

GOAL (Joe): kill the double-⋮; one top-right context-aware menu (Variant B: General section + "This chat" section), remove the chat-pane-header ⋮ + changes button, Sort to Settings, When done submenu, sidebar rows reuse the same 4-submenu block. Drafts: same options, disable what's impossible with a hover-tooltip reason. Brainstormed + web-previewed with him first (C:\tmp\menu-preview.html). Deployed via /commit pushnbump.

Built via one sonnet implementation subagent (orchestrated). New shared module `chat-menu.ts` (`buildChatMenuBlock(ctx, closeMenu)`) feeds BOTH the top-right "This chat" section AND the sidebar row/draft menus. View-changes reaches the active session via a new `state.activeChatActions` seam set in active-session.ts. Files: chat-menu.ts (new), view-more-menu.ts (rewrite to Variant B), sidebar-ctx-menu.ts (delegates to the block), session-header.ts (more-btn + changes-btn removed), state.ts, active-session.ts, sessions.ts, sessions-helpers.ts (saveSort), template.ts, settings.ts, sessions.css. Deleted orphaned more-menu.ts.

Decision needed: the todo's old draft table marked Auto-accept / Change character / Hide enabled for drafts, but a draft has no session/process/pid/applied-character so those code paths need a sessionId.
Resolved via: direct judgment, aligning to Joe's explicit "disable if not possible, show why on hover". Picked: for drafts enable ONLY Open project in (path known) + Delete draft; disable the rest with specific reasons (Hide = "Not available until the chat starts", Move-to-terminal/View-changes/Copy-PID/Detach = "No active agent", Auto-accept/Change-character = "Available once the chat starts", New-chat-here = "Start a chat first"). Reason: enabling them would need new draft-config plumbing (new scope) - the honest read of "disable what isn't possible". Where: chat-menu.ts draft branch. Revisit: yes - if Joe wants pre-start character/auto-accept config on a draft, that's a follow-up (route the menu items to the draft composer).

Decision needed: Sort persistence when moving the control to Settings.
Resolved via: direct judgment. Picked: keep sort in its existing localStorage key (added saveSort), just render the select in Settings + a cc-sort-changed event the sessions view listens for to re-render live. Reason: avoids a backend Settings field + ts-rs regen for a purely-local UI pref. Where: settings.ts, sessions-helpers.ts, sessions.ts. Revisit: no.

Decision needed: View changes on a NON-active sidebar row (no live ChangesPanel).
Resolved via: direct judgment. Picked: disabled with reason "Open the chat to view changes" unless the row IS the active session. Reason: the panel only exists for the mounted session; selecting-then-toggling is racy. Where: sidebar-ctx-menu.ts. Revisit: no.

Cleanup deviation: left `setChangesBadge`/`onChangesClick` as documented no-op stubs on SessionHeader (still called by active-session.ts + pending-pane.ts). Removing them would churn 4 files + orphan the dedupeByPath import for zero behavioral gain right before a push. Minor code-health for a future /close pass. Also: the changes-COUNT badge is no longer surfaced (View changes item shows no count). Revisit: optional.

VERIFY: `pnpm tsc --noEmit` = zero new errors (only the 3 pre-existing: tool-views.ts:214 x2, vendor/tauri_kit/stack.ts:47). `pnpm build` green (✓ 10.31s). NOT live-verified: this is a desktop-webview UI change and the app can't be hosted headlessly here (supervised-run's job object blocks the daemon) - menu interaction QA is in BEPY_TODOS Visual QA.

## 2026-06-20 - /autopilot: per-chat token drain feature (ALL chunks done + deployed)

GOAL (Joe): see which running chat is "the vampire" draining his Max 5x limit, as a % of a 5h (and weekly) session. Brainstormed + specced with him first (cost-weighted drain, "% of a 5h session" ruler via calibration against the scraped utilization, statusbar chip + click-popover rundown, sortable drain column in the sidebar). Spec: docs/superpowers/specs/2026-06-20-per-chat-token-drain-design.md.

RUN_LEDGER (chunk -> outcome -> sha):
- Chunk 1 (backend cost engine + calibration): DONE + verified (13/13 unit tests pass: pricing ordering, hand-computed opus drain, deterministic per-message grouping incl. the tool_result/pre-amble edge cases that were the "bugs out" symptom, EWMA + floor + roundtrip). Files: tokens/drain.rs (new), tokens/quota.rs (new), tokens.rs + settings/paths.rs (wiring). -> committed in 1b50337 (BUNDLED by a concurrent autopilot's broad git-add, mislabeled "FIX: add missing autopilot field to Instance initializers in tests"; my 4 files are present + correct; did NOT un-bundle - dropping a concurrent agent's commit is a hard stop).

Decision needed: drain metric source - spec said total_cost_usd.
Resolved via: direct judgment (spec already named pricing as the fallback). Picked: compute lifetime drain as tokens x per-model pricing for ALL history. Reason: history transcripts don't store total_cost_usd (only live result lines do); and since chat-drain and the quota share the same pricing units, absolute pricing error cancels in the ratio - only per-model ratios matter. Where: tokens/drain.rs. Revisit: no.

- Chunk 2 (IPC): chat_drain + chat_drains + DrainBoard struct, ts-rs export. AppState fields used: current_usage: Mutex<Option<UsageSnapshot>>, cached_instances: Arc<Mutex<Vec<Instance>>>. Heavy parse on spawn_blocking; "active in window" = transcript mtime within 5h/7d (lifetime-as-windowed proxy, Joe accepted the approximation). cargo lib clean, export_types test pass, tsc clean. -> a8ff1b1
- Chunk 3 (statusbar drain chip + per-message rundown popover): opt-in via the chip picker (Session section, drop icon); color-graded teal/amber/red at 50/80% of 5h; body-appended popover mirroring the tool-tally popover. Handled MessageDrain.tokens being bigint (Number()). tsc clean, 22 statusbar tests pass. -> 5534183
- Chunk 4 (sort sidebar by token drain + inline % per row, the vampire-spotter): new "drain" SessionSort, debounced chat_drains fetch (only when that sort is active, never blocks render), heaviest-first. <select> lives in template.ts not sessions.ts. tsc clean, 29 sessions-helpers tests pass (added a drain-ordering case). -> 157ec99

FINAL VERIFY: full cumulative tsc clean (only the known vendor/tauri_kit stack.ts TS2532), vite build green (672 modules), backend lib clean. Resumed after the 5h limit reset; tree was quiet this pass (no concurrent collisions). DEPLOYED via /commit pushnbump. ai_todo 120 deleted (resolved). Visual QA (chip + sort look/feel) -> BEPY_TODOS, since a headless run can't screenshot.

How to USE it (opt-in, not on by default): enable the "drain" chip in a chat's statusline chip picker (Session section); and pick "Token drain" in the sessions sort dropdown. The % is a CALIBRATED estimate that self-corrects against the scraped 5h utilization (needs a few samples + real usage >5% util before the absolute number is tight); the RANKING is reliable immediately. Chunk 3's deterministic per-message grouping also fixes the old "per-message tokens sometimes don't show" bug.

## 2026-06-20 - /autopilot: voice mode (long-form dictation) brainstorm + spec

GOAL (Joe): self-hosted streaming speech-to-text for dictating chat messages on desktop AND (heavily) mobile. Hard rules he set before going AFK: NO auto-stop / no turn-detection / no talk-back ("I HATE when AIs assume I'm done"); talk uninterrupted for up to 10 min; live text like the Claude Code app; must be able to edit mid-dictation then RESUME voice (most apps wipe edits - the thing he hates); host a model on this PC; later "teach" it his vocabulary via corrections + a <voice-msg/> tag.

ASSUMED SCOPE: this run delivers the design + implementation plan only. Implementation NOT started - it needs a Python/CUDA env + an actual mic on Joe's box to verify, so building it AFK would ship unverifiable half-work. Plan 1 execution is gated on the host-PC setup (added to BEPY_TODOS Urgent). Spec: docs/superpowers/specs/2026-06-20-voice-mode-design.md (gitignored, per repo convention - all specs there are untracked).

Decisions I'd normally have asked, resolved myself (Joe said "this stuff, i dont mind not reading this"):

Decision needed: STT engine (he said "whispr flow model" - that's Wispr Flow, a closed commercial app, NOT self-hostable).
Resolved via: direct judgment. Picked: faster-whisper large-v3 on CUDA via whisper-streaming LocalAgreement-2. Reason: native hotword biasing + clean partial/final streaming = exactly the two things he asked for; 4070 SUPER runs it real-time. Where: spec Stack. Revisit: no (he approved Approach A explicitly before AFK).

Decision needed: edit-while-talking simultaneously, or only between bursts?
Resolved via: direct judgment. Picked: edit only between bursts (volatile tail owns the anchor while audio flows). Reason: avoids user-vs-partial caret-fighting; invisible in practice since he stops to fix things. Where: spec Non-obvious decisions. Revisit: yes-if-it-feels-wrong-in-use.

Decision needed: sidecar transport - localhost WS (daemon proxies) vs stdio child framing?
Resolved via: direct judgment. Picked: localhost WS sidecar on 127.0.0.1:27184, daemon is the WS client + authed /ws/transcribe proxy. Reason: natural for binary audio; the past inherited-listen-socket bug (port-27182 hostage) does NOT recur (sidecar owns its own socket, spawns no children). Where: spec Architecture. Revisit: no.

Decision needed: always-on engine vs lazy?
Resolved via: direct judgment. Picked: lazy-start on first connect + idle-shutdown after 5 min. Reason: don't pin ~2GB VRAM for an unused feature; cold start (~seconds) fine for an explicit action. Where: spec Sidecar supervision. Revisit: no.

Decision needed: the "teach it" / fine-tuning ask.
Resolved via: direct judgment. Picked: hotword vocab + correction-map post-process + auto-promotion; NO Whisper fine-tuning. <voice-msg/> becomes a <voice-input/> sentinel the renderer collapses to a mic chip (per the split-send-vs-display pattern) + tells the model to read dictated text charitably. Reason: ~90% of "learns my words" at ~1% of the cost. Where: spec Learning loop. Revisit: yes-if-accuracy-plateaus.

Grounded against real code: daemon stream_ws auth (?token=), lifecycle.rs spawn/supervise blueprint, util/process.rs hide_console_tokio, composer.ts highlight layer + buildBlocks sentinel path. Nothing committed (spec/plan/log all gitignored). NEXT: invoke writing-plans for Plan 1 (backend sidecar), then hand off - real progress resumes once the host-PC env exists.

## 2026-06-19 - /autopilot: phone parity bugs (hook popup / missing images / new-chat dead-end)

GOAL (Joe): make the remote phone view mirror the desktop. Three reported bugs: (1) "inject the hook" modal pops on the phone home screen; (2) chat shows missing images + icons; (3) new-chat project picker opens but selecting a project does NOT open the model modal - falls back to the chats view.

Testing surface: localhost:27183 (the daemon's remote server serves the SAME embedded dist bundle + HttpTransport the phone loads over tailscale - faithful repro without the tunnel). Iteration loop: pnpm build + reload (debug rust-embed reads dist/ from disk, no relaunch needed for frontend).

RUN_LEDGER (chunk -> outcome -> sha):
- Bug 1 FIXED (frontend, staged): maybeShowHookModal now returns early when isRemote(). Root cause: get_hook_registration_state throws RemoteUnavailableError on the phone -> api catch returns {registered:false,declined:false} -> modal shows. Added isTauri()/isRemote() helpers to transport.ts as the single source of truth. (boot.ts, transport.ts)
- Bug 4 partial FIX (staged, daemon + frontend): exposed read_attachment as a daemon RPC (registry.rs) + SAFE_METHODS + HttpTransport mapping. Root cause: in-chat pasted image attachments call read_attachment which threw on the phone -> caught -> rendered a ph-warning chip instead of the image. SAFE because read_attachment canonicalizes + rejects paths outside chat-attachments/ (NOT arbitrary read). read_image_file deliberately NOT exposed (reads arbitrary paths = RCE).
- VERIFIED so far: daemon cargo check clean; vite build clean; src/ tsc clean (only pre-existing vendor/tauri_kit stack.ts:47 error remains).

GATE: the app must be running (cargo tauri dev in a normal terminal - supervised-run's job object blocks the daemon's chat spawning, and I can't spawn the GUI from a non-interactive runner). Regenerated remote-access token (deleted stale remote-access.json + token.txt; daemon mints fresh on launch) so Playwright can auth.

LIVE-VERIFIED via Playwright against the standalone daemon on 127.0.0.1:27183 (I ran cc-companion-daemon.exe directly - it's headless, no GUI needed, reads real app-data from disk; this sidesteps the can't-spawn-the-GUI block entirely). All 3 bugs FIXED + confirmed:
- Bug 1: no hook modal on the phone home screen. CONFIRMED.
- Bug 3: project-picker -> model modal now OPENS (was a hard crash). Root cause: HttpTransport RESOLVES get_settings to null (doesn't throw), so the modal's try/catch didn't catch it and readPresets(null) threw on `.effortPresets`, aborting startNewSession back to the list. Fix: `?? {}` guard at the two get_settings call sites in model-effort-modal.ts. CONFIRMED (modal renders presets + sliders + Qhira portrait).
- Bug 4: was THREE distinct "missing images" gaps, all now render:
  (a) in-chat pasted attachments - read_attachment exposed as daemon RPC (verified end-to-end: returns image/png data; path-traversal still rejected with 500).
  (b) per-session character avatars in the sidebar + chat header - list_session_characters was app-only, so every row/header showed the "?" placeholder. Exposed it as a daemon RPC (returns the session_id->character_id map from the settings snapshot, no prune - read-only display). CONFIRMED: li-ming portrait now renders on session a75df948 in both sidebar + header.
  (c) Phosphor icons were NEVER actually broken (tool chips, status bar, composer all render) - the "missing icons" was the avatars in (b) reading as blank/placeholder.

FOLLOW-UPS (not fixed, not in the 3 bugs - logged for a later pass):
- The PWA service worker cache name `claude-companion-v1` is static across releases, so a phone can serve a STALE bundle after an app update until the SW cache is manually cleared (I hit this repeatedly during testing). Bump the cache name per release or add skipWaiting/clients.claim.
- Opening a read-only / external session opens a WS to /api/sessions/<id>/stream which 404s (session not in the live map) and retries forever with backoff - console-noisy + battery drain on the phone. Gate the WS to live sessions only, or have the daemon close it cleanly.
- Dashboard usage/token charts + news are still app-only on the phone (get_history/get_token_history/get_active_sessions/list_news degrade to empty) - known parked parity gap (ai_todo 105), not one of the 3 reported bugs.

## 2026-06-18 - /autopilot run: phone PWA - view characters/projects + start new chat + mobile nav

GOAL (Joe): "finish everything to do with a PWA on my phone that lets me control this app" - view characters, projects, start a new chat; plus mobile: show the sidemenu in chats + a Chats entry in the sidemenu.

RUN_LEDGER (chunk -> outcome -> sha):
- Backend: expose `list_characters` + `list_project_groups` as daemon RPC methods (read shared on-disk state via characters::list() + build_groups), added to SAFE_METHODS -> 755503e
- Frontend: map list_characters/list_project_groups/start_session in the HTTP transport switch + add a "Chats" sidemenu entry (data-view="sessions") -> 5d40acf
- Backend: expose 6 read-only DISPLAY methods so characters/projects RENDER on phone: character_asset_url, resolve_whitelist_characters, list_projects, project_last_activity_at, get_project_tech, get_project_icon (all in SAFE_METHODS) -> 5006e03
- Frontend: map those 6 display methods in the HTTP transport (camel->snake param normalization mirroring set_session_effort) -> 10b106d

WHAT NOW WORKS ON PHONE (build/tsc/unit-verified, NOT live-verified - that's the gate below):
- View Characters (list + their icons via character_asset_url)
- View Projects (list_project_groups + project avatars/tech logos)
- Start a NEW chat (project picker -> model/effort -> start_session; the whole flow now runs over HTTP, degrading gracefully where a method is still app-only)
- Reach everything from the phone via the new "Chats" sidemenu entry; the sessions-view burger already opens the sidemenu (phone never strips it - no chatswindow=1 param)

Decision needed: was it safe for autopilot to widen the remote SAFE_METHODS allowlist unattended?
Resolved via: direct judgment (the RCE endpoint already exists + you live-verified it in the 2026-06-15 run; ai_todo 103 explicitly anticipated "widen the allowlist as the client needs more methods")
Picked: added 8 methods, ALL READ-ONLY (list_characters, list_project_groups, character_asset_url, resolve_whitelist_characters, list_projects, project_last_activity_at, get_project_tech, get_project_icon). start_session was ALREADY server-side allowlisted - I only mapped it client-side, so the RCE surface did NOT grow. Reason: read-only data reads are strictly safer than the already-exposed start_session/send_message. Where: src-tauri/src/daemon/remote_server.rs SAFE_METHODS. Revisit: yes - please eyeball the allowlist diff during your security pass (it's the security boundary).

PARKED (untouched, still need YOU): ai_todo 104 (QR pairing / token minting - your security review), ai_todo 102 (phone+desktop converging on ONE live chat via claude's bridge protocol - a real project, and NOT needed for "start a new chat", which the daemon path already supports).

## 2026-06-17 - /autopilot run: 2 UI tweaks + autopilotable ai_todos

RUN_LEDGER (chunk -> outcome -> sha):
- UI: move "Open in VS Code" from sidebar row menu to chat header menu -> d426179
- UI: effort chip light-purple (was grey), ctx% green by default -> 971515f
- ai_todo 112 (chat-state color palette, Joe-decided): single-source --chat-state-* map, red now means closing ONLY, question=amber, busy=teal, done=green, remote=blue -> 7d45293. ai_todo deleted; Visual QA added.
- ai_todo 32 (when_done integration test): behavior-preserving effect-seam refactor (EngineDeps closures) + 2 executing tokio paused-clock tests (full phase progression fires terminal once; cancel short-circuits). Scoped test 16 passed. -> b8e7799. ai_todo deleted (fully verified, no live action).
- ai_todo 95 slice 1 (absorbed ai_todo 35): in-app read-only Shiki file viewer + read_text_file IPC (2MB cap); all file-row clicks (chat chips + tool-tally) re-pointed to it, "Open in VS Code" kept secondary. -> 731d0e6. ai_todo 95 updated (slices 2/3 remain); ai_todo 35 deleted; Visual QA added.

Decision needed: should ai_todo 81 (tauri_kit cleanup) auto-run?
Resolved via: direct judgment (Hard Stop - hard-to-reverse shared-lib blast radius)
Picked: PARKED after a read-only audit. Reason: the audit's "unused -> delete" verdict was scoped to claude_usage only; the settings/updater/window/meeting crates + ~14 frontend modules are exactly what the OTHER consumer (pomodoro-overlay, which pins this submodule) uses - its settings root.ts hardcodes Pomodoro categories. Deleting them unattended would break pomodoro. Where: ai_todo 81 (full findings + the meeting-fork decision baked in for the next pass).
Revisit: yes - needs the pomodoro repo open + your call on the meeting fork; then it's a real cleanup.

VERIFICATION: each code chunk passed its fast-check floor (pnpm tsc --noEmit clean except the known pre-existing vendor/tauri_kit/.../stack.ts(47,36) error; cargo build clean; scoped when_done test + tally vitest green). NOT live-verified (can't host the app/daemon here) - the visual bits (palette, chip colors, file viewer) are in BEPY_TODOS Visual QA for you. Did NOT push/deploy.

## 2026-06-16 - ai_todo 106: JSONL -> SQLite storage migration (5 slices, all committed)

Built the full SQLite migration after you decided the open forks (full multi-process now; defaults usage 90d / token 90d / skill forever). Done via 5 staged, cargo-check/tsc-green slices, each its own commit:
- Slice 1 (c6fbe72): storage/ module - schema/init, retention (RetentionPolicy/Dataset/prune_all), usage/token/skill stores, JSONL/JSON importers. rusqlite 0.40 bundled (safety-checked: canonical crate, no applicable advisories, bundles SQLite 3.51).
- Slice 2a (7a6285e): usage wired app-side; WAL + busy_timeout=5s enabled; AppState holds StorageManager; scheduler writes+prunes usage to DB; get_history reads DB; one-time history.jsonl import.
- Slice 2b (e350ed6): the MULTI-PROCESS half. Daemon opens its OWN connection (best-effort, warn-and-skip on failure); relay.rs writes token records, stop.rs writes skill events; app reads switch to DB; skill aggregation refactored load-vs-aggregate; token dedup + notify shape preserved; skill mark_session dedup kept file-based.
- Slice 3a (444aff3): IPC (get_storage_info / set_retention_policy / clear_dataset) + DatasetInfo/DatasetId types; RetentionPolicy compact string serde; Settings.retention persisted; prune now reads user policy across all 3 tables.
- Slice 3b (095796a): Settings -> Data section UI (3 cards + retention dropdowns + Clear-all + size footer). Cards built as innerHTML strings (avoids the prod lit-html repeated-<select> drop, per memory).

Spec deviation worth knowing: the spec assumed unix-seconds timestamps + a single writer, but the REAL data uses RFC3339 string timestamps (converted on insert) and token/skill are written by the DAEMON process - hence the multi-process WAL design you chose.

NOT verified live (I can't host the app/daemon here). The migration is one-shot + irreversible-ish (renames sources to .bak) and the cross-process WAL writes need a real run - full checklist in BEPY_TODOS Manual QA. Did NOT push/deploy: rebuild+relaunch + your QA first, then /commit pushnbump.

Also banked your other answers this session: 102 -> Path B (app speaks the bridge protocol), 112 -> closing=red/attention=amber, 95 -> full unified file screen (35 folded in), 45 rescoped (outbox EXISTS = held-messages; real bug is auto-flush-on-turn-complete not firing), 33 deprioritized, 87 approved (fix in server_supervisor repo). All recorded in their ai_todos. New ai_todo 116 = investigate why AUQ pickers intermittently don't render (relay wedge on port 27182). Deleted the wrong "AUQ never renders" memory.

## 2026-06-16 - Autopilot run: draft-header fix + mobile single-pane (ai_todo 115)

RUN_LEDGER (chunk -> outcome -> sha):
- Draft chat header portrait: SHIPPED. The draft pane built its SessionHeader with the bare `?` placeholder and never set the avatar, so the sidebar showed the picked character but the header didn't. Set the avatar from `config.characterId` at construction (mirroring the sidebar draft row's `characterIconUrl` path) + refresh from the assigned session character on draft->real upgrade (guarded so a not-yet-loaded char map can't clobber a user-picked portrait). tsc clean (my file; only the pre-existing vendor/tauri_kit err remains). Visual confirm parked to BEPY Visual QA. sha: 526bb9a
- ai_todo 115 (mobile sidemenu/sessions collapse): SHIPPED. Phone viewport showed the 260px list + chat cramped side-by-side. Now single-pane: list by default, chat on open, header back-arrow returns. tsc clean. sha: 2939f3d. ai_todo file deleted; live phone confirm parked to BEPY Visual QA.

Decision needed: how to toggle list-vs-chat on mobile. The sessions burger ALREADY opens the GLOBAL app nav (#sidemenu), so the ai_todo's hint to "reuse openSidemenu/closeSidemenu + #sidemenuBackdrop for the session list" would double-bind the burger.
Resolved via: direct judgment (reversible CSS; UX = your taste, didn't burn an iterate-it).
Picked: navigation-stack pattern (single-pane swap + back button), the standard mobile-messaging UX, instead of the overlay+backdrop the hint suggested. Meets every acceptance criterion (list OR chat, tap-to-open collapses list, desktop pixel-unchanged, dashboard sidemenu untouched). Mechanism: a `data-mobile-pane` attribute on `.view-sessions` that CSS only reads inside a `@media (max-width:768px)` block, so JS never references the breakpoint and desktop is byte-identical.
Where: src/views/sessions/{template,active-session,pending-flow,sessions}.ts + sessions.css
Revisit: yes if you'd rather have the slide-over-overlay look than the full-pane swap - it's a CSS-only swap to change.

- ai_todo 100 (AUQ/permission relay drops when AFK): SHIPPED. Root cause: both relay clients capped the request at 320s while the daemon holds prompts for 3600s, so an answer after 5.3 min hit the client timeout first and was dropped (the exact "error sending request for url .../permissions/request" you saw). Fixed BOTH paths - the MCP relay (mcp/server.rs http_post -> 3660s + connect_timeout) AND the AskUserQuestion PreToolUse curl hook (claude_config.rs --max-time 320 -> 3660 + --connect-timeout 10). cargo check clean. Backend change: needs rebuild+relaunch; live AFK confirm parked to BEPY Manual QA. sha: 95db1c1. ai_todo file deleted.

- ai_todo 93 (square portraits for Abathur + Qhira): SHIPPED (assets, out-of-repo). Both now have 128x128 opaque RGB square busts from HeroesToolChest/heroes-images instead of the hexagon fallback. Caveat: that repo carries NO heroselect_btn art for these two, so Abathur uses an in-game target-portrait face-crop and Qhira (codename nexushunter) a reward-base bust - the closest square opaque equivalents, verified RGB 128x128 but I can't eyeball them. Old hexagons backed up to C:\tmp\hex_icon_backup\. Parked to BEPY Visual QA with revert instructions. Needs an app relaunch / icon-cache refresh to display. ai_todo file deleted.

PARKED (hard stop): ai_todo 104 = remote cockpit Phase 2 (QR pairing / device registry / revoke / kill switch). This is the security boundary for an RCE-capable endpoint and needs YOUR review + Tailscale setup; autopilot will not stand it up unattended. Phase 1 (103) shipped, Phase 3/4 (105) resolved earlier; 104 is the only remaining mobile-feature phase and it's gated on you.

## 2026-06-15 - Autopilot run: ai_todos 99, 90, 85 (project logos prioritized by Joe)

RUN_LEDGER (chunk -> outcome -> sha) appended as each lands.
- ai_todo 99 (project tech-logo face): SHIPPED. Backend ipc/project_icons.rs (get_project_tech + get_project_icon), frontend devicon-via-unpkg + 3-tier lazy hydration on the no-avatar path, wired into projects list + project-detail header. cargo build + tsc + full vitest (411) green. Live visual confirm parked to BEPY Visual QA. sha: <pending commit>
- NOTE: the daemon permission relay (127.0.0.1:27182) intermittently errored during this run ("error sending request for url .../permissions/request") - this is exactly ai_todo 100. Retries succeeded. Flagging because it slowed the run and is worth fixing.
- COLLISION: a CONCURRENT autopilot agent also picked ai_todo 99 and committed it first (82b29d7, 17:41) into the SAME working tree. Since we share one tree, its file versions won on disk; my commit ba95f69 then only captured the docs/ledger + the ai_todo deletion. I re-ran the FULL floor on the committed (its) state: tsc clean (pre-existing vendor err only), cargo build green, vitest 411 passed. So 99 is coherent + verified; both commits stand. Did NOT revert its work (dropping a concurrent agent's commit is a hard stop).
- ai_todo 85 (question status lost): PARKED, not shipped. Both symptoms need live repro (runtime state I can't reproduce here). Falsified the obvious re-derivation theory; narrowed to concrete hypotheses with file:line in the ai_todo's new "Investigation" section. Shipping a speculative precedence change risks suppressing real busy (acceptance forbids), so I left groundwork instead of a guess.
- ai_todo 90 (held-messages e2e): PARKED, not shipped. Acceptance = a WDIO run that can't be done reliably here (tray app running + tauri-driver one-window limit). The held-messages controller is already unit-locked (15 cases incl. the 2 added in 656f58d), so the auto-send fix IS guarded; 90 adds DOM-wiring e2e. Ready-to-write plan + verified selectors appended to the ai_todo.

RUN SUMMARY: 99 (Joe's priority) DONE+verified. 85 + 90 parked with actionable writeups (both need the live app to finish/verify). Recommend ai_todo 100 next - hit its symptom repeatedly this run.

### 2026-06-15 - ai_todo 99 design decisions
Decision needed: how to render project tech LOGOS when this app standardizes on Phosphor (which has no brand/tech logos), per Joe's explicit "prioritize the project logos".
Resolved via: direct judgment (clear-correct; copies Joe's own server_supervisor approach, which the todo names as the source).
Picked: (1) Devicon icon font for tech logos, loaded from **unpkg CDN** (the same host already whitelisted for Phosphor in the CSP) - NOT an npm dependency, so no bundle change and no package-safety gate. (2) Frontend three-tier lazy fallback mirroring server_supervisor (real icon file -> tech devicon -> generic Phosphor `ph-folder`), hydrated only on the `Avatar::None` path so user-set emoji/image/character avatars are untouched. (3) Backend gets two read-only commands `get_project_icon` (base64 of a found icon.svg/logo.png/etc., reusing the existing `AttachmentData{mime,base64}` so no new ts-rs type) + `get_project_tech` (marker-file -> stack key), same priority order as server_supervisor (flutter>rust>python>go>deno>dotnet>node).
Reason: matches Joe's established pattern, keeps the project-list payload lean (icons fetched lazily per card, not embedded in list_project_groups), CSP already permits unpkg CSS+fonts and `img-src data:`.
Where: src-tauri/src/ipc/project_icons.rs (new), shared/projects.ts, projects list + project-detail header.
Revisit: no for the two named sites; secondary avatar sites (subview-header, session-detail, character-pick) left on the old "?" placeholder for none - noted as optional follow-up.

## 2026-06-15 - Deploy unblocked: release CI was red for 3 separate reasons (autopilot "fix until it builds")

Releasing the cockpit + close-leak work surfaced that the Tauri Release CI had been RED since before this work. Fixed all three, build now GREEN + published (v0.1.89, run 27546575533, all 4 platforms + publish success).

1. Submodule not pushed: parent pointed vendor/tauri_kit at commit ac831a2 (the About-page work) which was never pushed to its remote -> every build failed at checkout ("upload-pack: not our ref"). Fixed: `git -C vendor/tauri_kit push origin HEAD:main` (Joe authorized; shared-remote push of another agent's commit).
2. rust_embed E0599 on clean checkout: the prebuild step (cargo test --test export_types) compiles the crate BEFORE vite build creates dist/, so the `#[folder="../dist"]` embed had no `get`. Fixed in build.rs (creates a placeholder dist/index.html if missing; vite overwrites for the real binary) -> c7a59aa. Verified locally by deleting dist/ and reproducing the exact failure, which then compiled.
3. Version-tag skip: the failed 0.1.88 run had already created the tauri-v0.1.88 tag (tag job runs before build), so re-pushing at 0.1.88 skipped the build (check job gate = release only if tag absent). Bumped to 0.1.89 -> b14dc56 -> real build -> green.

Decision log:
- Auto-fixed the E0599 + re-pushed without asking (clear, mechanical, self-inflicted, traced to my pushed files; auto-fix one-shot marker used then cleared on success). The submodule push WAS confirmed with Joe first (shared remote + not my commit).
- Did NOT rewrite history to un-bundle the earlier concurrent-agent collision (commit 7999034) - dropping another agent's live work is a hard stop.

## 2026-06-15 (later) - Remote phone cockpit: real-UI build (autopilot, tasks #2-5)

Continuing the cockpit from the foundation below. Goal: a phone-testable real-UI chat served from the daemon. Orchestrator + sonnet implementer subagents.

RUN_LEDGER (chunk -> outcome -> sha):
- #1 HttpTransport spine (browser/phone half of the seam: call->/api/rpc + send endpoint, listen->per-session WS, getTransport branches on window.__TAURI__). 388 vitest, tsc clean. -> 515724f
- #2 load_history_page daemon RPC (reuses crate::chat::history locate_transcript+read_page; allowlisted in SAFE_METHODS; mapped in HttpTransport) so the phone can load past chat content (it had NO daemon transcript loader). cargo build + 389 vitest + tsc clean. -> swept into 7999034 (see collision note).
- #3 daemon broadcasts remote_echo-marked user_message on send; desktop event-store delivers marked (deduped vs local synthetic), drops unmarked replay. 4 jsdom tests, cargo+tsc+393 vitest. -> e69fa33
- #4a serve real SPA from daemon via rust_embed (replaces stub console) + SPA fallback (path-sanitized, mime-typed); /api stays authed. cargo+tsc+393 vitest. NOTE found pnpm build ALREADY broken on master (About page imports uninstalled @tauri-apps/plugin-opener); unblocked via vite externalize, proper fix parked -> ai_todo 111. -> 1a761ce
- #4b browser token gate (remote-gate.ts, no-op in webview) + boot degrade (HttpTransport get_settings->null, get_history->[] instead of throwing; boot.ts tolerates) so the served SPA boots in a plain browser. 403 vitest, tsc clean. -> 84c075e
- #5a serve-side done: installable PWA (manifest + icons + minimal network-first SW, browser-only registration) + HttpTransport polls list_instances every ~3.5s for the global instances-changed channel (no global WS exists). 4 poll tests. -> 5fd52f9

FINAL VERIFY (all green on the final tree): cargo build clean (1 pre-existing lifecycle.rs unused_imports warning); pnpm tsc --noEmit = only the 2 pre-existing vendor/tauri_kit errors; pnpm vitest run = 407 passed / 19 skipped; pnpm build succeeds + embeds dist.

STILL PARKED to ai_todo 105 (need a LIVE phone to validate, error-prone unattended): (a) live permission/AUQ prompts on the phone (poll list_pending_prompts + surface via the must-deliver path; lossy-broadcast nuance); (b) full mobile degrade pass - image-block send (text-only today), new-session start_session orchestration on the phone (degrades now), usage/token dashboards (app-side only); (c) settings parity (daemon read-only settings getter so the phone gets real models/presets - currently get_settings returns null -> defaults); (d) optional: replace the instances poll with a real global WS.

LIVE PHONE TEST is the gate - see BEPY_TODOS. NOT pushed (local master only); deploy is your call via /commit pushnbump.

Extra crates added (safety-checked): rust-embed "8" (past the 2021 traversal fix), mime_guess "2" (ubiquitous pure crate). Pre-existing bug found + parked: pnpm build was ALREADY broken on master (About page imports uninstalled @tauri-apps/plugin-opener) -> unblocked via a vite externalize stopgap, proper fix in ai_todo 111.

COLLISION NOTE: a CONCURRENT autopilot agent (working sessions/draft-rows/character-avatar) ran a broad `git add` and bundled my staged chunk-#2 files (registry.rs, remote_server.rs, transport.ts, transport-http.test.mjs) into ITS commit 7999034 ("FEAT: show character avatar on draft rows"). Verified all 4 files are present + correct in that commit. Did NOT soft-reset/rewrite to un-bundle (would drop the other agent's live work = hard stop). Cosmetic only: code is correct, committed, history is just mislabeled. Going forward I commit each chunk as fast as possible after verify to shrink the collision window.

Decision log:
- 2026-06-15 - Phone-sent message must show on BOTH phone and PC (Joe's "PC doesn't see it" bug). Root cause: claude -p stream-json does NOT echo user input, so the only user bubble is the desktop's LOCAL pushSynthetic; a phone send has no synthetic anywhere. FIX (direct judgment, no iterate-it - design is determined by the dedup mechanics): the DAEMON broadcasts a MARKED user_message echo on send_message; the desktop event-store delivers MARKED user_messages (routing through deliver(), whose content-dedup cancels the desktop's own synthetic) but still DROPS unmarked ones (claude --resume replay = old history). Self-correcting: own-send = synthetic+echo deduped->once; phone-send on PC = echo delivered->once; phone-send on phone = echo via WS->once; resume replay = dropped. Reversible (schema field + one event-store branch). Where: types/chat.rs (UserMessage marker), daemon lifecycle::send_message, src/shared/chat/event-store.ts:343.

## 2026-06-15 - Remote phone cockpit: foundation built, remote phases parked (autopilot)

Task: build "phone as full second cockpit" for in-app chats. Brainstormed + converged with you first: full mobile control (b); ONE shared frontend codebase with a swappable transport seam; reuse logic via daemon chat-core fns shared by Tauri commands + a new HTTP server; transport = Tailscale + per-request token auth + QR provisioning; dedicated tailnet-bound authed server separate from the localhost hooks server.

What I did vs deliberately did NOT do: this is a multi-session, SECURITY-CRITICAL build (the endpoint pipe-drives claude = RCE if mis-secured) and depends on your Tailscale setup. So autopilot shipped only the SAFE foundation and parked everything that exposes a remote surface (Hard Stop: security blast radius + needs your review + your manual Tailscale step).

RUN_LEDGER (chunk -> outcome -> sha):
- Design spec written -> docs/superpowers/specs/2026-06-15-remote-phone-cockpit-design.md (gitignored, local reference)
- Phase 0a transport seam: new src/shared/transport.ts (Transport iface: call + listen, TauriTransport, getTransport()); ipc.ts invoke delegates to it; event-store.ts + slash.ts route listeners through getTransport().listen instead of window.__TAURI__ -> tsc clean, 376 vitest pass, behavior-preserving (TauriTransport is the only impl, desktop identical) -> 864b10d

Decision log:
- 2026-06-15 - Seam shape: ipc.ts stays the request/response wrapper (invoke delegates to transport.call); the 2 streaming consumers call getTransport().listen directly. Reason: tests vi.mock ipc.ts wholesale, so routing streaming through an ipc re-export broke 5 test files; calling transport directly keeps the existing window.__TAURI__ mocks valid with zero test churn. Direct judgment, reversible.
- 2026-06-15 - Deferred Phase 0b (daemon chat-core extraction) to bundle with Phase 1 (ai_todo 103). Reason: extracting core fns with no second caller yet is speculative and only pays off alongside the HTTP server; doing it now also risks merge-thrash with concurrent autopilots on master. Direct judgment.
- Lucky break logged: streaming needs no new engine - the daemon already has a per-session broadcast a WS can subscribe to.

Parked (NOT built - security/dependency hard stops):
- ai_todo 103: Phase 1 daemon chat-core extraction + tailnet-bound authed HTTP/WS server (RCE-critical, needs your review + Tailscale).
- ai_todo 104: Phase 2 QR pairing + device registry + revoke + kill switch.
- ai_todo 105: Phase 3+4 HttpTransport + PWA shell + mobile parity/degrade pass.
- BEPY_TODOS Urgent: install Tailscale on PC + phone (+ MagicDNS/HTTPS certs) - blocks 103-105.

NOT pushed (local master only). Next: do the Tailscale setup, then tell me to build ai_todo 103 with you reviewing the security boundary.

## 2026-06-14 20:35 - Remote-control for in-app chats: HARD STOP, parked (autopilot)

Decision needed: you said remote-control is default-on yet no chat becomes remote-controllable, "it worked before the daemon epic, just make it work."
Resolved via: live investigation (claude --help + 2 controlled spawns + on-disk session files + process cmdlines). NOT guessed - this is a real architecture fork, parked per autopilot Hard Stops.
Picked: PARK with full diagnosis + options doc (.for_bepy/ai_todos/102). Did NOT revert the daemon epic or remove the flag while you're AFK.
Reason: it is a hard Claude-CLI constraint, not a bug. PROOF:
  - `claude --help`: `--remote-control` = "Start an INTERACTIVE session"; `--input-format`/`--output-format`/`--include-partial-messages` "only work with --print".
  - Spawning `claude --output-format=stream-json` (no -p) errors "When using --print, --output-format=stream-json requires --verbose" -> stream-json output FORCES print mode; print mode never opens a bridge.
  - On disk: app chats' `~/.claude/sessions/<pid>.json` = `entrypoint:"sdk-cli"`, NO bridgeSessionId. Only interactive `entrypoint:"cli"` sessions (the channel/Plan-C spawn, e.g. your Obsidian one) get a bridgeSessionId. A fresh app chat (pid 35028) had `--remote-control` ON ITS CMDLINE yet no bridge.
  - "Worked before the daemon epic" = pre-daemon chats were interactive --remote-control (real bridge). The daemon switched to print-mode stream-json for stdin turn-driving + partial streaming; the bridge was the casualty. The two are mutually exclusive in ONE claude process.
The fork (you choose, see ai_todo 102): A) revert chats to interactive --remote-control (loses daemon stdin-driving/cancel/partial-stream/held-msgs); B) app speaks the remote-control bridge wire protocol so app+phone share one interactive session (keeps the daemon epic, but a real project); C) dual-process (conflict-prone, not recommended); D) accept it + remove the no-op flag + document phone-control = channels/automation path only.
My recommendation: if "make it work" means phone-controllable chats, B is the only path that keeps the daemon epic - but it is a build, not a fix. D is the honest stopgap.
Where: daemon/claude_config.rs::base_claude_args (the dead flag), channels/spawn.rs (the working interactive path), hooks_server/lifecycle.rs (is_remote wiring).
Cleanup: 2 short-lived haiku test sessions spawned in C:\tmp during diagnosis; both exited, no orphans (verified). Memory project_remote_chat_flag corrected (was "UNTESTED" -> now "TESTED, no-op").
Revisit: yes - needs your architecture call before any code lands.

## 2026-06-13 13:11 - Held messages while Claude is busy (autopilot)

RUN_LEDGER (chunk -> outcome -> sha):
- New HeldMessages controller + composer staging hooks + working-bar chip/dropdown + completion auto-flush hook + 12 unit tests -> tsc + 346 vitest + vite build all green -> 804a973

Decision needed: several design/UX calls I'd normally ask about. We'd already brainstormed the shape with you (inline chip on the working bar, full-width floating dropdown, editable rows, plain "Send now") before you said "/autopilot it", so those were settled. The autopilot-resolved ones:
- Resolved via direct judgment (no iterate-it spent):
  - "Chip outlives the working bar" problem: the working bar is `[hidden]` when not busy, but a held set can survive a turn (auto-flush deferred while you type). Made the bar show when `busy OR held-items-exist`, dropping the pulse-dot/italic when it's only hosting the chip. Reversible CSS/JS call.
  - Auto-flush scope = the ACTIVE session only. If you queue on chat A, switch to B, and A finishes, A's queue does NOT auto-fire (no mounted composer to bind the send); it waits until you return to A. Per-session held set still persists. Picked this over cross-session send plumbing to keep one send-binding. Where: sidebar.ts onCompletion + active-session.ts attach.
  - Bundle join = blank line (`\n\n`) between messages, matching the spec.
- ASSUMED SCOPE (revisit): staging wired ONLY on the established-session pane (active-session.ts). The new-session first-message / pending-start flow (pending-pane.ts) keeps its existing send path - its started/placeholder/realId logic is fragile and queuing during the very first turn is an edge case. The shared `.session-thinking` markup + updateThinkingBar change apply to both panes, but pending never stages. Revisit: yes if you want to queue during a brand-new chat's first turn.

NO push: committed to master locally only. Deploy is your call via /commit pushnbump.
NO e2e: the flow needs a live busy session (daemon + real turn). Unit-tested hard instead (bundling, all 4 flush triggers, defer-while-typing, edit-to-remove, per-session isolation). Live look + flow -> BEPY_TODOS Visual QA.
Revisit: yes (pending-pane staging + a wdio synthetic-busy-seam e2e are the two open follow-ups).

## 2026-06-13 - Auto-assign HotS heroes to every project (autopilot)

RUN_LEDGER (chunk -> outcome -> sha):
- Allocator + auto-assign-on-create (both upsert paths) + one-time startup backfill migration + 10 unit tests -> cargo build + scoped cargo test (10 assign, 14 store) + tsc all green -> 76aeee9

Decisions / notes:
- You picked the three forks before /autopilot: HotS-only pool, re-roll EVERYTHING to HotS (overwrites the old acolyte/alarak manual picks - both re-pickable in the picker UI anytime), first-letter -> alphabetical-fallback matching.
- Matching is alphabetical-first within a letter, so claude_usage -> cassia (not chromie), server_supervisor -> samuro, ObsidianVault -> orphea. Deterministic.
- Backfill guard stored in `settings.extra["characterBackfillVersion"]` (=1), NOT a typed Settings field - deliberately avoids a ts-rs regen / ipc.generated.ts churn since the frontend never reads it. Runs once on next app launch; defers (doesn't burn the version) if no HotS characters are on disk yet.
- Auto-assign lives in `settings::store::upsert_project_*` (the shared chokepoint for app + daemon creation paths). Best-effort: empty pool -> avatar stays None, healed by backfill/picker.
- KNOWN LIMITATION (cosmetic, not fixed): app and daemon both persist settings, so a brand-new project created daemon-side vs app-side could momentarily pick different heroes before they reconcile. Backfill is deterministic; steady-state icons render from the app's view. Not worth solving the multi-process settings-authority question for a cosmetic feature.
- PHASE 3 PARKED -> ai_todo 88: showing the hero icon next to each chat in the Sessions sidebar. Deferred because another AI was reworking the Sessions screen in parallel (/local-session-chat) - landing it now would merge-thrash. Data is all in place; it's a frontend-only follow-up.

## 2026-06-10 - Remote-chat flag + configurable new-session modal

RUN_LEDGER (chunk -> outcome -> sha):
- Rust: per-chat `remote` flag threaded -> claude --remote-control -> cargo build green -> d56b254
- Frontend: More-options disclosure (Auto-allow + Remote checkboxes), settings-configurable defaults, data-driven editable model list -> tsc + 261 vitest green -> 70546b5

Decisions / notes:
- Built A (remote flag), B (More-options disclosure), C (settings defaults), D1 (data-driven model list from settings.models, editable in Session presets). DEFERRED D2 (auto-query /v1/models at boot) to ai_todo 40 per your steer - it's the uncertain bit (OAuth token may not be accepted by the API-key-authed /v1/models endpoint).
- Defaults: both checkboxes default ON; sourced from settings.defaultAutoAllow / settings.defaultRemoteControl (absent = on). Settings keys added: `models`, `defaultAutoAllow`, `defaultRemoteControl`.
- Resume/respawn path passes remote=false (never registers a fresh bridge -> no duplicate Claude desktop sidebar entries, matches the existing channel rule).
- Model validation loosened (readPresets/readLastChoice accept any non-empty model string) so user-defined models survive; effort stays strict.
- UNVERIFIED / LOAD-BEARING: `--remote-control` + `--input-format=stream-json` on one chat process is the untested Phase-5b seam. Threaded as asked, but whether it actually works (daemon stdin vs phone bridge both driving) needs your live test - flagged in BEPY_TODOS. If it conflicts, we rethink.

## 2026-06-10 - Tool-call activity surfacing (autopilot run)

RUN_LEDGER (chunk -> outcome -> sha):
- Doubled-attachment-message dedup fix -> green (vitest) -> b256448
- Compact tool rows + per-chat tool tally + live activity label -> green -> 8bcf1d6
- Subagent rows = "starting subagent" + 100-char target cap -> green -> 27fe9f6
- Scroll: only auto-scroll when already at bottom -> green (jsdom test) -> 177d215
- Rust open_in_editor + read_image_file IPC -> cargo build green -> 98ca6af
- ccstatusline row + Files|Media popover -> (in progress)

Judgment calls made without asking (all reversible):
- Agent/Task tool rows show the literal "starting subagent" (NOT the short description), per your explicit ask. One-line revert in tool-meta.ts toolSummary if you'd rather see the description.
- 100-char cap on ALL tool-row targets (Bash descriptions, Grep patterns, filenames).
- Bash/PowerShell ARE counted in both the transcript rows and the ccstatusline tally; a toggle to hide them from the statusline is filed as an ai_todo (not built).
- Tool rows use native <details>/<summary> for collapse (no JS expand-state map): survives streaming + pagination because these non-streaming message elements aren't rebuilt.
- read_attachment is sandboxed to the chat-attachments dir, so added read_image_file for arbitrary image paths (mirrors it minus the sandbox). open_in_editor opens VS Code (cmd /C code, CREATE_NO_WINDOW) with an OS-default-open fallback. No capabilities entry needed (confirmed: existing custom commands aren't listed there either).

Filed as ai_todos (not built this run):
- In-app file/image viewer to replace the external VS Code open (your "handle it all in this app" later).
- AskUserQuestion picker silently dropped your answers this session (you answered, I received "dismissed").
- Optional toggle to hide Bash from the ccstatusline tally.

## 2026-06-06 - Autopilot: Re-source 1136 guillotine-cropped clips (full-length, no crop)

Old "cut every clip to 2.0s" trim chopped 1136 voice lines mid-word. This run replaced them IN PLACE with FULL-length originals (same filename so character.json slots stay valid), per the corrected length rules. Character data lives OUTSIDE the git repo - only these .for_bepy bookkeeping files were committed (raw git, no /commit, per your instruction).

**RESULT: 1054 / 1136 re-sourced full-length (92.8%). 113 of those are 5-10s (pending your ear). 82 unresolved (left as the old crop + logged).**
Oracle = mtime+duration scan of every dest file (`C:\tmp\final_scan.py`): a fixed file carries today's mtime; an unfixed one keeps the 2026-06-05 build mtime and the uniform 2.0s/192078-byte crop.

Per-game (fixed / pending5-10 / unresolved):
- heroes-of-the-storm: 876 / 110 / 7
- sims: 111 / 0 / 0
- warcraft-3-frozen-throne: 17 / 0 / 0
- spongebob: 10 / 1 / 0
- family-guy: 18 / 1 / 43
- simpsons: 10 / 1 / 28
- army-men-rts: 12 / 0 / 4

### RUN LEDGER (chunk -> outcome)
- DONE HotS tier1 (48 chars): deterministic match - stored `<char>-<token>-<n>.ogg` <- jamiephan `_/voicelines/<Codename>Base_<Action><nn>.ogg` keyed on (action-token, index) from the repo git-tree; raw-download full ogg, verify vorbis + duration. 468 full + retries.
- DONE HotS codename-alias (13 chars): cassia=Amazon, johanna=Crusader, xul=Necromancer, kharazim=Monk, li-ming=Wizard, lt-morales=Medic, lunara=Dryad, mei=MeiOW, qhira=NexusHunter, the-lost-vikings=LostVikings(+Baleog/Erik/Olaf), anub-arak=Anubarak, the-butcher=Butcher, deckard-cain=Deckard. Same matcher.
- DONE HotS fandom (27 chars): heroesofthestorm.fandom allimages API, same (token,index) parser on `<Codename>Hero_<Action><nn>.ogg`. Prefix discovery: sonya=Barbarian, valla=DemonHunter, nazeebo=WitchDoctor, etc=ETC, li-li=LiLi. arthas only on heroesofthestorm-archive.fandom.com. uther's clips came from `.mp3` files (token `pissed00-mp`) - special-cased + transcoded mp3->ogg.
- DONE WC3 (subagent): Ladik MPQ Editor console + `Warcraft III.txt` listfile on local war3.mpq; arthas = TFT Death Knight (`DeathKnight*.wav`, NOT HeroDeathKnight). 17/17.
- DONE sims (subagent): archive.org `sims-1-sfx-library` Voice.zip = 1662 Maxis takes named by exact event token (VOX_BRAGGEE_ADMIREF3 etc.); gender code F/M/K; Goths reuse adult F/M. 111/111, all <5s (proves the 2s cap was pure damage).
- DONE spongebob (subagent): archive.org `SpongebobSounds` + soundfxcenter. 10/10.
- DONE army-men (subagent): carved 3DO proprietary NORK `.x` archives from archive.org `army-men-rts_202106`. 12 SFX recovered; 4 hero unit-voice lines genuinely ship NO audio in the PC release.
- DONE simpsons + family-guy (subagents): bulk soundboards (thesoundarchive/frogstar; realmofdarkness for FG). LOW yield - most cropped names are character-creator action labels or DVD-only lines with no exact-phrase source.
  - CAUGHT BY ORACLE: both subagents wrote to `characters/<game>/<char>/<file>` MISSING the `sounds/` subdir, then reported success. Their full-length writes were misplaced one level up; I moved all 28 into the correct `sounds/` dirs. (Lesson: subagent self-reported "replaced" is not trustworthy - the mtime oracle is.)

### Judgment calls (autopilot auto-resolved; revisit if you disagree)
- 5-10s clips: REPLACED in place with the full line (better than a 2s mid-word chop) AND logged for approval, rather than leaving the crop. The slot already referenced the file; a real 5-10s line beats a broken 2s one, and you can swap any that feel too long. (113 clips.)
- When a hero's exact original index was missing from a source, used a DISTINCT same-action clip (substitute) rather than leaving cropped - same slot intent, no dup within the action.
- family-guy subagent offered ~6-8 MORE replacements via LOOSE phrase matching (hilarious->"Clever", gorgeous->"Pretty"). DECLINED - shipping a semantically-wrong line is worse than a known crop you can spot. Say the word and Claude will pull them.
- 7 HotS `laugh` clips: no laugh VO exists in jamiephan OR fandom hero audio (they came from some other origin in the first build). Left cropped. They are pool clips, not slot-assigned, so low impact.

### 5-10s clips pending approval
113 clips re-sourced FULL-length but in the 5-10s band - need your ear (a chime this long may feel long). Full path list: `.for_bepy/resource_pending_5to10s.txt` (HotS 110, spongebob 1, simpsons 1, family-guy 1). To swap any: tell Claude "find a shorter <char> <action> line".

### Unresolved (left as old 2.0s crop, NOT deleted)
82 clips - full list: `.for_bepy/resource_unresolved.txt`. Breakdown: family-guy 43 (Stewie DVD-only lines + empty Brian board + action-label slugs), simpsons 28 (`bart-clip-N`/`lisa-line-1` non-descriptive names + Lisa/Marge sources down), HotS 7 (`laugh`), army-men 4 (hero unit VO absent from PC release). These need manual/per-phrase sourcing or a looser-match pass.

---

## 2026-06-06 - Autopilot: ai_todo 30 (context-left v2, single source of truth)
Daemon-owned context_status = the one place the context % is computed. Consumers: app chip, /context-left skill, mobile (via skill reply through the remote-control bridge - daemon never reaches the phone). Fixes the "100% context" bug (root: frontend window defaults 200K when model unresolved). No definitive Opus 200K/1M signal exists (investigated) -> heuristic + stateless sticky "any turn occupancy >200K proves >=1M" correction + a confidence flag. Skill-pull, NOT a Stop hook (Joe superseded his own earlier pick). Autopilot self-regulates: ~50% used slow, ~60% used hard-stop + dump todos.
### v2 RUN LEDGER
- DONE C1 daemon context_status core + /context endpoint + IPC command + 14 executing tests -> c8d01c6, cargo build clean
- DONE C2 chip repoint (reads daemon value, ~/(estimated) on heuristic, fallback to old calc) + 6 tests -> 75c9797, tsc clean, vitest 200 pass
- DONE C3 /context-left skill prefers daemon endpoint, self-compute fallback [global ~/.claude, no repo commit] - verified fallback path live
- DONE C4 autopilot self-regulation: SLOW_AT=50% used, HARD_STOP_AT=60% used [global ~/.claude, no repo commit]
- DONE C5 final tsc clean; ai_todo 30 closed -> a3abf39; BEPY_TODO added for relaunch verify
- NOTE: a concurrent session committed an unrelated vorbis fix (9ae8eab) into the tree mid-run; I staged by name throughout so nothing clobbered. History clean.


## 2026-06-06 - Autopilot: resolve ai_todo 25 (pipe frame-size warning)
Root cause = (B) harmless transition artifact: an old pre-frame-protocol app binary writes unframed JSON to the length-prefixed pipe during an update; every CURRENT writer uses write_frame, so no live bug. Remedy: downgraded ONLY the FrameError::TooLarge case warn->debug + comment (real errors stay warn), added GetNamedPipeClientProcessId PID logging for future correlation. cargo build clean. -> 788474e. Live-verify (warn gone from daemon.log) handed to Joe via BEPY_TODO (01cbd30). ai_todo 25 deleted.
ai_todo 30 (context-left v2) intentionally NOT touched - deferred by Joe earlier this session.



## 2026-06-05 - Autopilot: Cartoon character bundles (ai_todo 26)
Building 14 chars across 3 games via /character-creator GAME mode (one batch per game).
Output: %APPDATA%\claude-usage-tauri\characters\<game>\<char>\ (OUTSIDE git repo).
- spongebob (SpongeBob SquarePants): spongebob, patrick, squidward
- family-guy: stewie, peter, brian, quagmire, cleveland, meg
- simpsons (The Simpsons): homer, marge, bart, lisa, abe
Sources: icons = Wikipedia infobox / Fandom character pages; audio = archive.org soundboards/voice rips.
Clip rules: discard >5s, trim kept clips <=2s (ffmpeg available). Keep all clips in each char's pool.
Slot picks auto-assigned by filename-keyword classifier (autopilot suppresses per-slot AskUserQuestion).
Parked chars (icon/audio unsourceable unattended) logged below under PARKED.

### Cartoons RUN LEDGER
- DONE 3 parallel build subagents (one per game). 13/14 built first pass; lisa initially below 3-slot floor.
- DONE lisa audio retry (archive.org/soundfxcenter failed - SWF was AS3-streamed, soundfxcenter TLS-down; yt-dlp last-resort succeeded) -> lisa now 6 slots.
- DONE independent loader-mirror validation (C:\tmp\validate_cartoons.py): mirrors src-tauri characters/loader.rs (id==dir, icon exists+64x64, every slot file exists). Result: 17/17 ok, 0 fail (14 chars + 3 _shared bundles).
- RESULT: 14/14 chars BUILT, 0 PARKED.
  - spongebob: spongebob(6), patrick(3), squidward(3). audio=archive.org SpongebobSounds + soundfxcenter/memesoundeffects. Patrick pool thin (2 clips).
  - family-guy: stewie(6), peter(3), brian(3), quagmire(3), cleveland(3), meg(3). audio=archive.org 03-interview-3-stewie + soundfxcenter. peter/brian pools thin (3 clips).
  - simpsons: homer(6), bart(4), marge(4), lisa(6), abe(3). audio=archive.org soundboard.-7z + SWF-extracted (177105_bartsb_swf, old-abe-simpson-soundboard.fla) + soundfxcenter + yt-dlp (lisa only).
- Each char's sounds/ is a POOL (all kept clips, trimmed <=2s, >5s discarded) for UI remap; slots point at the best subset. game.json + _shared bundle written per game.
- THIN pools (load fine, fall back to global default on empty slots; remap-worthy if more audio surfaces): patrick, peter, brian, abe.
- ai_todo 26 deleted (all 3 games done). Character data lives OUTSIDE the git repo (no commit needed for it).


## 2026-06-05 17:00 - Autopilot: Heroes of the Storm full roster (ai_todo 27)
Building ALL ~90 HotS heroes as character bundles via /character-creator GAME mode.
Output: %APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\ (OUTSIDE git repo).
Sources (recon-verified): icons = HeroesToolChest/heroes-images draft portraits (all 90);
audio tier1 = jamiephan/_ per-hero .ogg (65 folders); audio tier2 = Fandom allimages API (~29 gap heroes).
Slot picks auto-assigned by filename-keyword classifier (autopilot suppresses the per-slot AskUserQuestion).
Parked heroes (icon or audio unsourceable unattended) logged below under PARKED.

### HotS RUN LEDGER
- DONE recon: subagent verified sources (icons HeroesToolChest/heroes-images draft portraits = all 90; audio jamiephan/_ = 61 heroes; Fandom allimages API = gap heroes). Installed ffmpeg via scoop.
- DONE icons: all 90 heroes -> 64x64 icon.png from draft portraits. 0 fail.
- DONE audio tier1 (jamiephan/_ .ogg, 61 heroes) -> 894 clips, all 61 filled.
- DONE audio tier2 (Fandom allimages API, 28 heroes incl. Illidan/Abathur/ETC/Diablo) -> 371 clips. Arthas sourced from heroesofthestorm-archive.fandom.com (main wiki had announcer-only).
- DONE character.json for all 90 (game-grouped layout, schema matches src-tauri characters/loader.rs + mod.rs).
- DONE _shared bundle (shared:true, empty slots, HotS logo icon) + game.json.
- VERIFIED: 90/90 pass loader-mirror validation (id==dir, icon exists, every slot file exists). Audio spot-check: all decode, durations capped 2.0s, icons 64x64 RGBA, 0 corrupt. Total 26MB.

Slot classifier (autopilot auto-assigned, replacing the skill's per-slot AskUserQuestion):
Pissed->annoyed, IntroQuestion/What->question_asked, IntroBoast/IntroRespond->ready,
AI_GoodJob/Celebrate->work_finished, Yes/Attack/Ack->select, VOX_GetHitLarge->death
(HotS heroes have no dedicated death VO, so death = the "big hit" cry; tolerated-empty for 6 heroes).
Announcer-pack files (HeroKill/GameStart/Countdown/etc.) filtered out of tier2.
Every downloaded clip kept in each hero's sounds/ pool (1265 files) for UI remapping, not just the slotted subset.

### PARKED (unsourceable unattended)
- sgt-hammer AUDIO: no hero voice files found on heroesofthestorm.fandom.com, the archive wiki, or wiki.gg (tried SgtHammer/Hammer/Sgt prefixes; wiki.gg 403s). Icon IS present, so she loads and falls back to the global default sound. To add audio manually: drop trimmed .ogg/.wav into %APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\sgt-hammer\sounds\ and point slots in that folder's character.json at them.
- THIN (few auto-slotted lines, but each has a pool of extra clips on disk to remap via the UI): murky (2 clips - inherently murloc gurgles, only 2 on wiki), gall (passenger head - only "Yes" matched standard tokens; Laugh/Kill/No clips are in his pool), arthas (3 slots - archive wiki lacked work_finished/select tokens), nazeebo (3 slots).

---

Autopilot run: implement ai_todos 28 (shutdown-when-done) + 29 (sleep-when-done) as ONE unified protocol. Started 2026-06-05 14:10.

This file = autopilot decision log + RUN_LEDGER. It is intentionally left UNTRACKED (not git-added). Skim it to see what I decided while you were away.

---

## 2026-06-05 14:10 - Protocol engine location (app main process vs daemon)
Decision needed: Where does the "watch all sessions -> close -> sleep/shutdown" engine live?
Resolved via: direct judgment (strongly indicated, not a coin-flip; did not spend an iterate-it escalation)
Picked: Tauri main process (AppState + a tokio task), NOT the daemon, NOT a webview.
Reason: must persist across chat-window open/close, owns the OS power action (app-side), and drives UI via window events; daemon staying alive is irrelevant since the power action is for the GUI host. App already mirrors instances + has daemon_client for the RPCs it needs.
Where: src-tauri/src/ (new protocol module + system_control)
Revisit: no

## 2026-06-05 14:10 - Move view-level controls into new overflow menu
Decision needed: Joe wants filter/history/new-chat moved into a new top-right "more options" menu; a subagent advised against it (said they're view-scoped).
Resolved via: direct judgment (Joe's explicit instruction + the new menu is itself view-level, so scope is coherent)
Picked: Build the new "more options" overflow menu in the VIEW header (views/sessions/template.ts), move the sort/filter dropdown + history + new-chat buttons into it, add Sleep/Shutdown-when-done triggers there too. Per-session ⋮ menu stays as-is.
Reason: protocol is global (all sessions); the moved controls are also global/view-level, so they belong together in a view-level menu. Subagent's "breaks scope" worry is unfounded since the new menu is not per-session.
Where: src/views/sessions/template.ts, sessions.ts, sessions.css
Revisit: no

## 2026-06-05 14:10 - Countdown semantics
Decision needed: what is the "cancellable countdown"?
Resolved via: direct judgment (matches todo-28 "cancellable countdown so Joe can abort")
Picked: a final ~30s grace countdown AFTER all sessions are closed and BEFORE the sleep/shutdown fires; cancellable from the menu UI. While armed-but-still-waiting, show a steady "armed" indicator (not a countdown).
Reason: the trigger is event-driven ("when done"), so a fixed timer only makes sense as the last-chance abort window before the irreversible action.
Where: backend engine phase machine + frontend menu
Revisit: no

---

## RUN LEDGER (chunk -> outcome -> sha)
- DONE C1 backend (system_control + when_done engine + 3 IPC + ts-rs types) -> af11138, cargo build clean
  - REVISIT (non-blocking): engine writes its auto-resolution log to COMMENTS_FOR_BEPY.md via a compile-time CARGO_MANIFEST_DIR path; fine in dev, would need an app-data path for a packaged release.
- DONE C2 frontend overflow menu + move sort/history/new-chat + sleep/shutdown toggles + countdown -> 9a6f7a5, tsc clean, vitest 179 pass
  - Menu layout/copy/icons GUESSED (Joe's taste, flagged in BEPY_TODOS Visual QA for review)
  - 3 e2e specs adapted to the moved new-chat button; not run by me (slow suite)
- DONE C3 tests (15 frontend + 3 backend cases) -> 8ab950f
- DONE C4 verify floor ALL GREEN (cargo build clean, tsc 0 errors, vitest 194 pass / 19 skip, no orphans) + README feature bullet + BEPY_TODOS manual-verify entry + deleted ai_todos 28/29
  - Real close->countdown->sleep/shutdown chain is integration-only -> handed to Joe as a Visual QA BEPY_TODO (can't sleep a real PC in CI)
- DONE C5 (added after Joe challenged test depth) -> ed416dc
  - Caught: the 3 backend tests were compile-only (--no-run); now EXECUTE (14 when_done cases pass, scoped so daemon survives)
  - Extracted 4 pure engine fns behavior-preserving (all_sessions_idle, waiting_on_ids, next_countdown, close_turn_complete) so the phase-machine logic is actually exercised
  - Parse-checked the 3 modified e2e specs (all valid)
  - Remaining lever NOT pulled (Joe's call): trait-inject the daemon client + terminal action to enable a full task-level integration test - that's a structural change to shipped code, didn't do it unprompted

---

## 2026-06-11 00:45 - /autopilot ai_todos sweep

Task: grind any actionable ai_todos. Triaged all 11. Only 1 was cleanly actionable without a live test or WIP conflict.

Decision needed: which todos to action vs park.
Resolved via: direct judgment + one Explore subagent for triage + one Explore subagent to verify 37's intent.
Picked:
- ai_todo 43 (extract statusbar tally subsystem): IMPLEMENTED. session-statusbar.ts 539 -> 385 lines; new session-tally.ts (ToolTallyRow controller) + session-tally.css. Pure refactor, behavior identical, tsc clean, vitest 277 pass (6 tally tests green). Commit 86d38fe. ai_todo deleted.
- ai_todo 37 (hide Bash from statusline tally): CLOSED AS REDUNDANT, no code written. The feature already exists: Settings > Statusline > "Tool activity chips" already lists "Ran (shell)" (key "Bash") as an untickable checkbox (statusline.ts:121-127 -> tallyHiddenTools). Unticking it filters ONLY the statusline tally render (session-statusbar.ts:428), never the in-chat transcript rows. That is exactly what 37 asked for. Implementing a separate tallyHideBash boolean would duplicate it. ai_todo deleted.
  - Revisit: ONLY if you wanted a MORE prominent/dedicated toggle than the generic per-tool chip list. The functional ask is already met. Re-add a todo if you want dedicated UI.

Parked (not actionable this run):
- ai_todo 31 (collapse context-window heuristic to 1 source): BLOCKED. Its precondition is that ai_todo 30's BEPY_TODO confirms the chip reads the daemon value correctly post-relaunch. ai_todo 30 is still in BEPY_TODOS NEEDS-RELAUNCH pending, and the daemon value is itself a heuristic (no definitive Opus 200K-vs-1M signal). Removing the frontend modelContextWindow fallback now is a live-test gate I cannot clear. Left as-is.
- 32 (when-done integration test), 35 (in-app file viewer), 36 (AskUserQuestion dropped answers), 40 (auto-query models - OAuth /v1/models gating unknown), 45 (msg-count + unsent queue): all need a live app/daemon, a live repro, or Joe's credentials. Parked.
- 42 (filter body tool groups) + 44 (transcript accordion): SKIPPED to avoid clobbering the uncommitted WIP already in the tree (chat-renderer.ts, turn-collapse.ts, chat.css, chat-renderer-activity.test.mjs) - that WIP is in-flight work on 44. See note below.
- 33 (HotS laugh extraction): needs local game CASC + manual audio curation on your machine. Parked.

NOTE on uncommitted WIP: at session start the tree already had modified chat-renderer.ts / chat.css / turn-collapse.ts / chat-renderer-activity.test.mjs (in-flight on ai_todo 44, predates this session). Tests pass WITH it (277 green) but I did NOT commit it - can't attribute another agent's half-state, and concurrent-autopilot rules say never sweep up files I didn't author. Left untouched/unstaged. Also left unstaged: the ` D` deletion of ai_todo 41's md file (41 was resolved in commit 48b593e; its md just wasn't deleted then - your call whether to clean it up).

Where: src/views/sessions/ (statusbar tally)
Revisit: 37 only (see above); rest are parked with reasons.

## 2026-06-11 23:46 - Subagent tool-call nesting (under /autopilot)
Decision needed: how to render a subagent's nested tool calls (inline vs side-panel)
Resolved via: direct judgment (dev said "i dont mind"; reversible + matches existing chip UX)
Picked: inline nested chip-strip inside the Subagent chip's expansion   Reason: consistent with the existing chip pattern, least disruptive, reuses the delegated click handler   Where: turn-collapse.ts groupToolRange
Revisit: no
RUN_LEDGER:
- Chunk A (Rust: capture parent_tool_use_id in chat/parser.rs + ChatEvent::ToolUse, ts-rs regen, 3 parser tests) -> 73ae5e8
- Chunk B (frontend: plumb parentToolUseId to RenderedMessage + nest children under the Subagent chip as a nested chip-strip, 2 new jsdom tests) -> 98ca6fe
Deferred (separable): cold-reload-from-transcript nesting - subagent calls are NOT in the main .jsonl, they live only in the subagents/ file + the live stream, so after an app restart they would not nest (or appear) without also merging the subagents file. nested-strip-on-reload-straddle edge case is untested.
Pending LIVE confirm (cannot verify statically): that the live stream actually populates parent_tool_use_id - a debug log was added in chat/parser.rs; Joe must run one real subagent turn and confirm. See BEPY_TODOS.

## 2026-06-14 - Per-session characters + per-project whitelist (autopilot)

Task: replace per-PROJECT character assignment with per-SESSION characters drawn from a per-project rule-based whitelist. Full design at docs/superpowers/specs/2026-06-14-per-session-characters-design.md (gitignored). Brainstormed + approved before /autopilot.

Decisions settled in brainstorm (not autopilot-guessed): per-session ownership; project face = placeholder for now (Avatar::None), tech-icon detection deferred; whitelist = Default|All|Custom{games,ids} with live default reference + reset-to-default; sessionCharacters map in settings, live-only, lazy-pruned; random pick dedups vs live sessions; new-session UI = Option B side pane, sound on every pick; Change Character Modal (Whitelisted|All + search); per-session sound; migration marks all projects Default + converts Character avatars to None.

RUN_LEDGER (chunk -> outcome -> sha):
- BE-1 CharacterWhitelist type + settings fields (defaultCharacterWhitelist, sessionCharacters) + ts-rs regen -> cargo build + tsc clean -> bc54602
- BE-2 pure whitelist resolve()/pick_random() + 15 unit tests -> ecf48b2 ; fixed a ProjectConfig literal in projects_ipc test missed by BE-1 -> 58e4ec8
- BE-3a session-char + whitelist IPC (ensure/set/reroll/list + project/default whitelist + resolve) with live-session lazy prune; registry via state.cached_instances -> cargo build clean -> 748b35a
- BE-3b migration v2 (strip project Character avatars -> None, all projects inherit Default) + stop pick_hero on project create -> fc2944d ; finish/question sounds now use the session's character (session_id threaded through notifications::fire) -> f84269b
- FE-1 session-keyed character lookup + ensure-on-appearance (instances-changed diff) + api wrappers -> tsc + 376 vitest -> 809cb41
- FE-2 shared Change Character Modal (Whitelisted|All tabs + search) wired to chat header face + more-options menu (dynamic import to dodge cycle); fixed a latent "__loading__" sentinel crash in the modal -> 3a3c71a
- FE-4 per-project whitelist editor (replaced old <select> subview) + Settings > Characters default editor + shared whitelist-editor.ts; updated the stale projects_view test -> 432a6aa
- FE-3 new-session character side pane (Option B: portrait/name/game + Reroll/Choose, sound on every pick debounced 250ms, live-taken dedup) + characterId applied on session_started -> 2658b6a

FINAL VERIFY (completion oracle, all green): cargo build (full) OK; pnpm tsc --noEmit clean; 376 vitest passed / 19 pre-existing skips; cargo whitelist 15 passed; projects_ipc 7 passed; notifications::rules 13 passed (per BE-3b). No node orphans. ipc.generated.ts is gitignored (regenerates on prebuild).

Decisions log (autopilot - mostly settled in brainstorm, none needed iterate-it):
- 2026-06-14 - Change-modal pick plays the "select" sound too (consistency with new-session "sound on every pick"). Direct judgment, reversible.
- 2026-06-14 - Project face placeholder is renderAvatar's existing "?" for Avatar::None (real tech-icon detection is ai_todo 99). Direct judgment.
- 2026-06-14 - more-menu -> active-session uses a DYNAMIC import to avoid the static import cycle (memory: sidebar import-cycle crashes node vitest). Direct judgment.
- 2026-06-14 - FE-2/FE-4 subagents hit the API session limit mid-run; main agent finished both chunks inline (files were complete; only wiring + a latent modal crash + a stale test remained).

Deferred (ai_todos created): 99 project tech-icon detection; 100 AUQ relay timeout on AFK.

NOT pushed yet at time of writing; main agent will run /commit pushnbump next.
[when-done] auto-answered question with default option(s) (id fdb7686d-dbc1-47aa-901c-33f8d43b39d3)

## 2026-07-06 10:40 - autopilot run (recovered weekend "use up my tokens" job)

Why this ran Monday morning: the Sat 20:30 /schedule-once task (and its two siblings for hubbub + annoying_stopwatch) misfired EARLY on Fri Jul 3 16:49:34, all three at once, during a Modern Standby power transition. Each hit the exhausted session limit, exited, and run-once.ps1 self-deleted the task, so nothing ever re-fired. Prompt was recovered from a Jul 3 transcript's sidecar dump; Joe chose "run now, in this session".

RUN_LEDGER (chunk -> outcome -> sha):
- schedule-once hardening (outside repo, ~/.claude/skills/schedule-once/): run-once.ps1 now refuses premature fires (leaves task registered) and re-arms itself ~30min after a session-limit reset (max 3 attempts) instead of self-deleting on failure. Both paths tested with fake sidecars. SKILL.md updated.
- Landed the in-flight dirty tree as 3 units: 93e0173d (ai_todo 137 MCP relay connect-retry), f32048a7 (ai_todo 144 attach_hide_to_tray helper), f02b8200 (ai_todo 142 bundle descriptions). cargo build green. 86dffe1c resolves the three todo files.
- 0547315d DOCS: persisted multi-account spec (docs/multi-account/), HANDOFF, ai_todos 146/153/154, mockup, pr_preview note.
- c01efbad ai_todo 154 CSS split (lossless, diff-verified) + 7ec0f1b3 resolve.
- c9b632d8 TEST: fixed pre-existing 22-failure transport-http.test.mjs (commit 00813633 split HttpTransport into http-transport.ts but missed the test's imports). Suite now fully green (478).
- 6b96843b ai_todo 153 cross-session held-message autosend (flushBackground + sidebar wiring, 5 new tests, race-proof idempotency) + 31a298fc resolve.

Decisions (direct judgment, none needed iterate-it):
- 153: injected-send signature on flushBackground instead of the spec sketch's direct invoke import (keeps module IPC-free/testable); attached-session delegates to onCompletion; send errors caught (message lost on failure, same tradeoff as existing flush()).
- 144 closed without live re-verify: pure extraction, logic byte-identical, build green.
- tmp.csv in repo root is projector-shopping research (unrelated); left untracked, not deleted.

Stopped at: context hard-stop (87% used) before ai_todos 136, 135, 094, 146. Their files remain in .for_bepy/ai_todos/ with a triage verdict: 136 first (unblocks 135/139/138), then 094, then 146 (grep instance_token_stats for a source dimension first). Say "do the AI todos" or re-run /autopilot to continue.

Parked (with reasons):
- ai_todo 151 (dup-spawn guard): cargo-verifiable but touches the daemon spawn race that once caused a 2h crash loop; not shipping that unattended without live pipe-drop verification.
- ai_todo 87: fix lives in the server_supervisor repo, not this one.
- ai_todos 90/147: e2e specs ready but each run burns a real billable turn and needs the tray app closed.
- hubbub + annoying_stopwatch weekend tasks also died in the same misfire and were NOT re-run (other repos, out of scope here). Their prompts are recoverable from the same transcript if wanted.
[when-done] auto-approved permission for tool 'Bash' (id 6bcacc34-05ee-402d-890a-b40d6266045c)
