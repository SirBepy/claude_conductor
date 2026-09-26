import { sessionEvents } from "../shared/chat/event-store";
import { setSelectedSessionId } from "../views/sessions/permission-modal";
import { openModelEffortModal } from "../views/sessions/model-effort-modal";
import { startNewSession } from "../views/sessions/pending-flow";
import { state as sessionsState } from "../views/sessions/state";
import { updateThinkingBar } from "../views/sessions/session-thinking-bar";
import { renderSidebar } from "../views/sessions/sidebar";
import type { ChatEvent } from "../types/ipc.generated";

/** Call once at boot (main.ts). Installs window-global e2e test seams; see the
 * inline `import.meta.env.DEV` comment below for the strip-from-prod gate. */
export function installE2eSeams(): void {
  // Test seam (ai_todo 53 e2e): in dev only, expose a helper that injects a
  // synthetic file-edit tool_use into a mounted session so the wdio harness can
  // exercise the inline edit-window + changes panel + activity bar WITHOUT a real
  // (billed) claude turn. `import.meta.env.DEV` is true under the vite dev server
  // the e2e harness loads; `vite build` strips this block from production bundles.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__injectEdit = (
      sessionId: string,
      opts: { tool: string; file: string; oldText?: string; newText?: string; content?: string }
    ): void => {
      const input =
        opts.tool === "Write"
          ? { file_path: opts.file, content: opts.content ?? opts.newText ?? "" }
          : { file_path: opts.file, old_string: opts.oldText ?? "", new_string: opts.newText ?? "" };
      const ev: ChatEvent = {
        type: "tool_use",
        tool_name: opts.tool,
        input,
        id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: BigInt(Date.now()),
        parent_tool_use_id: null,
      };
      sessionEvents.pushSynthetic(sessionId, ev);
    };

    // News e2e seam: inject synthetic posts into the news view so the wdio harness
    // can exercise the kebab menu + detail view + cached-summary render WITHOUT a
    // real (billed) claude summary call. The news view listens for this event.
    (window as unknown as Record<string, unknown>).__injectNews = (posts: unknown): void => {
      window.dispatchEvent(new CustomEvent("e2e-inject-news", { detail: posts }));
    };

    // AskUserQuestion e2e seam (ai_todo 16): exercise the question-card relay's
    // FRONTEND hop (Tauri `question-requested` event -> installed listener -> gate
    // -> showQuestionCard) WITHOUT a real claude turn or the daemon. `__injectQuestion`
    // emits the real Tauri event so the actual listener + gate fire; `__setSelectedSession`
    // primes the gate's selected id so a matching question is not parked.
    (window as unknown as Record<string, unknown>).__setSelectedSession = (id: string | null): void => {
      setSelectedSessionId(id);
    };
    (window as unknown as Record<string, unknown>).__injectQuestion = (payload: unknown): void => {
      void window.__TAURI__?.event?.emit?.("question-requested", payload);
    };

    // New-chat modal e2e seam (ai_todo 241): open the model/effort/account modal
    // directly so the view-harness can assert the account picker + "Start session"
    // gating WITHOUT driving the full pickProject flow. The account list comes from
    // the mocked list_accounts command, exactly as it would from the daemon on the
    // phone - so this exercises the frontend half of the mobile account-sharing fix.
    (window as unknown as Record<string, unknown>).__openNewChatModal = (
      projectPath?: string,
      projectName?: string,
    ): Promise<unknown> => openModelEffortModal(projectPath ?? "C:/test/proj", projectName ?? "Test Project");

    // Popup-chain e2e seam: drives the real pickProject() chain without a
    // mounted sessions pane - a scratch element stands in (tests assert
    // mid-chain, never reaching launchNewSession's real pane render).
    (window as unknown as Record<string, unknown>).__startNewSession = (): Promise<void> =>
      startNewSession(document.createElement("div"));

    // Held-messages e2e seam (ai_todo 90): flip a mounted session's busy flag
    // without a real turn, so held/chip/dropdown/Send-now/auto-flush can be
    // driven WITHOUT racing a live claude turn into busy (mirrors sidebar.ts's
    // real busy->idle auto-flush check).
    (window as unknown as Record<string, unknown>).__setBusy = (sessionId: string, busy: boolean): void => {
      const inst = sessionsState.sessions.find((s) => s.session_id === sessionId);
      if (!inst) return;
      inst.busy = busy;
      updateThinkingBar();
      const listEl = document
        .querySelector<HTMLElement>(".view-sessions")
        ?.querySelector<HTMLElement>("#sessions-list");
      if (listEl) renderSidebar(listEl);
      if (!busy && sessionsState.selectedId === sessionId && sessionsState.heldMessages?.hasItemsForActive()) {
        sessionsState.heldMessages.onCompletion(sessionId, inst.awaiting === "question");
      }
    };
  }
}
