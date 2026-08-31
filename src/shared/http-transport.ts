// Transport for the browser PWA (phone): talks to the daemon's remote-access
// server (REST `/api/rpc` + per-session WebSocket) instead of the Tauri
// runtime. Split out of transport.ts so each transport implementation has its
// own file (ai_todo 93).

import type { Transport, Unlisten } from "./transport";
import {
  GLOBAL_KEBAB_EVENTS,
  addGlobalListener,
  allGlobalListenersEmpty,
  ensureGlobalStream,
  removeGlobalListener,
  teardownGlobalStream,
} from "./global-stream";

/** localStorage key holding the per-device bearer token the user pasted/paired. */
export const REMOTE_TOKEN_KEY = "rc_token";

/** sessionStorage flag set when a stored token was rejected (401) so the token
 *  gate can explain "expired / changed" instead of looking like a first pairing. */
export const REMOTE_TOKEN_EXPIRED_KEY = "rc_token_expired";

/** True once we've reacted to a 401 this page-load, so a burst of concurrent
 *  failing requests (e.g. the 3.5s poll plus a view's fetches) triggers exactly
 *  one token-clear + reload rather than a reload storm. */
let authFailureHandled = false;

/**
 * React to a rejected bearer token (HTTP 401 from the daemon): the stored token
 * is stale or was rotated. Clear it, flag the reason, and reload so the boot
 * path renders the token gate with an "expired" message instead of every view
 * silently showing empty data (which is indistinguishable from "no data").
 * One-shot per page-load; a no-op in non-browser (test) environments.
 */
function handleAuthFailure(): void {
  if (authFailureHandled) return;
  authFailureHandled = true;
  if (typeof window === "undefined" || typeof location === "undefined") return;
  try {
    localStorage.removeItem(REMOTE_TOKEN_KEY);
    sessionStorage.setItem(REMOTE_TOKEN_EXPIRED_KEY, "1");
  } catch {
    /* storage unavailable - the reload still drops us at the gate */
  }
  location.reload();
}

