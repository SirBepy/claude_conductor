use crate::chat::billing::{check_metered_billing, check_metered_billing_api_credit, check_metered_billing_endpoint};
use crate::daemon::claude_config::{
    append_system_prompt, base_claude_args, write_hook_settings, write_mcp_config,
};
use crate::daemon::pump::run_stdout_pump;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;
use tokio::process::Command;

use super::{is_valid_model, LifecycleError, StartSessionParams, VALID_EFFORTS};

pub async fn spawn_session(
    state: &Arc<DaemonState>,
    params: StartSessionParams,
) -> Result<Arc<Session>, LifecycleError> {
    spawn_session_as(state, params, None).await
}

/// [`spawn_session`] for a hidden sub's first spawn: `sub_parent` names its main
/// chat, which no registry row records yet. Every later launch of the same sub
/// goes through plain `spawn_session` and reads the parent off the registry row
/// (`subchats::launch_parent`), so a respawn keeps `CC_SUBCHAT` and the prompt.
pub async fn spawn_session_as(
    state: &Arc<DaemonState>,
    params: StartSessionParams,
    sub_parent: Option<&str>,
) -> Result<Arc<Session>, LifecycleError> {
    let label = params
        .new_session_id
        .clone()
        .or_else(|| params.resume_id.clone())
        .unwrap_or_else(|| "(new)".into());
    let spawned = spawn_session_inner(state, params, sub_parent).await;
    // The caller only gets the error as an RPC reply (a toast in the app); without
    // this line a spawn that never produced a child left nothing in the log.
    if let Err(e) = &spawned {
        log::warn!("daemon: spawning claude for session {label} failed: {e}");
    }
    spawned
}

/// The frozen-row guard of [`spawn_session_inner`]. The desktop's -32004 retry
/// (`start_session` after a NotFound send) lands here for an answer to a question card
/// of a chat the idle sweep stopped: that freeze cancelled nothing, so it is woken here
/// and the spawn goes on. A usage-limit or manual freeze still refuses.
pub(super) fn refuse_if_frozen(state: &Arc<DaemonState>, session_id: &str) -> Result<(), LifecycleError> {
    // First, so a put-away family's idle freeze is never woken by this check.
    refuse_if_put_away(state, session_id)?;
    let frozen = || state.registry.get(session_id).map(|i| i.frozen).unwrap_or(false);
    // A desktop unfreeze can clear the freeze between the read and the wake.
    if frozen() && !crate::daemon::subchats::idle_freeze::wake(state, session_id) && frozen() {
        return Err(LifecycleError::Frozen(session_id.to_string()));
    }
    Ok(())
}

/// The put-away gate of every start: a session of a put-away family (a main chat
/// or one of its subs) spawns nothing, whoever asks (a send, a schedule, an `after`
/// release, a resume). `Err` never changes the row.
pub(crate) fn refuse_if_put_away(state: &DaemonState, session_id: &str) -> Result<(), LifecycleError> {
    if crate::daemon::subchats::put_away::is_gated(state, session_id) {
        return Err(LifecycleError::PutAway(crate::daemon::subchats::put_away::refusal(session_id)));
    }
    Ok(())
}

