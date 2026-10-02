// Item-list builders for the four "This chat" submenus (chat-menu.ts).
// Split out because chat-menu.ts's DOM/submenu wiring plus all four lists
// crossed the view-file line budget (todo 972). Each builder takes the same
// ChatMenuCtx and derives its own locals - no state is shared across builders,
// so this split needed no closure threading back into chat-menu.ts.

import { invoke } from "../../shared/ipc";
import { RemoteUnavailableError } from "../../shared/http-transport";
import { isRemote } from "../../shared/transport";
import {
  isAutoAccept,
  setAutoAccept,
  autoAcceptParked,
} from "./permission-modal";
import {
  loadHiddenSessions,
  saveHiddenSessions,
} from "./sessions-helpers";
import { isRawViewEnabled, setRawViewEnabled } from "../../shared/chat/message-filter-pref";
import { state } from "./state";
import { changeCharacterForSession, changeAccountForSession } from "./active-session-account";
import { sendWithFailureRecovery } from "./send-with-failure-recovery";
import { sessionEvents } from "../../shared/chat/event-store";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";

export interface ChatMenuCtx {
  kind: "live" | "draft";
  sessionId: string | null;
  cwd: string | null;
  pid: number | null;
  readOnly: boolean;
  autoAcceptOn: boolean;
  isHidden: boolean;
  /** Jarvis-flagged sessions always auto-accept (Part A) - the toggle is
   *  disabled for them so flipping it off can't silently stall the fleet. */
  isJarvis?: boolean;
  /** Daemon-authoritative frozen flag (`Instance.frozen`). Freeze/Unfreeze is
   *  only offered for Interactive sessions - callers gate that via `readOnly`
   *  (true for external/automated), same as every other agent-only action. */
  isFrozen?: boolean;
  /** Cache read from deploy-workflow-gate.ts, keyed off `cwd`. Undefined (not
   *  checked yet) or true -> Deploy stays enabled; false -> disabled with a
   *  tooltip, same pattern as every other gated item in this submenu. Always
   *  undefined on the phone, which has no route to the file check. */
  hasDeployWorkflow?: boolean;
  viewChanges?: () => void;
  onAfterAction?: () => void;
  onDiscard?: () => void;
}

export interface ItemDesc {
  icon: string;
  label: string;
  run?: () => void | Promise<void>;
  disabledReason?: string;
  danger?: boolean;
  checkDot?: boolean;
  isOn?: boolean;
}

// ── Open project in ▸ ────────────────────────────────────────────────────────

