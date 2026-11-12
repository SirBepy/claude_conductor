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
  isSubchatsOn,
  setSubchatsOn,
  rerenderSidebar,
} from "./permission-modal";
import {
  loadHiddenSessions,
  saveHiddenSessions,
} from "./sessions-helpers";
import { isRawViewEnabled, setRawViewEnabled } from "../../shared/chat/message-filter-pref";
import { showToast } from "../../shared/toast";
import { state } from "./state";
import { changeCharacterForSession, changeAccountForSession } from "./active-session-account";
import { sendWithFailureRecovery } from "./send-with-failure-recovery";
import { sessionEvents } from "../../shared/chat/event-store";
import { openQuestionCards } from "./permission-modal/dismiss-open-questions";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";

export interface ChatMenuCtx {
  kind: "live" | "draft";
  sessionId: string | null;
  cwd: string | null;
  pid: number | null;
  readOnly: boolean;
  autoAcceptOn: boolean;
  /** "Use subchats" (per-session): the chat hands jobs Joe names to hidden
   *  child chats. Menu-only: no header badge or shortcut. */
  subchatsOn: boolean;
  /** Why the mode cannot be turned ON for this chat (an API-credit account).
   *  Set means the item is disabled while off; turning it off always works. */
  subchatsBlockedReason?: string;
  /** This chat is itself a sub. A sub cannot have subs (depth 1), so "Use subchats"
   *  is not offered: an item that only ever ends in an error alert is not an item. */
  isSub?: boolean;
  /** This sub has a sidebar shortcut (Pin to sidemenu); only read when `isSub`. */
  isPinned?: boolean;
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
  /** True when this chat is hosted on a paired peer machine (multi-machine
   *  federation), never this one. Only gates `buildOpenProjectItems`' VS
   *  Code/Terminal/File Explorer entries below, which launch THIS machine's
   *  own apps against `cwd` - a mirrored chat's cwd is a path on the peer's
   *  disk (G10, docs/multi-machine.md). "View changes" (Code mode) no longer
   *  checks this: its reads now proxy to the owning peer instead.
   *  Always false/undefined for a draft (no Instance yet). */
  mirrored?: boolean;
  viewChanges?: () => void;
  onAfterAction?: () => void;
  onDiscard?: () => void;
}