async fn spawn_session_inner(
    state: &Arc<DaemonState>,
    params: StartSessionParams,
    sub_parent: Option<&str>,
) -> Result<Arc<Session>, LifecycleError> {
    let map = &state.sessions;
    // First of all, ahead of the account and billing checks that need I/O: a put-away
    // family spawns nothing. A sub's first spawn has no row naming its parent yet, so
    // `sub_parent` is read directly; any other start names its id in the params.
    if let Some(parent) = sub_parent {
        if crate::daemon::subchats::is_hidden_family(parent) {
            return Err(LifecycleError::PutAway(crate::daemon::subchats::put_away::refusal(parent)));
        }
    }
    let named_id = match (&params.resume_id, params.fork) {
        (Some(id), false) => Some(id),
        _ => params.new_session_id.as_ref(),
    };
    if let Some(id) = named_id {
        refuse_if_put_away(state, id)?;
    }
    // Resolve the account this chat spawns under: explicit `account_id` if the
    // caller gave one, else the daemon's cached `default_account_id`. No spawn
    // path may fall back to `~/.claude` (00-overview.md locked decision). Looked
    // up ahead of the model check, whose rule depends on the account's kind (an
    // endpoint account serves ids no Claude family name appears in); a lookup
    // that failed is reported below, after the checks that always came first.
    let default_account_id = state.settings.snapshot().default_account_id;
    let resolved = crate::accounts::resolve_account(
        params.account_id.as_deref(),
        default_account_id.as_deref(),
    );
    let model_fits = match &resolved {
        Ok(account) => super::is_valid_model_for(&params.model, account),
        Err(_) => is_valid_model(&params.model),
    };
    if !model_fits || !VALID_EFFORTS.contains(&params.effort.as_str()) {
        return Err(LifecycleError::InvalidConfig(params.model, params.effort));
    }
    if !params.cwd.exists() {
        return Err(LifecycleError::CwdMissing(params.cwd));
    }
    let account = resolved.map_err(|e| match e {
        crate::accounts::AccountResolveError::NoAccounts => LifecycleError::NoAccounts,
        crate::accounts::AccountResolveError::NoDefault => LifecycleError::NoDefault,
        crate::accounts::AccountResolveError::NotFound(id) => LifecycleError::AccountNotFound(id),
    })?;
    let api_credit = account.is_api_credit();
    let endpoint = account.is_endpoint();
    if api_credit {
        super::refuse_account_if_api_credit_blocked(state, &account.id)?;
    }
    let spawn_env = if endpoint {
        // No OAuth login exists for this kind either; the stored key is its
        // only credential, sent to the account's own base URL.
        endpoint_spawn_env(&account, &params.model, crate::accounts::api_credit::load_api_key)?
    } else if api_credit {
        // No OAuth login exists for this kind, so the drift and credentials
        // checks below (both read `.credentials.json`) are skipped; the
        // stored API key is its only credential.
        api_credit_spawn_env(&account, crate::accounts::api_credit::load_api_key)?
    } else {
        // Pre-spawn drift guard (step 3b): refuse if the profile dir's CLI
        // identity no longer matches what the registry recorded at add-account
        // time (someone ran `/login` inside it since onboarding).
        crate::accounts::drift::check(&account)
            .map_err(|e| LifecycleError::AccountDrift(e.to_string()))?;
        // Drift only asks whether credentials EXIST. A failed refresh leaves the
        // record in place with both tokens blanked, which passes that test and
        // then fails at the CLI with an opaque auth error - this catches it here.
        crate::accounts::credentials::check_now(&account)
            .map_err(|e| LifecycleError::AccountCredentials(e.to_string()))?;
        crate::accounts::env::SpawnEnv::for_account(&account.config_dir)
    };
    // Billing gate evaluates the CHILD's effective env (parent env + this
    // spawn's overrides/removals), not the daemon's ambient env alone.
    // `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`
    // are already guaranteed gone via `SCRUBBED_ENV_VARS` for a subscription
    // account, so what this gate can still catch is a forbidden var that
    // SURVIVES the unsets - `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`.
    // An ApiCredit account keeps its own `ANTHROPIC_API_KEY` and nothing else.
    let effective_env = spawn_env.effective_env(std::env::vars());
    let guard = if endpoint {
        check_metered_billing_endpoint
    } else if api_credit {
        check_metered_billing_api_credit
    } else {
        check_metered_billing
    };
    if let Err(e) = guard(&|k| effective_env.get(k).cloned()) {
        return Err(LifecycleError::MeteredBilling(e.to_string()));
    }

    // The session id is known up front for BOTH paths: a new session gets a
    // freshly generated UUID that we hand to claude via `--session-id`, and a
    // resume reuses the existing id via `--resume`. No stdout capture needed,
    // so spawn_session never blocks (claude withholds its init line until the
    // first user message arrives, which the app sends only AFTER this returns).
    // A fork lands on a fresh id even though it resumes an existing one, so it
    // can never collide with the source session in `map`, in the mcp/hook
    // config paths (both keyed on session id), or in the registry.
    let session_id = match (&params.resume_id, params.fork) {
        (Some(_), true) | (None, _) => params.new_session_id.clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        (Some(id), false) => id.clone(),
    };
    // Before the id is used to build anything: it flows into `turn_id` below,
    // and from there into filesystem paths and shell command strings.
    crate::ipc::chat::attachments::validate_session_id(&session_id)
        .map_err(|e| LifecycleError::InvalidSessionId(e))?;
    if map.contains_key(&session_id) {
        return Err(LifecycleError::AlreadyExists(session_id));
    }
    // Single chokepoint every spawn/respawn/restart path shares - blocks
    // silent resurrection everywhere, including the desktop app's -32004 retry.
    refuse_if_frozen(state, &session_id)?;

    // Resume path: `session_id` is the pre-existing registry entry (see the
    // match above), so its `jarvis` flag - stamped by `ensure_jarvis_session`
    // before any message is ever sent to it - is already known here. New/fork
    // spawns get a brand-new id never seen by the registry yet, so this reads
    // false for them; the one caller that spawns a genuinely new Jarvis
    // session (`ensure_jarvis_session`) sends no first message itself, so no
    // MCP child is ever started off that particular config before the
    // registry's `jarvis` flag is set on the very next turn's respawn.
    let is_jarvis = state.registry.get(&session_id).map(|i| i.jarvis).unwrap_or(false);
    // Belt-and-suspenders (todo 441 area): every spawn/resume of a Jarvis-
    // flagged session re-asserts chat-config's auto-accept here, so no resume
    // path - present or future - can ever boot a Jarvis session whose
    // persisted flag was somehow left/found false.
    if is_jarvis {
        crate::sessions::chat_config::set_auto_accept(&session_id, true);
    }
    // Per-TURN name (todo 867): `run_pump_exit` deletes the previous turn's
    // path late, so a shared one lands on the new turn's live config.
    let turn_id = format!("{session_id}-{}", crate::daemon::claude_config::turn_nonce());
    // The connectors are read from the account's claude.ai login, which an
    // endpoint account does not have.
    let connectors_on = !endpoint
        && crate::settings::identity::resolve_claude_ai_connectors(&state.settings.snapshot().projects, &params.cwd);
    let mut connectors = if connectors_on {
        crate::daemon::claude_ai_connectors::servers_for(&account.config_dir).await
    } else {
        Default::default()
    };
    // The project's own listed servers, probed so a dead or silent one is
    // left out instead of stalling MCP init, as an unauthenticated connector once did.
    let listed = crate::settings::identity::resolve_project_mcp_servers(
        &state.settings.snapshot().projects,
        &params.cwd,
    );
    let mut mcp_skipped: Vec<String> = Vec::new();
    if !listed.is_empty() {
        let store = crate::daemon::mcp_oauth::store_path();
        let own = crate::daemon::project_mcp::servers_for(
            &listed,
            store.as_deref(),
            crate::daemon::claude_config::daemon_hook_port(),
        )
        .await;
        mcp_skipped = own.skipped.clone();
        log::info!(
            "daemon: turn {turn_id} project mcp servers: {} written, skipped {:?}",
            own.servers.len(),
            own.skipped
        );
        connectors.extend(own.servers);
    }
    // Names the side that came up empty when a chat lacks its connectors.
    log::info!(
        "daemon: turn {turn_id} claude.ai connectors: project flag {}, {} server(s)",
        if connectors_on { "on" } else { "off" },
        connectors.len()
    );
    let settings = state.settings.snapshot();
    let (browser, browser_script) = (settings.claude_browser_enabled(), settings.claude_browser_script_tool());
    // Read off the registry row and chat-config, so a relaunch keeps the role.
    let role = crate::daemon::subchats::role_launch(state, &session_id, sub_parent);
    let mcp_config_path = write_mcp_config(
        &turn_id,
        &session_id,
        is_jarvis,
        browser,
        browser_script,
        role.is_sub(),
        connectors,
    );
    let skills = {
        let project = crate::slash::scope::project_id(&settings, Some(&params.cwd));
        crate::slash::scope::chat_settings(&crate::slash::scope::scopes(&settings), project.as_deref())
    };
    let hook_settings_path = write_hook_settings(&turn_id, &session_id, skills, role.is_sub());

    let claude = crate::util::claude_bin::resolve()
        .map_err(|e| LifecycleError::ClaudeNotFound(e.to_string()))?;
    let mut cmd = Command::new(&claude);
    let mut args = base_claude_args(
        params.resume_id.as_deref(),
        &session_id,
        &params.model,
        &params.effort,
        params.fork,
    );
    let projects = state.settings.snapshot().projects;
    let cwd = params.cwd.clone();
    let tracker = tokio::task::spawn_blocking(move || crate::tickets::effective_tracker(&projects, &cwd))
        .await
        .ok()
        .flatten();
    // The chat's scoped broker token, worked out before `tracker` is consumed below.
    let broker_token = super::broker_env::mint_for_launch(
        state,
        &session_id,
        role.sub_parent.as_deref(),
        &params.cwd,
        tracker.as_ref().map(|(t, _)| t.clone()),
    )
    .await;
    if let Some(line) = tracker.and_then(|(t, _)| crate::tickets::prompt_line(&t)) {
        append_system_prompt(&mut args, &line);
    }
    // Baked into argv, so it only describes the toggle at spawn time. A flip
    // while this child lives is delivered by `lifecycle::send_message` as a
    // note on the next message, tracked through `Session::subchats_told`.
    let chat_cfg = crate::sessions::chat_config::get(&session_id).unwrap_or_default();
    if chat_cfg.subchats_on {
        crate::sessions::chat_config::set_subchats_told(&session_id, true);
    }
    role.append_prompts(&mut args);
    // Also true when the toggle is now off but a resumed history still holds
    // the ON prompt, so the next message retracts it.
    let subchats_at_spawn = chat_cfg.subchats_told_at_spawn();
    cmd.args(args);
    if let Some(ref mcp_path) = mcp_config_path {
        cmd.arg("--permission-prompt-tool")
           .arg("mcp__cc_conductor__approval_prompt")
           .arg("--mcp-config")
           .arg(mcp_path)
           // todo 867: unmerged from account connectors, whose auth failures
           // took MCP init down and left the turn with no approval_prompt.
           .arg("--strict-mcp-config");
    }
    if let Some(ref settings_path) = hook_settings_path {
        cmd.arg("--settings").arg(settings_path);
    }
    cmd.current_dir(&params.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    spawn_env.apply_tokio(&mut cmd);
    super::broker_env::apply(&mut cmd, &broker_token);
    if let Some((k, v)) = sub_auto_compact_env(role.is_sub(), account_compact_window(&spawn_env)) {
        cmd.env(k, v);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(claude_creation_flags());
    }
    // Belt-and-suspenders orphan guard: `child` lives inside the pump task
    // spawned below for the session's whole natural lifetime (it is only
    // dropped after an explicit `child.wait().await` once stdout hits EOF,
    // i.e. after the process has already exited on its own - so this never
    // fires early on the normal per-turn respawn cycle). If the pump task's
    // future is instead dropped without reaching that point (daemon exiting
    // while a turn is in flight, or the pump task panicking), `kill_on_drop`
    // makes sure the child doesn't outlive it. Doesn't replace the explicit
    // `kill_tree` shutdown sweeps (those also reap grandchildren); this only
    // covers the direct child.
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn()?;
    // Extends kill_on_drop above from the direct child to the whole tree (the
    // cmd/npx shims and MCP servers claude starts). Chat sessions are already
    // daemon-lifetime-bound, so this changes no semantics.
    crate::util::process::guard_orphan_tree(&child);
    let pid = child.id().expect("pid");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let session = Session::new(
        session_id.clone(),
        params.cwd.clone(),
        params.model.clone(),
        params.effort.clone(),
        pid,
        stdin,
        mcp_config_path,
        hook_settings_path,
        account.id.clone(),
    );
    session.subchats_told.store(subchats_at_spawn, std::sync::atomic::Ordering::SeqCst);
    // Whether this child can be compacted yet, and whether its argv carries the
    // main chat's rules (a compaction can summarise away a mid-chat note).
    let orphaned = crate::daemon::subchats::compaction::note_child(&session_id, pid, params.resume_id.is_some(), chat_cfg.subchats_on);
    crate::daemon::subchats::compaction::restage(state, &session_id, orphaned);
    map.insert(session_id.clone(), Arc::clone(&session));
    let drain = tokio::spawn(drain_stderr(stderr, Arc::clone(&session)));
    *session.stderr_drain.lock().await = Some(drain);
    // Every spawn/respawn/restart path funnels through this one insertion
    // point, so bumping the epoch here (not at each of the five daemon-
    // internal respawn callers) covers all of them by construction - see
    // Registry::bump_channel_epoch.
    state.registry.bump_channel_epoch(&session_id);
    log::info!(
        "daemon: session {} live (pid={}, resume={})",
        session_id, pid, params.resume_id.is_some()
    );

    crate::daemon::project_mcp::announce_skipped(&session, &mcp_skipped);

    let pump_session = Arc::clone(&session);
    let map_for_pump = Arc::clone(map);
    let state_for_pump = Arc::clone(state);
    tokio::spawn(run_stdout_pump(child, stdout, pump_session, map_for_pump, state_for_pump, params.resume_id.is_some()));

    // NOTE: jsonl_tail is intentionally NOT spawned in Phase 5a. It republishes
    // every transcript line to the same broadcast the stdout pump already feeds,
    // with no dedup, so it double-renders every app-driven turn. Its only purpose
    // is catching turns that bypass our stdout (phone via remote-control bridge);
    // that is Phase 5b/phone-convergence work and must add uuid-based dedup first.

    Ok(session)
}

/// Read the child's stderr to EOF, logging each line and keeping a tail on the
/// Session. Draining is not optional: the pipe has a finite OS buffer, so an
/// unread stderr eventually blocks the child mid-write.
async fn drain_stderr(stderr: tokio::process::ChildStderr, session: Arc<Session>) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        log::warn!("claude stderr [{}]: {}", session.session_id, line);
        if let Ok(mut tail) = session.stderr_tail.lock() {
            if tail.len() == crate::daemon::session::STDERR_TAIL_LINES {
                tail.remove(0);
            }
            tail.push(line);
        }
    }
}