export function remoteToken(): string {
  try {
    return localStorage.getItem(REMOTE_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Thrown when a frontend command has no remote (phone) equivalent. Callers that
 *  already tolerate failure (e.g. event-store's loadInitial catch) degrade
 *  gracefully; surfaced ones show a clear "not available on the phone" message. */
export class RemoteUnavailableError extends Error {
  constructor(command: string) {
    super(`"${command}" is not available on the remote (phone) client`);
    this.name = "RemoteUnavailableError";
  }
}

/**
 * Transport for the browser PWA: talks to the daemon's remote-access server
 * (REST `/api/rpc` + per-session WebSocket) instead of the Tauri runtime.
 * Same-origin with the served SPA, so requests use relative paths; the bearer
 * token is read from localStorage on each call (browsers can't set the
 * Authorization header on a WS handshake, so the WS carries it as `?token=`).
 *
 * Frontend command names are NOT 1:1 with daemon RPC methods, and some Tauri
 * commands orchestrate multiple daemon calls + app-process logic (ai_todo 105
 * CRUX). So `call` routes through an explicit mapping table: most commands
 * forward to the allowlisted `/api/rpc` with reshaped params, `send_message`
 * uses its dedicated REST endpoint, and app-process-only commands degrade with
 * RemoteUnavailableError. (start_session / history are pending backend work -
 * tasks #2/#4; until then opening an EXISTING session + sending is the path.)
 */
export class HttpTransport implements Transport {
  // Session ids the daemon will NOT live-stream: external + automated sessions
  // aren't in the daemon's hosted-session registry, so `GET /stream` 404s for
  // them. Opening a WS there just 404-loops forever via the onclose backoff
  // (their content loads via load_history_page instead). Populated from every
  // list_instances result; "known non-streamable" semantics so a live session
  // we haven't polled yet still opens its WS (no live-stream regression).
  private nonStreamable = new Set<string>();

  private noteStreamability(instances: unknown): void {
    if (!Array.isArray(instances)) return;
    for (const inst of instances) {
      const rec = inst as { session_id?: unknown; kind?: unknown };
      if (typeof rec.session_id !== "string") continue;
      if (rec.kind === "external" || rec.kind === "automated") {
        this.nonStreamable.add(rec.session_id);
      } else {
        // interactive (or took-over external -> interactive): it can stream now.
        this.nonStreamable.delete(rec.session_id);
      }
    }
  }

  async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (command) {
      case "list_instances": {
        const instances = await this.rpc<unknown>("list_instances", null);
        this.noteStreamability(instances);
        return instances as T;
      }
      case "list_pending_prompts":
        return this.rpc<T>("list_pending_prompts", null);
      case "list_characters":
        return this.rpc<T>("list_characters", null);
      case "list_accounts":
        return this.rpc<T>("list_accounts", null);
      case "list_project_groups":
        return this.rpc<T>("list_project_groups", null);
      // Worktree picker (ai_todo 434): mirrors the desktop `ipc::worktrees`
      // Tauri commands so the phone picker isn't silently empty/dead.
      case "list_worktree_details":
        return this.rpc<T>("list_worktree_details", { repo_path: args.repoPath ?? args.repo_path });
      case "create_worktree":
        return this.rpc<T>("create_worktree", {
          repo_path: args.repoPath ?? args.repo_path,
          branch_name: args.branchName ?? args.branch_name,
          worktree_name: args.worktreeName ?? args.worktree_name ?? null,
          base_branch: args.baseBranch ?? args.base_branch ?? null,
        });
      case "remove_worktree":
        return this.rpc<T>("remove_worktree", {
          repo_path: args.repoPath ?? args.repo_path,
          worktree_path: args.worktreePath ?? args.worktree_path,
          force: args.force ?? false,
        });
      case "get_recent_branches":
        return this.rpc<T>("get_recent_branches", { cwd: args.cwd });
      // PR-review Commits/Files browsing (ai_todo 244): mirrors desktop's
      // `ipc::git_diff` Tauri commands. Daemon rejects an unrecognized cwd.
      case "get_range_files":
        return this.rpc<T>("get_range_files", { cwd: args.cwd, from: args.from ?? null, to: args.to });
      case "get_file_diff":
        return this.rpc<T>("get_file_diff", {
          cwd: args.cwd,
          from: args.from ?? null,
          to: args.to,
          path: args.path,
        });
      // Session-statusbar git/servers chips + location-picker scan (mirrors
      // desktop's `ipc::git` / `ipc::servers` / `ipc::claude_scopes`
      // commands). Missing here was the confirmed root cause of the phone's
      // forever-loading chips and the modal's raw exception string.
      case "get_git_info":
        return this.rpc<T>("get_git_info", { cwd: args.cwd });
      case "get_git_dirty":
        return this.rpc<T>("get_git_dirty", { cwd: args.cwd });
      case "get_commit_sync":
        return this.rpc<T>("get_commit_sync", { cwd: args.cwd });
      case "list_project_servers":
        return this.rpc<T>("list_project_servers", { cwd: args.cwd });
      case "list_claude_md_scopes":
        return this.rpc<T>("list_claude_md_scopes", {
          worktree_path: args.worktreePath ?? args.worktree_path,
        });
      case "start_session": {
        // Daemon expects snake_case; tolerate camelCase from callers (matches
        // the set_session_effort normalization pattern above). Params forwarded
        // mirror the desktop call site in pending-pane.ts.
        //
        // Two differences from the desktop Tauri IPC path:
        // 1. The daemon RPC returns {session_id: "uuid"}, not the bare string
        //    the desktop IPC handler returns. Extract it so callers get a string.
        // 2. The daemon RPC StartSessionParams has no `prompt` field (dropped at
        //    deserialization). Send the first turn via a follow-up send_message
        //    call, mirroring what run.rs::start_session_daemon does on desktop.
        const spawnResult = await this.rpc<{ session_id: string }>("start_session", {
          cwd: args.cwd,
          model: args.model,
          effort: args.effort,
          remote: args.remote,
          placeholder_id: args.placeholderId ?? args.placeholder_id,
          account_id: args.accountId ?? args.account_id ?? null,
          // Must land in this same RPC (not a follow-up set_auto_accept call):
          // the send_message below fires immediately after this resolves, with
          // no wait for the "session_started" WS event that would otherwise
          // drive that follow-up call - see pending-pane.ts's autoAccept comment.
          auto_accept: (args.autoAccept ?? args.auto_accept) !== false,
        });
        const sid = spawnResult.session_id;
        const promptText = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (promptText) {
          await this.rpc<unknown>("send_message", { session_id: sid, text: promptText });
        }
        return sid as unknown as T;
      }
      case "set_session_effort":
        return this.rpc<T>("set_session_effort", {
          session_id: args.session_id ?? args.sessionId,
          effort: args.effort,
        });
      case "set_session_model":
        return this.rpc<T>("set_session_model", {
          session_id: args.session_id ?? args.sessionId,
          model: args.model,
        });
      case "set_auto_accept":
        return this.rpc<T>("set_auto_accept", {
          session_id: args.session_id ?? args.sessionId,
          value: args.value,
        });
      case "list_auto_accept":
        return this.rpc<T>("list_auto_accept", null);
      case "cancel_turn":
        return this.rpc<T>("cancel_turn", {
          session_id: args.sessionId ?? args.session_id,
        });
      case "respond_permission":
        return this.rpc<T>("respond_permission", {
          request_id: args.id,
          allow: args.behavior === "allow",
          updated_input: args.updatedInput,
          message: args.message,
        });
      // Unwrapped to a bare bool, matching the Tauri command's `Result<bool>`:
      // the daemon router answers `{ok, delivered}`, and the caller treats any
      // truthy value as "already delivered in-band" and drops its own answer
      // message (permission-modal/index.ts) - so the raw object loses answers.
      case "respond_question": {
        const res = await this.rpc<{ delivered?: boolean } | boolean | null>("respond_question", {
          request_id: args.id,
          answers: args.answers,
          skipped: args.skipped ?? false,
        });
        const delivered = typeof res === "object" && res !== null ? res.delivered === true : res === true;
        return delivered as T;
      }
      case "get_skipped_question_marks":
        return this.rpc<T>("get_skipped_question_marks", {
          session_id: args.sessionId ?? args.session_id,
        });
      case "send_message":
        return this.sendMessage<T>(args);
      // Cross-surface draft sync (composer/AUQ/held messages): one round trip
      // reconciles everything, the rest are debounced writes - see
      // shared/chat/session-draft-sync.ts, the frontend-side callers.
      case "get_session_drafts":
        return this.rpc<T>("get_session_drafts", { session_id: args.sessionId ?? args.session_id });
      case "set_composer_draft":
        return this.rpc<T>("set_composer_draft", { session_id: args.sessionId ?? args.session_id, text: args.text });
      case "clear_composer_draft":
        return this.rpc<T>("clear_composer_draft", { session_id: args.sessionId ?? args.session_id });
      case "set_auq_draft":
        return this.rpc<T>("set_auq_draft", {
          session_id: args.sessionId ?? args.session_id,
          prompt_id: args.promptId ?? args.prompt_id,
          payload: args.payload,
        });
      case "clear_auq_draft":
        return this.rpc<T>("clear_auq_draft", {
          session_id: args.sessionId ?? args.session_id,
          prompt_id: args.promptId ?? args.prompt_id,
        });
      case "add_held_message":
        return this.rpc<T>("add_held_message", { session_id: args.sessionId ?? args.session_id, blocks: args.blocks });
      case "update_held_message":
        return this.rpc<T>("update_held_message", {
          session_id: args.sessionId ?? args.session_id,
          id: args.id,
          blocks: args.blocks,
        });
      case "remove_held_message":
        return this.rpc<T>("remove_held_message", { session_id: args.sessionId ?? args.session_id, id: args.id });
      case "clear_held_messages":
        return this.rpc<T>("clear_held_messages", { session_id: args.sessionId ?? args.session_id });
      case "load_history_page":
        return this.rpc<T>("load_history_page", {
          session_id: args.sessionId ?? args.session_id,
          cwd: args.cwd ?? null,
          before_seq: args.beforeSeq ?? args.before_seq ?? null,
          message_limit: args.messageLimit ?? args.message_limit ?? 20,
        });
      case "load_event_detail":
        return this.rpc<T>("load_event_detail", {
          session_id: args.sessionId ?? args.session_id,
          cwd: args.cwd ?? null,
          seq: args.seq,
          tool_use_id: args.toolUseId ?? args.tool_use_id,
        });
      // Past-session browsing for the phone History view (mirrors desktop's
      // `list_history` / `load_history` Tauri commands - see daemon RPC
      // handlers in daemon/methods/history.rs).
      case "list_history":
        return this.rpc<T>("list_history", {
          project_id: args.projectId ?? args.project_id ?? null,
          search: args.search ?? null,
          limit: args.limit ?? 200,
          offset: args.offset ?? 0,
          model_filter: args.modelFilter ?? args.model_filter ?? null,
          date_from: args.dateFrom ?? args.date_from ?? null,
          date_to: args.dateTo ?? args.date_to ?? null,
        });
      case "load_history":
        return this.rpc<T>("load_history", {
          session_id: args.sessionId ?? args.session_id,
          cwd: args.cwd ?? null,
        });
      // History view's "Continue this chat": re-registers an ended session as
      // Interactive so Sessions can find it (mirrors desktop's
      // `register_historical_session` Tauri command / daemon RPC
      // `register_historical`).
      case "register_historical_session":
        return this.rpc<T>("register_historical", {
          session_id: args.sessionId ?? args.session_id,
          cwd: args.cwd,
          account_id: args.accountId ?? args.account_id,
        });
      case "character_asset_url":
        return this.rpc<T>("character_asset_url", {
          character_id: args.characterId ?? args.character_id,
          file: args.file,
        });
      // Resolves the voiceline data URL for a `turn_sound` event so the phone
      // can mirror the same clip the desktop app just played natively.
      case "resolve_voiceline":
        return this.rpc<T>("resolve_voiceline", {
          session_id: args.sessionId ?? args.session_id ?? null,
          cwd: args.cwd ?? null,
          awaiting: args.awaiting,
        });
      case "read_attachment":
        // Pasted chat-image attachments. The daemon path-validates against the
        // chat-attachments dir, so a malicious path can't read arbitrary files.
        return this.rpc<T>("read_attachment", { path: args.path });
      case "paste_attachment":
        // Composer paperclip upload from the phone: the daemon writes the bytes
        // into <app-data>/chat-attachments/<session>/ and returns the PC-side
        // path, which the composer turns into a <file:...> mention on send.
        return this.rpc<T>("paste_attachment", {
          session_id: args.sessionId ?? args.session_id,
          base64_data: args.base64Data ?? args.base64_data,
          mime: args.mime,
        });
      case "resolve_whitelist_characters":
        return this.rpc<T>("resolve_whitelist_characters", {
          project_id: args.projectId ?? args.project_id,
        });
      case "list_session_characters":
        // Per-session character map { session_id: character_id }; drives the
        // sidebar + chat-header avatars. Without it every row shows the "?"
        // placeholder on the phone.
        return this.rpc<T>("list_session_characters", null);
      case "ensure_session_character":
        // Assigns a character to a freshly-started session. Without this the
        // Tauri-only command had no remote mirror, so a remote-created chat
        // never got a sidebar avatar (silently swallowed by the caller's
        // `.catch(() => null)`).
        return this.rpc<T>("ensure_session_character", {
          session_id: args.sessionId ?? args.session_id,
        });
      case "list_projects":
        return this.rpc<T>("list_projects", {});
      case "project_last_activity_at":
        return this.rpc<T>("project_last_activity_at", {
          cwd: args.cwd,
        });
      case "resolve_project_account":
        return this.rpc<T>("resolve_project_account", {
          cwd: args.cwd,
        });
      case "get_project_tech":
        return this.rpc<T>("get_project_tech", {
          root: args.root,
        });
      case "get_project_icon":
        return this.rpc<T>("get_project_icon", {
          root: args.root,
        });
      // Usage + token history: served from the daemon's shared companion.db so
      // the phone homescreen + statistics populate (the daemon is the writer).
      case "get_history":
        return this.rpc<T>("get_history", { limit: args.limit ?? null });
      case "get_token_history":
        // `since` (unix seconds) bounds the window. Unbounded here used to be
        // a 100MB response on this dev's machine - see boot.ts's window.
        return this.rpc<T>("get_token_history", { since: args.since ?? 0 });
      case "get_active_sessions":
        return this.rpc<T>("get_active_sessions", null);
      // Per-account current-usage-percentage + login-state maps for the phone
      // Dashboard (mirrors desktop's `get_usage_map` / `get_auth_state_map`
      // Tauri commands). No params. See the daemon RPC handlers in
      // daemon/methods/registry.rs for how each is derived cross-process.
      case "get_usage_map":
        return this.rpc<T>("get_usage_map", null);
      case "get_auth_state_map":
        return this.rpc<T>("get_auth_state_map", null);
      // Click-to-refresh usage dials (api.refreshUsageLive on the remote
      // branch): asks the daemon to forward a live-poll request to the
      // connected desktop app and wait for a fresh snapshot - see
      // daemon/methods/usage.rs's `request_live_usage_refresh` handler.
      case "request_live_usage_refresh":
        return this.rpc<T>("request_live_usage_refresh", { account_id: args.accountId ?? null });
      // Transcript-derived context-window status (mirrors desktop's
      // `context_status` Tauri command). Without this the phone had no way to
      // reach the daemon's authoritative computation and silently fell back
      // to a frontend heuristic - see session-statusbar.ts's renderContext.
      case "context_status":
        return this.rpc<T>("context_status", {
          session_id: args.sessionId ?? args.session_id,
        });
      case "get_settings":
        return this.rpc<T>("get_settings", null);
      case "list_slash_commands":
        // Read-only filesystem scan for the `/` autocomplete popup; the daemon
        // runs on the same PC and can read the same disk as desktop.
        return this.rpc<T>("list_slash_commands", {
          project_dir: args.projectDir ?? args.project_dir,
        });
      // Scheduled-items list (ai_todo 257) + mutators (ai_todo 259). The
      // mutators are exposed on remote because they're strictly weaker than
      // start_session/send_message, which the phone already has - see the
      // SAFE_METHODS comment in remote_handlers.rs. Param shapes mirror the
      // daemon RPC handlers in daemon/methods/schedule.rs (camelCase fireAt
      // from the composer is normalized to the fire_at the RPC expects).
      case "schedule_list":
        return this.rpc<T>("schedule_list", null);
      case "schedule_create":
        return this.rpc<T>("schedule_create", {
          kind: args.kind,
          prompt: args.prompt,
          fire_at: args.fireAt ?? args.fire_at,
          recurrence: args.recurrence ?? null,
        });
      case "schedule_update":
        // Daemon RPC deserializes the params directly as a ScheduledItem (no
        // { item } envelope, unlike the desktop Tauri command).
        return this.rpc<T>("schedule_update", args.item);
      case "schedule_delete":
        return this.rpc<T>("schedule_delete", { id: args.id });
      case "schedule_fire_now":
        return this.rpc<T>("schedule_fire_now", { id: args.id });
      // Read-only HTML preview store (ai_todo 138), phone-ready by design: same
      // allowlisted RPCs the desktop panel already calls, just routed through
      // /api/rpc instead of Tauri invoke.
      case "list_previews":
        return this.rpc<T>("list_previews", null);
      case "get_preview":
        return this.rpc<T>("get_preview", { id: args.id });
      // Iframe render (todo 715): same-origin URL, no CSP change needed -
      // see remote_preview_render.rs.
      case "render_preview_doc":
        return this.renderPreviewDoc<T>(args);
      // Close-chat: mirrors desktop's `ipc::clear_session` (builtins.rs).
      // `end_session` kills the underlying `claude` process for daemon-hosted
      // (interactive) sessions and marks the registry entry ended in one RPC;
      // it 404s for sessions the daemon's SessionMap doesn't know about (e.g.
      // External), so that failure is swallowed and `mark_session_ended` runs
      // regardless to clear the sidebar row either way.
      case "clear_session": {
        const sessionId = args.sessionId ?? args.session_id;
        try {
          await this.rpc<unknown>("end_session", { session_id: sessionId });
        } catch {
          /* not daemon-hosted (e.g. External) - fall through to registry cleanup */
        }
        return this.rpc<T>("mark_session_ended", { session_id: sessionId });
      }
      // No remote path: poll_now (a CDP scrape needing Chrome), takeover,
      // editor/window/local-FS commands, and file watchers. Degrade clearly.
      default:
        throw new RemoteUnavailableError(command);
    }
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    // ── Global live-state stream ──────────────────────────────────────────────
    // The desktop fires a Tauri event whenever the session registry (or the
    // schedule, etc.) mutates. On the phone there is no Tauri event bus, so
    // these fan out through the singleton `/api/global/stream` WebSocket
    // above instead, with a poll degrade path while it's down/stale.
    if (GLOBAL_KEBAB_EVENTS.has(event)) {
      const globalCb = cb as (payload: unknown) => void;
      addGlobalListener(event, globalCb);
      ensureGlobalStream(this);
      if (event === "instances-changed") {
        // Fire once immediately so the session list populates without
        // waiting for the first WS frame / poll tick (pre-WS behavior).
        this.call<unknown>("list_instances")
          .then(() => { cb(undefined as unknown as T); })
          .catch(() => { /* network blip - the WS snapshot frame will catch up */ });
      }
      return () => {
        removeGlobalListener(event, globalCb);
        if (allGlobalListenersEmpty()) teardownGlobalStream();
      };
    }

    const chat = /^chat:(.+)$/.exec(event);
    const id = chat?.[1];
    if (!id || typeof WebSocket === "undefined" || typeof location === "undefined") {
      // No per-session channel (chat-watch:<id> is redundant on the phone since
      // the WS already carries the turn; global channels have no global WS yet,
      // task #5), or no browser WS/location in this environment (node tests).
      // A real browser always has both; degrade to no-op otherwise.
      return () => {};
    }
    if (this.nonStreamable.has(id)) {
      // A read-only / external session has no daemon broadcast; the WS would
      // 404 and the onclose backoff would retry it forever (console-noisy,
      // battery/network drain). Its transcript already loaded via
      // load_history_page, so there is nothing live to attach to.
      return () => {};
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${location.host}/api/sessions/${encodeURIComponent(id)}` +
      `/stream?token=${encodeURIComponent(remoteToken())}`;
    let stopped = false;
    let ws: WebSocket;
    let retryDelay = 1000;

    const connect = (): void => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onmessage = (e: MessageEvent) => {
        try {
          cb(JSON.parse(e.data as string) as T);
        } catch {
          /* ignore non-JSON frames */
        }
      };
      ws.onopen = () => { retryDelay = 1000; };
      ws.onclose = () => {
        // Mobile connections drop frequently (network handoff, screen sleep).
        // Reconnect with capped exponential backoff unless unlisten() was called.
        if (stopped) return;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };
    connect();

    return () => {
      if (stopped) return;
      stopped = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  /** Stages `args.html` on the daemon and returns a same-origin iframe-src
   *  URL. The token rides the query string (an `<iframe src>` navigation
   *  can't set an Authorization header), same pattern as the WS `?token=`. */
  private async renderPreviewDoc<T>(args: Record<string, unknown>): Promise<T> {
    const res = await fetch("/api/preview-render", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ html: args.html }),
    });
    if (res.status === 401) handleAuthFailure();
    if (!res.ok) throw new Error(`render_preview_doc failed: ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    const url = `/api/preview-render/${encodeURIComponent(id)}?token=${encodeURIComponent(remoteToken())}`;
    return url as unknown as T;
  }

  private async sendMessage<T>(args: Record<string, unknown>): Promise<T> {
    const sessionId = String(args.sessionId ?? args.session_id ?? "");
    const blocks =
      (args.blocks as { type: string; text?: string }[] | undefined) ?? [];
    // The daemon send endpoint takes plain text; image blocks have no remote
    // path yet (degrade to text-only, matching the desktop's disk-path flow).
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) handleAuthFailure();
    if (!res.ok) throw new Error(`send failed: ${res.status}`);
    return sessionId as unknown as T;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ method, params }),
    });
    if (res.status === 401) handleAuthFailure();
    if (!res.ok) {
      // Daemon RPC errors (e.g. request_live_usage_refresh's "desktop app is
      // not running") come back as a JSON-RPC error body - surface its
      // message instead of just the bare HTTP status so a caller can show the
      // dev something actionable. `try/catch` (not `.catch()` on the call)
      // because a non-JSON error page has no `.json` method at all, which
      // throws synchronously before a promise exists to attach `.catch` to.
      let message: string | undefined;
      try {
        const detail = (await res.json()) as { message?: string } | null;
        message = detail?.message;
      } catch {
        /* body isn't JSON (proxy error page, empty response, etc.) */
      }
      throw new Error(message || `rpc ${method} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${remoteToken()}`,
      "Content-Type": "application/json",
    };
  }
}