const NOT_ON_THIS_MACHINE = "Chat is on another machine";

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
  const mirrored = ctx.mirrored === true;
  return [
    {
      icon: "code",
      label: "VS Code",
      run: cwd && !mirrored ? async () => {
        try { await invoke<void>("open_in_vscode", { path: cwd }); }
        catch { /* code may not be installed */ }
      } : undefined,
      disabledReason: !cwd ? "No project directory" : (mirrored ? NOT_ON_THIS_MACHINE : undefined),
    },
    {
      icon: "terminal-window",
      label: "Terminal",
      run: cwd && !mirrored ? async () => {
        try { await invoke<void>("open_terminal_in_directory", { path: cwd }); }
        catch (err) { alert(`Failed to open terminal: ${err}`); }
      } : undefined,
      disabledReason: !cwd ? "No project directory" : (mirrored ? NOT_ON_THIS_MACHINE : undefined),
    },
    {
      icon: "folder-notch-open",
      label: "File Explorer",
      // Desktop-only (opens the host machine's file manager) - meaningless
      // from a phone, so disable rather than let it throw RemoteUnavailableError.
      run: cwd && !isRemote() && !mirrored ? async () => {
        try { await invoke<void>("open_in_explorer", { path: cwd }); }
        catch (err) {
          alert(err instanceof RemoteUnavailableError ? "Not available on this device." : `Failed to open file explorer: ${err}`);
        }
      } : undefined,
      disabledReason: !cwd
        ? "No project directory"
        : (isRemote() ? "Not available on the phone" : (mirrored ? NOT_ON_THIS_MACHINE : undefined)),
    },
    {
      icon: "squares-four",
      label: "Dashboard",
      // A mirrored chat's folder is on the peer, which this daemon's dashboard cannot read.
      run: cwd && !mirrored ? async () => {
        const { openDashboardPage } = await import("./project-dashboard/dashboard-page");
        await openDashboardPage(cwd);
      } : undefined,
      disabledReason: !cwd ? "No project directory" : (mirrored ? NOT_ON_THIS_MACHINE : undefined),
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
    // Rare and deliberate, so it lives here and not on a button: a sub gets a
    // sidebar shortcut (and stays a sub of its main chat), and an ordinary chat can
    // go back under a main chat.
    ctx.isSub
      ? {
          icon: ctx.isPinned ? "push-pin-slash" : "push-pin",
          label: ctx.isPinned ? "Unpin from sidemenu" : "Pin to sidemenu",
          run: isDraft || !sessionId || ctx.mirrored
            ? undefined
            : async () => {
                const { setSubPinned } = await import("./subchat-view");
                await setSubPinned(sessionId, !ctx.isPinned);
              },
          disabledReason: isDraft ? "Not available until the chat starts" : (ctx.mirrored ? NOT_ON_THIS_MACHINE : undefined),
        }
      : {
          icon: "arrow-square-in",
          label: "Move into main chat",
          run: isDraft || !sessionId || ctx.readOnly || ctx.mirrored || ctx.subchatsOn
            ? undefined
            : async () => {
                const { openMoveIntoMain } = await import("./move-into-main");
                await openMoveIntoMain(sessionId);
              },
          disabledReason: isDraft
            ? "Not available until the chat starts"
            : (ctx.readOnly ? "Only available for interactive chats"
              : (ctx.mirrored ? NOT_ON_THIS_MACHINE
                : (ctx.subchatsOn ? "A main chat cannot be a sub. Turn Use subchats off first." : undefined))),
        },
    // Rare and deliberate, so menu only. Also how an old chat picks up new prompt
    // rules, since its prompt is snapshotted until a compaction. The daemon
    // refuses what the menu cannot know (busy, a card open, no usage yet) and
    // answers with the reason. A sub has no such item: depth 1, never compacted.
    ...(ctx.isSub ? [] : [{
      icon: "arrows-in-line-vertical",
      label: "Compact now",
      run: isDraft || !sessionId || !ctx.subchatsOn || ctx.mirrored || isRemote()
        ? undefined
        : async () => {
            try {
              const res = await invoke<{ ok: boolean; error?: string }>("compact_now", { sessionId });
              showToast(res.ok ? "Compacting this chat." : (res.error ?? "Could not compact this chat."));
            } catch (err) {
              showToast(`Could not compact this chat: ${err}`);
            }
            ctx.onAfterAction?.();
          },
      disabledReason: isDraft
        ? "Not available until the chat starts"
        : (!sessionId ? "No session"
          : (!ctx.subchatsOn ? "Only a main chat (Use subchats on) is compacted"
            : (ctx.mirrored ? NOT_ON_THIS_MACHINE
              : (isRemote() ? "Not available on the phone" : undefined)))),
    }]),
    // Rare, so here and not on the card: a question card left waiting with
    // nothing that could answer it is cleared all at once, each one settled as
    // its own Skip would be.
    (() => {
      const open = sessionId && !isDraft ? openQuestionCards(sessionId).length : 0;
      return {
        icon: "broom",
        label: open > 1 ? `Dismiss ${open} open questions` : "Dismiss open question",
        run: open > 0 && sessionId
          ? async () => {
              const { dismissOpenQuestions } = await import("./permission-modal/dismiss-open-questions");
              await dismissOpenQuestions(sessionId);
              ctx.onAfterAction?.();
            }
          : undefined,
        disabledReason: open > 0 ? undefined : (isDraft ? "Not available until the chat starts" : "No question is waiting in this chat"),
      };
    })(),
    {
      icon: "git-diff",
      label: "View changes",
      // Code mode now proxies its reads one hop to a mirrored chat's owning
      // peer machine (G10 in docs/multi-machine.md), so this item
      // is no longer gated on `ctx.mirrored` - only on having a live agent to
      // view changes for, same as before multi-machine existed.
      run: ctx.viewChanges
        ? () => { ctx.viewChanges!(); }
        : undefined,
      disabledReason: !ctx.viewChanges ? (isDraft ? "No active agent" : "Open the chat to view changes") : undefined,
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
    ...(ctx.isSub ? [] : [{
      icon: "tree-structure",
      label: "Use subchats",
      isOn: ctx.subchatsOn,
      checkDot: ctx.subchatsOn,
      run: isDraft || !sessionId || (!ctx.subchatsOn && ctx.subchatsBlockedReason)
        ? undefined
        : async () => {
            const next = !isSubchatsOn(sessionId);
            try {
              await setSubchatsOn(sessionId, next);
            } catch (err) {
              // The daemon is the authority: it refuses what the menu could not
              // know to hide (e.g. an account moved to API credit meanwhile).
              alert(`Could not turn subchats ${next ? "on" : "off"}: ${err}`);
            }
            rerenderSidebar();
          },
      disabledReason: isDraft
        ? "Set on the new-chat screen before the first message"
        : (!sessionId ? "No session" : (ctx.subchatsOn ? undefined : ctx.subchatsBlockedReason)),
    }]),
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
    // Edits the bar of the chat on screen, so a sidebar menu for another row
    // can't offer it. Hidden on the phone, which can't save a layout.
    ...(isRemote() ? [] : [{
      icon: "pencil-simple",
      label: "Edit statusline",
      run: () => { state.statusbar?.beginLayoutEdit(); },
      disabledReason: !state.statusbar || (!isDraft && sessionId !== state.selectedId) ? "Open the chat first" : undefined,
    }]),
  ];
}

// ── Subchats card avatar ─────────────────────────────────────────────────────

/** What the dashboard's Subchats card knows about the sub it opened a menu on. */
export interface SubCardMenuCtx {
  subId: string;
  /** The avatar: the model and effort sliders open beside it. */
  anchor: HTMLElement;
  model: string;
  effort: string;
  /** Not started yet (held behind another sub): no process to pause or stop. */
  queued: boolean;
  finished: boolean;
  busy: boolean;
  frozen: boolean;
  pinned: boolean;
  mirrored: boolean;
  /** Read this sub in place in the main chat's window. */
  open: () => void | Promise<void>;
  /** The newest preview this sub pushed, or null when it has none. */
  latestPreview: () => Promise<string | null>;
  onAfterAction?: () => void;
}

/** The Subchats card's right-click menu (docs/chat-dashboard-design.md): Open,
 *  Open in new window, Latest preview, Pause, Pin or Unpin sidemenu, Stop this
 *  turn, Change model, Change effort, Close. Close sends the sub `/close`. */
export function buildSubCardItems(ctx: SubCardMenuCtx): ItemDesc[] {
  const id = ctx.subId;
  const gone = ctx.mirrored ? NOT_ON_THIS_MACHINE : undefined;
  const noProcess = ctx.queued ? "Not started yet" : undefined;
  return [
    { icon: "arrow-square-out", label: "Open", run: () => ctx.open() },
    {
      icon: "app-window",
      label: "Open in new window",
      run: isRemote() || ctx.mirrored
        ? undefined
        : async () => {
            try { await invoke<void>("detach_window", { sessionId: id }); }
            catch (err) { alert(`Could not open it in a new window: ${err}`); }
          },
      disabledReason: isRemote() ? "Not available on the phone" : gone,
    },
    {
      icon: "monitor-play",
      label: "Latest preview",
      run: async () => {
        const slug = await ctx.latestPreview();
        const { PREVIEW_OPEN_EVENT } = await import("../../shared/chat/chat-preview-card");
        const { showToast } = await import("../../shared/toast");
        if (slug === null) { showToast("This sub has not pushed a preview yet."); return; }
        window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { detail: { slug } }));
      },
    },
    {
      icon: ctx.frozen ? "play-circle" : "pause-circle",
      label: ctx.frozen ? "Resume" : "Pause",
      run: ctx.queued || ctx.mirrored
        ? undefined
        : async () => {
            try { await invoke<void>(ctx.frozen ? "unfreeze_session" : "freeze_session", { sessionId: id }); }
            catch (err) { alert(`Failed to ${ctx.frozen ? "resume" : "pause"} it: ${err}`); }
            ctx.onAfterAction?.();
          },
      disabledReason: noProcess ?? gone,
    },
    {
      icon: ctx.pinned ? "push-pin-slash" : "push-pin",
      label: ctx.pinned ? "Unpin from sidemenu" : "Pin to sidemenu",
      run: ctx.mirrored
        ? undefined
        : async () => {
            const { setSubPinned } = await import("./subchat-view");
            await setSubPinned(id, !ctx.pinned);
            ctx.onAfterAction?.();
          },
      disabledReason: gone,
    },
    {
      icon: "stop-circle",
      label: "Stop this turn",
      run: ctx.busy && !ctx.mirrored
        ? async () => { try { await invoke<void>("cancel_turn", { sessionId: id }); } catch { /* best-effort */ } }
        : undefined,
      disabledReason: ctx.busy ? gone : "Not working right now",
    },
    {
      icon: "robot",
      label: "Change model",
      run: ctx.queued || ctx.mirrored
        ? undefined
        : async () => {
            const { ModelPopover } = await import("./model-popover");
            new ModelPopover().open(ctx.anchor, {
              model: ctx.model,
              sessionId: id,
              onModelChange: undefined,
              onCommit: () => ctx.onAfterAction?.(),
            });
          },
      disabledReason: noProcess ?? gone,
    },
    {
      icon: "gauge",
      label: "Change effort",
      run: ctx.queued || ctx.mirrored
        ? undefined
        : async () => {
            const { EffortPopover } = await import("./effort-popover");
            new EffortPopover().open(ctx.anchor, {
              effort: ctx.effort,
              sessionId: id,
              onEffortChange: null,
              onCommit: () => ctx.onAfterAction?.(),
            });
          },
      disabledReason: noProcess ?? gone,
    },
    {
      icon: "x-circle",
      label: "Close",
      danger: true,
      // /close is the skill that retrospects, persists and ends the job properly;
      // a bare clear would drop the sub's work on the floor.
      run: ctx.queued || ctx.mirrored
        ? undefined
        : async () => {
            const blocks: ContentBlock[] = [{ type: "text", text: "/close" }];
            try { await invoke<void>("send_message", { sessionId: id, cwd: ".", blocks }); }
            catch (err) { alert(`Could not send /close: ${err}`); }
          },
      disabledReason: noProcess ?? gone,
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