/// The per-chat lock `respawn_interactive` holds across its wake and spawn.
fn respawn_lock(session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::Mutex<Option<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        std::sync::Mutex::new(None);
    let mut locks = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    locks.get_or_insert_with(Default::default).entry(session_id.to_string()).or_default().clone()
}

/// Re-spawn `session_id` from the Registry's recorded cwd/model/effort/
/// account, resuming its existing transcript (never a fork, never a fresh
/// id). Only respawns sessions the Registry still considers a live
/// Interactive chat (not `ended_at`-marked, not External/Automated) -
/// anything else is a genuine NotFound. Shared by `send_message_with_respawn`
/// (sends a message right after) and `restart_session` (the Jarvis "Restart"
/// action - no message, just a fresh child).
pub(super) async fn respawn_interactive(
    state: &Arc<DaemonState>,
    session_id: &str,
) -> Result<Arc<Session>, LifecycleError> {
    let open_chat = |state: &Arc<DaemonState>| {
        state
            .registry
            .get(session_id)
            .filter(|i| i.ended_at.is_none())
            .filter(|i| matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive))
            .ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))
    };
    // Checked before the lock so an id that names no chat leaves no lock behind.
    open_chat(state)?;
    // Ahead of the idle-freeze wake below, which would answer a put-away chat with NotFound.
    refuse_if_put_away(state, session_id)?;
    // One respawn per chat at a time: `spawn_session` only inserts into the session map
    // at its end, so two senders reaching a childless chat together (a peer message and
    // the phone's send, both after an idle freeze) would each start a child and the
    // second insert would orphan the first. The one that waits finds the live session.
    let respawn_lock = respawn_lock(session_id);
    let _respawning = respawn_lock.lock().await;
    if let Some(live) = state.sessions.get(session_id).map(|s| s.clone()) {
        return Ok(live);
    }
    let mut inst = open_chat(state)?;
    // Every daemon-side sender (peer `send_message`, the phone's REST send, Jarvis,
    // the preview) lands here when a chat has no child. The idle sweep froze this
    // one on its own, so nothing was cancelled and the sender must not meet a freeze
    // Joe never made; a usage-limit or manual freeze still refuses.
    if inst.frozen && !crate::daemon::subchats::idle_freeze::wake(state, session_id) {
        // Something that takes no respawn lock (a desktop unfreeze) may have cleared it
        // between the read and the wake.
        inst = open_chat(state).ok().filter(|i| !i.frozen).ok_or_else(|| LifecycleError::NotFound(session_id.to_string()))?;
    }

    let (model, effort) = super::model_effort_or_default(&inst);
    spawn_session(
        state,
        StartSessionParams {
            cwd: inst.cwd,
            model,
            effort,
            resume_id: Some(session_id.to_string()),
            account_id: inst.account_id,
            fork: false,
            new_session_id: None,
        },
    )
    .await
}