export function buildOpenProjectItems(ctx: ChatMenuCtx): ItemDesc[] {
  const cwd = ctx.cwd;
  return [
    {
      icon: "code",
      label: "VS Code",
      run: cwd ? async () => {
        try { await invoke<void>("open_in_vscode", { path: cwd }); }
        catch { /* code may not be installed */ }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
    {
      icon: "terminal-window",
      label: "Terminal",
      run: cwd ? async () => {
        try { await invoke<void>("open_terminal_in_directory", { path: cwd }); }
        catch (err) { alert(`Failed to open terminal: ${err}`); }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
    {
      icon: "folder-notch-open",
      label: "File Explorer",
      // Desktop-only (opens the host machine's file manager) - meaningless
      // from a phone, so disable rather than let it throw RemoteUnavailableError.
      run: cwd && !isRemote() ? async () => {
        try { await invoke<void>("open_in_explorer", { path: cwd }); }
        catch (err) {
          alert(err instanceof RemoteUnavailableError ? "Not available on this device." : `Failed to open file explorer: ${err}`);
        }
      } : undefined,
      disabledReason: !cwd ? "No project directory" : (isRemote() ? "Not available on the phone" : undefined),
    },
    {
      icon: "squares-four",
      label: "Dashboard",
      run: cwd ? async () => {
        try { await invoke<void>("open_dashboard_project", { cwd }); }
        catch (e) { console.error("[chat-menu] open_dashboard_project failed", e); }
      } : undefined,
      disabledReason: cwd ? undefined : "No project directory",
    },
  ];
}

// ── Chat ▸ ────────────────────────────────────────────────────────────────────

export function buildChatItems(ctx: ChatMenuCtx): ItemDesc[] {
  const isDraft = ctx.kind === "draft";
  const sessionId = ctx.sessionId;
  const isHidden = ctx.isHidden;
  return [
    {
      icon: isHidden ? "eye" : "eye-slash",
      label: isHidden ? "Unhide chat" : "Hide chat",
      run: isDraft || !sessionId
        ? undefined
        : () => {
            const hidden = loadHiddenSessions();
            if (isHidden) hidden.delete(sessionId);
            else hidden.add(sessionId);
            saveHiddenSessions(hidden);
            ctx.onAfterAction?.();
          },
      disabledReason: isDraft ? "Not available until the chat starts" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: "terminal-window",
      label: "Move to terminal",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            try { await invoke<void>("open_session_in_terminal", { sessionId }); }
            catch (err) { alert(`Failed to open terminal: ${err}`); }
          },
      disabledReason: isDraft ? "No active agent" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: ctx.isFrozen ? "play-circle" : "snowflake",
      label: ctx.isFrozen ? "Unfreeze chat" : "Freeze chat",
      run: isDraft || !sessionId || ctx.readOnly
        ? undefined
        : async () => {
            try {
              await invoke<void>(ctx.isFrozen ? "unfreeze_session" : "freeze_session", { sessionId });
              // Manual freeze also parks the row in Hidden; unfreeze restores it.
              // Auto-freeze never reaches this branch - see sessionSegment.
              const hidden = loadHiddenSessions();
              if (ctx.isFrozen) hidden.delete(sessionId);
              else hidden.add(sessionId);
              saveHiddenSessions(hidden);
            } catch (err) {
              alert(`Failed to ${ctx.isFrozen ? "unfreeze" : "freeze"} chat: ${err}`);
            }
            ctx.onAfterAction?.();
          },
      disabledReason: isDraft
        ? "Not available until the chat starts"
        : (!sessionId ? "No session" : (ctx.readOnly ? "Only available for interactive chats" : undefined)),
    },
    {
      icon: "git-diff",
      label: "View changes",
      run: ctx.viewChanges
        ? () => { ctx.viewChanges!(); }
        : undefined,
      disabledReason: !ctx.viewChanges
        ? (isDraft ? "No active agent" : "Open the chat to view changes")
        : undefined,
    },
  ];
}

// ── Configure items (merged into Chat) ─────────────────────────────────────────

export function buildConfigureItems(ctx: ChatMenuCtx): ItemDesc[] {
  const isDraft = ctx.kind === "draft";
  const sessionId = ctx.sessionId;
  const autoOn = ctx.autoAcceptOn;
  return [
    {
      icon: "shield-check",
      label: "Auto-accept",
      isOn: autoOn,
      checkDot: autoOn,
      run: isDraft || !sessionId || ctx.isJarvis
        ? undefined
        : () => {
            const next = !isAutoAccept(sessionId);
            setAutoAccept(sessionId, next);
            if (next) autoAcceptParked(sessionId);
          },
      disabledReason: isDraft
        ? "Available once the chat starts"
        : (!sessionId ? "No session" : (ctx.isJarvis ? "Jarvis always auto-accepts" : undefined)),
    },
    {
      icon: "eye",
      label: "Show raw activity",
      isOn: !isDraft && !!sessionId && isRawViewEnabled(sessionId),
      checkDot: !isDraft && !!sessionId && isRawViewEnabled(sessionId),
      run: isDraft || !sessionId
        ? undefined
        : () => {
            const next = !isRawViewEnabled(sessionId);
            setRawViewEnabled(sessionId, next);
            if (state.renderer && state.renderer.sessionId === sessionId) {
              state.renderer.container.classList.toggle("show-raw-chat", next);
            }
          },
      disabledReason: isDraft ? "Available once the chat starts" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: "user-switch",
      label: "Change character",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            const { headerStatusClass } = await import("./active-session");
            await changeCharacterForSession(sessionId, headerStatusClass);
          },
      disabledReason: isDraft ? "Available once the chat starts" : (!sessionId ? "No session" : undefined),
    },
    {
      icon: "user-circle",
      label: "Change account",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            const { selectSession } = await import("./active-session");
            await changeAccountForSession(sessionId, selectSession);
          },
      disabledReason: isDraft ? "Available once the chat starts" : (!sessionId ? "No session" : undefined),
    },
  ];
}

// ── Agent ▸ ───────────────────────────────────────────────────────────────────

export function buildAgentItems(ctx: ChatMenuCtx): ItemDesc[] {
  const isDraft = ctx.kind === "draft";
  const sessionId = ctx.sessionId;
  const cwd = ctx.cwd;
  const items: ItemDesc[] = [
    {
      icon: "copy",
      label: "Copy PID",
      run: ctx.pid
        ? () => { void navigator.clipboard.writeText(String(ctx.pid)); }
        : undefined,
      disabledReason: !ctx.pid ? (isDraft ? "No active agent" : "No active agent") : undefined,
    },
    {
      icon: "arrow-square-out",
      label: "Detach",
      run: isDraft || !sessionId
        ? undefined
        : async () => {
            try { await invoke<void>("detach_window", { sessionId }); }
            catch (err) { console.warn("[chat-menu] detach_window unavailable", err); }
          },
      disabledReason: isDraft ? "No active agent" : (!sessionId ? "No session" : undefined),
    },
  ];

  const gatedOff = ctx.hasDeployWorkflow === false;
  items.push({
      // Injects the literal `/deploy` (never `/deploy go`) - the skill's own
      // step 2 shows the repo/branch/sha/subject and asks to confirm before
      // it does anything, so the confirmation lives there, with more context
      // than a menu item could show, not duplicated here.
      icon: "rocket-launch",
      label: "Deploy",
      run: isDraft || !sessionId || ctx.readOnly || gatedOff
        ? undefined
        : async () => {
            const blocks: ContentBlock[] = [{ type: "text", text: "/deploy" }];
            const optimisticEvent = {
              type: "user_message",
              content: blocks,
              timestamp: BigInt(Date.now()),
            } as ChatEvent;
            sessionEvents.pushSynthetic(sessionId, optimisticEvent);
            await sendWithFailureRecovery(sessionId, String(cwd ?? "."), blocks, optimisticEvent);
          },
      disabledReason: isDraft
        ? "No active agent"
        : (!sessionId ? "No session" : (ctx.readOnly ? "Only available for interactive chats" :
            (gatedOff ? "No .github/workflows/deploy.yml in this repo" : undefined))),
  });

  return items;
}