/// Force-kill `session_id`'s live child (if any) and respawn it resuming the
/// SAME session id - the Jarvis kebab menu's "Restart Jarvis" action. Never
/// forks, never marks the session ended in the Registry (unlike
/// `end_session`), so the fleet-ownership/persisted-name/awaiting bookkeeping
/// survives untouched across the restart.
pub async fn restart_session(
    state: &Arc<DaemonState>,
    session_id: &str,
) -> Result<String, LifecycleError> {
    // Before the kill: a restart the respawn would refuse must not tear down a live chat.
    refuse_if_put_away(state, session_id)?;
    super::teardown::kill_and_wait_for_teardown(state, session_id).await;
    // The kill wait gives up after a few seconds; a child still in the map would be
    // handed back by the respawn as if it were new, so say so instead.
    if state.sessions.get(session_id).is_some() {
        return Err(LifecycleError::AlreadyExists(session_id.to_string()));
    }
    let session = respawn_interactive(state, session_id).await?;
    Ok(session.session_id.clone())
}

/// The child env for a chat on an `ApiCredit` account. `load_key` is injected
/// so tests never touch the real data dir. A missing or undecryptable key
/// refuses the spawn, naming the account, rather than starting a `claude` that
/// would then fail with an opaque auth error.
fn api_credit_spawn_env(
    account: &crate::accounts::Account,
    load_key: impl FnOnce(&str) -> Option<String>,
) -> Result<crate::accounts::env::SpawnEnv, LifecycleError> {
    let api_key = load_key(&account.id).ok_or_else(|| {
        LifecycleError::AccountCredentials(format!(
            "the API key for account \"{}\" is missing or unreadable - use Replace API key in the account's menu under Settings > Accounts",
            account.label
        ))
    })?;
    Ok(crate::accounts::env::SpawnEnv::for_api_credit_account(&account.config_dir, &api_key))
}

/// The child env for a chat on an `Endpoint` account. `load_key` is injected so
/// tests never touch the real data dir. A missing key or a blank base URL
/// refuses the spawn, naming the account, rather than starting a `claude` that
/// would then fail with an opaque auth or connection error.
fn endpoint_spawn_env(
    account: &crate::accounts::Account,
    model: &str,
    load_key: impl FnOnce(&str) -> Option<String>,
) -> Result<crate::accounts::env::SpawnEnv, LifecycleError> {
    let endpoint = account
        .endpoint
        .as_ref()
        .filter(|e| !e.base_url.trim().is_empty())
        .ok_or_else(|| {
            LifecycleError::ProviderRefused(format!(
                "the endpoint account \"{}\" has no base URL - set one in Settings > Accounts",
                account.label
            ))
        })?;
    let key = load_key(&account.id).ok_or_else(|| {
        LifecycleError::AccountCredentials(format!(
            "the key for endpoint account \"{}\" is missing or unreadable - replace it in the account's menu under Settings > Accounts",
            account.label
        ))
    })?;
    Ok(crate::accounts::env::SpawnEnv::for_endpoint_account(&account.config_dir, endpoint, &key, model))
}

/// Window the CLI's own auto-compact measures a sub against. A sub's growth
/// happens inside one long turn (398K before its first commit, measured
/// 2026-11-14), where the daemon cannot send `/compact`; the CLI compacts
/// mid-turn when this is set (spiked 2026-11-16 on claude 2.1.325: two
/// compact_boundary events in one turn at 25000). Main chats compact at 300K.
const SUB_AUTO_COMPACT_WINDOW_TOKENS: u64 = 300_000;

/// Env pair that makes a sub compact itself; `None` for every other chat.
/// `own_window` is the compact window the account's env already set (an endpoint
/// whose model has a smaller window than 300K): the sub never raises it, or it
/// would run past the window before it compacted.
fn sub_auto_compact_env(is_sub: bool, own_window: Option<u64>) -> Option<(&'static str, String)> {
    let window = own_window.map_or(SUB_AUTO_COMPACT_WINDOW_TOKENS, |w| w.min(SUB_AUTO_COMPACT_WINDOW_TOKENS));
    is_sub.then(|| ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", window.to_string()))
}

/// The compact window the account's spawn env set, if any.
fn account_compact_window(env: &crate::accounts::env::SpawnEnv) -> Option<u64> {
    env.set.iter().find(|(k, _)| k == "CLAUDE_CODE_AUTO_COMPACT_WINDOW").and_then(|(_, v)| v.parse().ok())
}

/// Windows process-creation flags for every chat's `claude` child. Below-normal
/// priority is inherited by the child's whole tree (cargo, node, rustc, bash),
/// so Joe's own apps win the CPU when the fleet runs many builds at once.
#[cfg(windows)]
fn claude_creation_flags() -> u32 {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;

    #[cfg(windows)]
    #[test]
    fn chat_children_run_below_normal_priority_without_a_window() {
        let f = claude_creation_flags();
        assert_eq!(f & 0x0000_4000, 0x0000_4000, "BELOW_NORMAL_PRIORITY_CLASS");
        assert_eq!(f & 0x0800_0000, 0x0800_0000, "CREATE_NO_WINDOW");
    }

    #[test]
    fn only_a_sub_gets_the_auto_compact_window() {
        assert_eq!(
            sub_auto_compact_env(true, None),
            Some(("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "300000".to_string()))
        );
        assert_eq!(sub_auto_compact_env(false, None), None);
    }

    #[test]
    fn a_sub_never_compacts_later_than_its_models_own_window() {
        let own = |w| sub_auto_compact_env(true, Some(w)).map(|(_, v)| v);
        assert_eq!(own(262_144), Some("262144".to_string()), "a 262K model compacts at 262K, not 300K");
        assert_eq!(own(1_048_576), Some("300000".to_string()), "a bigger window keeps the sub's own 300K");
    }

    #[test]
    fn an_endpoint_spawn_env_names_its_compact_window() {
        let mut account = endpoint_account("https://api.kimi.ai/coding/");
        account.endpoint.as_mut().unwrap().preset = crate::accounts::EndpointPreset::KimiCode;
        let env = endpoint_spawn_env(&account, "k3.1-pro", |_| Some("k".into())).unwrap();
        assert_eq!(account_compact_window(&env), Some(262_144));
    }
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn api_account() -> crate::accounts::Account {
        crate::accounts::Account {
            id: "api-1".into(),
            label: "API credit".into(),
            colour: "#fff".into(),
            icon: "key".into(),
            config_dir: std::path::PathBuf::from("C:/home/.claude-api-credit"),
            chrome_profile_dir: std::path::PathBuf::from("C:/appdata/chrome-profiles/api-1"),
            email: String::new(),
            org_uuid: "console-org".into(),
            subscription_tier: String::new(),
            created_at: "2026-10-26T00:00:00Z".into(),
            fleet_eligible: false,
            kind: crate::accounts::AccountKind::ApiCredit,
            endpoint: None,
        }
    }

    fn endpoint_account(base_url: &str) -> crate::accounts::Account {
        let mut a = api_account();
        a.id = "ep-1".into();
        a.label = "DeepSeek".into();
        a.kind = crate::accounts::AccountKind::Endpoint;
        a.endpoint = Some(crate::accounts::EndpointConfig {
            base_url: base_url.into(),
            auth_style: crate::accounts::EndpointAuth::XApiKey,
            ..Default::default()
        });
        a
    }

    #[test]
    fn endpoint_spawn_env_carries_the_key_the_base_url_and_the_chats_model() {
        let env = endpoint_spawn_env(&endpoint_account("https://api.deepseek.com/anthropic"), "deepseek-v4-pro", |id| {
            assert_eq!(id, "ep-1");
            Some("sk-ds".to_string())
        })
        .unwrap();
        assert!(env.set.contains(&("ANTHROPIC_API_KEY".to_string(), "sk-ds".to_string())));
        assert!(env.set.contains(&("ANTHROPIC_BASE_URL".to_string(), "https://api.deepseek.com/anthropic".to_string())));
        assert!(env.set.contains(&("CLAUDE_CODE_SUBAGENT_MODEL".to_string(), "deepseek-v4-pro".to_string())));
    }

    #[test]
    fn endpoint_spawn_without_a_key_or_a_base_url_is_refused_naming_the_account() {
        match endpoint_spawn_env(&endpoint_account("https://x.test"), "m", |_| None).unwrap_err() {
            LifecycleError::AccountCredentials(msg) => assert!(msg.contains("DeepSeek"), "{msg}"),
            other => panic!("wrong error: {other}"),
        }
        match endpoint_spawn_env(&endpoint_account("  "), "m", |_| Some("k".into())).unwrap_err() {
            LifecycleError::ProviderRefused(msg) => assert!(msg.contains("DeepSeek") && msg.contains("base URL"), "{msg}"),
            other => panic!("wrong error: {other}"),
        }
    }

    #[test]
    fn the_model_gate_is_per_account_kind() {
        use crate::daemon::lifecycle::is_valid_model_for;
        let ep = endpoint_account("https://x.test");
        assert!(is_valid_model_for("deepseek-v4-pro", &ep));
        assert!(!is_valid_model_for("bad id;rm", &ep));
        let claude = api_account();
        assert!(is_valid_model_for("claude-opus-4-8", &claude));
        assert!(!is_valid_model_for("deepseek-v4-pro", &claude), "a Claude account keeps the family check");
    }

    #[test]
    fn api_credit_spawn_env_carries_the_decrypted_key() {
        let env = api_credit_spawn_env(&api_account(), |id| {
            assert_eq!(id, "api-1");
            Some("sk-ant-real".to_string())
        })
        .unwrap();
        assert!(env.set.contains(&("ANTHROPIC_API_KEY".to_string(), "sk-ant-real".to_string())));
        assert!(env.set.contains(&("CLAUDE_CONFIG_DIR".to_string(), "C:/home/.claude-api-credit".to_string())));
    }

    #[test]
    fn api_credit_spawn_without_a_readable_key_names_the_account() {
        let err = api_credit_spawn_env(&api_account(), |_| None).unwrap_err();
        match err {
            LifecycleError::AccountCredentials(msg) => assert!(msg.contains("API credit"), "{msg}"),
            other => panic!("wrong error: {other}"),
        }
    }

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A fork resumes one id and lands on another, so it must pass BOTH
    /// `--resume <old>` and `--session-id <new>` alongside `--fork-session`.
    /// Pinning the new id is what lets the daemon know it before spawning,
    /// instead of blocking on stdout to discover it.
    #[test]
    fn fork_passes_resume_and_a_distinct_pinned_session_id() {
        let args = base_claude_args(Some("old-id"), "new-id", "opus", "high", true);
        let r = args.iter().position(|a| a == "--resume").expect("--resume");
        assert_eq!(args.get(r + 1).map(String::as_str), Some("old-id"));
        assert!(args.iter().any(|a| a == "--fork-session"), "fork must pass --fork-session: {args:?}");
        let s = args.iter().position(|a| a == "--session-id").expect("--session-id");
        assert_eq!(args.get(s + 1).map(String::as_str), Some("new-id"));
    }

    /// Without `fork`, a resume keeps today's shape exactly: `--resume <id>`
    /// and no `--session-id`. Guards against the fork flag leaking into the
    /// ordinary respawn path, which would silently mint a new id per turn.
    #[test]
    fn plain_resume_is_unchanged_by_the_fork_flag() {
        let args = base_claude_args(Some("abc-123"), "abc-123", "opus", "high", false);
        assert!(!args.iter().any(|a| a == "--fork-session"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--session-id"), "{args:?}");
    }

    #[test]
    fn new_session_uses_session_id_not_resume() {
        // Root-cause guard: a brand-new session must use `--session-id <uuid>`,
        // NOT `--resume <uuid>`. claude rejects `--resume` of an unknown id
        // ("No conversation found with session ID") and exits.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false);
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "new session must not pass --resume: {args:?}"
        );
        let pos = args
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id must be present for a new session");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("new-uuid"));
    }

    #[test]
    fn resume_session_uses_resume_not_session_id() {
        let args = base_claude_args(Some("abc-123"), "abc-123", "opus", "high", false);
        assert!(
            !args.iter().any(|a| a == "--session-id"),
            "resume must not pass --session-id: {args:?}"
        );
        let pos = args
            .iter()
            .position(|a| a == "--resume")
            .expect("--resume must be present when resuming");
        assert_eq!(args.get(pos + 1).map(String::as_str), Some("abc-123"));
    }

    #[test]
    fn base_args_always_carry_model_and_effort() {
        let args = base_claude_args(None, "new-uuid", "sonnet", "medium", false);
        let m = args.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(args.get(m + 1).map(String::as_str), Some("sonnet"));
        let e = args.iter().position(|a| a == "--effort").expect("--effort");
        assert_eq!(args.get(e + 1).map(String::as_str), Some("medium"));
    }

    #[test]
    fn turn_nonce_never_repeats_for_one_session() {
        use crate::daemon::claude_config::turn_nonce;
        let ids: Vec<String> = (0..64)
            .map(|_| format!("sess-abc-{}", turn_nonce()))
            .collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "collision in {ids:?}");
    }

    #[test]
    fn base_args_pretrust_our_own_mcp_ask_tool() {
        // Pre-trust (todo: AUQ dual-path incident, 2026-08-18): the first call
        // to mcp__cc_conductor__ask_user_question must never reach the
        // ordinary approval gate, so it always renders through index.ts's
        // fire-and-forget path, never permission-card.ts's fallback.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false);
        let p = args
            .iter()
            .position(|a| a == "--allowedTools")
            .expect("--allowedTools must be present");
        let tools: Vec<&str> = args.get(p + 1).map(String::as_str).unwrap_or("").split(' ').collect();
        // Asserted by membership, not equality: adding a third pre-trusted tool
        // must not silently drop the ask tool's own guarantee.
        assert!(tools.contains(&"mcp__cc_conductor__ask_user_question"), "got {tools:?}");
    }

    #[test]
    fn base_args_pretrust_show_preview() {
        // todo 815: show_preview only renders HTML into a sandboxed frame, so
        // the per-session permission card it used to raise bought nothing.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false);
        let p = args
            .iter()
            .position(|a| a == "--allowedTools")
            .expect("--allowedTools must be present");
        let tools: Vec<&str> = args.get(p + 1).map(String::as_str).unwrap_or("").split(' ').collect();
        assert!(tools.contains(&"mcp__cc_conductor__show_preview"), "got {tools:?}");
    }

    #[test]
    fn base_args_carry_turn_status_prompt() {
        // The report_turn_status nudge must ride on every spawn (todo 435).
        // cc-progress is unmigrated this pass, so its marker still rides too.
        let args = base_claude_args(None, "new-uuid", "opus", "high", false);
        let p = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .expect("--append-system-prompt must be present");
        let prompt = args.get(p + 1).map(String::as_str).unwrap_or("");
        assert!(prompt.contains("report_turn_status"), "prompt must nudge the report_turn_status tool: {prompt}");
        assert!(prompt.contains("<cc-progress:"), "prompt must request the progress marker: {prompt}");
        // todo 963: a spawned session's tool list is whatever `claude -p
        // --input-format=stream-json` registers, and `TodoWrite` is not in it
        // (measured 2026-09-26 against CLI 2.1.278 - naming it in `--tools`
        // does not add it back, the flag silently drops the unknown name). The
        // checklist the prompt is asking for is driven by our OWN MCP
        // `write_plan` tool, which is advertised, so the prompt must name that
        // one. Asserting both halves, because a prompt sentence naming a tool
        // rots exactly the way this one did without the tie.
        assert!(
            prompt.contains(crate::mcp::tool_schemas_workflow::TOOL_WRITE_PLAN),
            "prompt must name the write_plan tool for the step checklist: {prompt}"
        );
        assert!(
            !prompt.contains("TodoWrite"),
            "prompt must not instruct TodoWrite - it is absent from a spawned session's tool list: {prompt}"
        );
    }

    /// The idle sweep's freeze is invisible to Joe, so a daemon-side send must wake it
    /// (here: the respawn reaches the missing cwd instead of dying on the freeze). A
    /// usage-limit freeze, and a manual one, still refuse.
    #[tokio::test]
    async fn a_respawn_wakes_an_idle_freeze_but_not_a_usage_limit_or_manual_one() {
        struct OwnData(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>, #[allow(dead_code)] tempfile::TempDir);
        impl Drop for OwnData {
            fn drop(&mut self) {
                std::env::remove_var("CC_DATA_DIR");
            }
        }
        let lock = crate::util::env_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", dir.path());
        let _own = OwnData(lock, dir);
        let state = test_state();
        let cwd = std::path::Path::new("Z:\\does\\not\\exist");
        for id in ["idle", "limit", "manual", "restarted"] {
            state.registry.upsert_interactive(id, cwd, "p", "2026-11-16T10:00:00Z");
            state.registry.set_account(id, "acct");
            state.registry.set_frozen(id, true);
        }
        state.registry.set_auto_frozen("idle", true);
        state.registry.set_auto_frozen("limit", true);
        state.registry.set_auto_frozen("restarted", true);
        // A usage-limit freeze after a restart carries no flag or stamp, only the
        // missing mark; a manual freeze is not automatic at all.
        assert!(crate::daemon::subchats::idle_freeze::mark("idle"));
        // A stale mark never overrides a live refusal.
        assert!(crate::daemon::subchats::idle_freeze::mark("limit"));
        state.registry.set_rate_limited_for_account("acct", 4_000_000_000, "five_hour");
        state.registry.mark_rate_limit_refused("limit");
        // Stamped by its account's limit but never refused: still just idle.
        let r = respawn_interactive(&state, "idle").await.err();
        assert!(matches!(r, Some(LifecycleError::CwdMissing(_))), "an idle freeze must not stop the respawn: {r:?}");
        assert!(!state.registry.get("idle").unwrap().frozen);
        for id in ["limit", "manual", "restarted"] {
            let r = respawn_interactive(&state, id).await.err();
            assert!(matches!(r, Some(LifecycleError::NotFound(_))), "{id}: {r:?}");
            assert!(state.registry.get(id).unwrap().frozen, "{id} must stay frozen");
        }
    }

    /// Two senders reaching a childless chat together must not each start a child: the
    /// one that waits for the per-chat lock gets the session the first one started.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_respawn_of_a_chat_that_already_has_a_child_returns_it_instead_of_starting_another() {
        let state = test_state();
        let (_child, live) =
            crate::daemon::lifecycle::probe::live_session(&state, "twice", ("opus", "high"), ("opus", "high"));
        // The probe's cwd does not exist, so a second spawn would fail with CwdMissing.
        let got = respawn_interactive(&state, "twice").await.ok().expect("the live child is returned");
        assert!(Arc::ptr_eq(&got, &live));
    }

    /// `kill_and_wait_for_teardown` gives up after its wait; a restart must then fail
    /// rather than report the dying child as the new one.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_restart_whose_old_child_never_leaves_the_map_fails() {
        let state = test_state();
        let (_child, _live) =
            crate::daemon::lifecycle::probe::live_session(&state, "stuck", ("opus", "high"), ("opus", "high"));
        // No pump removes the session, as with a teardown that outlasts the kill wait.
        let r = restart_session(&state, "stuck").await;
        assert!(matches!(r, Err(LifecycleError::AlreadyExists(_))), "{r:?}");
    }

    #[tokio::test]
    async fn invalid_model_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "bogus".into(),
                effort: "high".into(),
                resume_id: None,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    #[tokio::test]
    async fn full_model_id_accepted() {
        // The data-driven picker sends full ids like `claude-opus-4-8`; the
        // model gate must pass them through (it fails later on CwdMissing,
        // proving it got past the InvalidConfig check).
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "claude-opus-4-8".into(),
                effort: "high".into(),
                resume_id: None,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
    }

    #[tokio::test]
    async fn invalid_effort_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::env::temp_dir(),
                model: "opus".into(),
                effort: "ultra".into(),
                resume_id: None,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::InvalidConfig(_, _))));
        assert_eq!(state.sessions.len(), 0);
    }

    /// Collects every log record so a test can assert a line was written.
    struct Capture(std::sync::Mutex<Vec<String>>);
    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, r: &log::Record) {
            self.0.lock().unwrap().push(format!("{} {}", r.level(), r.args()));
        }
        fn flush(&self) {}
    }

    #[tokio::test]
    async fn a_failed_spawn_is_logged_at_warn() {
        static CAP: Capture = Capture(std::sync::Mutex::new(Vec::new()));
        log::set_logger(&CAP).expect("no other test installs a logger");
        log::set_max_level(log::LevelFilter::Trace);
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "opus".into(),
                effort: "high".into(),
                resume_id: None,
                account_id: None,
                fork: false,
                new_session_id: Some("spawn-fail-log".into()),
            },
        )
        .await;
        assert!(r.is_err());
        let lines = CAP.0.lock().unwrap().clone();
        assert!(
            lines.iter().any(|l| l.starts_with("WARN") && l.contains("spawn-fail-log") && l.contains("failed")),
            "a failed spawn must leave a WARN line naming the session: {lines:?}"
        );
    }

    #[tokio::test]
    async fn missing_cwd_rejected() {
        let state = test_state();
        let r = spawn_session(
            &state,
            StartSessionParams {
                cwd: std::path::PathBuf::from("Z:\\does\\not\\exist"),
                model: "opus".into(),
                effort: "high".into(),
                resume_id: None,
                account_id: None,
                fork: false,
                new_session_id: None,
            },
        )
        .await;
        assert!(matches!(r, Err(LifecycleError::CwdMissing(_))));
        assert_eq!(state.sessions.len(), 0);
    }
}
