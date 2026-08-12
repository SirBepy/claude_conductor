// Reply composer docked at the preview panel's bottom (todo 614 split out of
// preview-panel.ts) - same deps-object pattern as preview-panel-history.ts.
// Owns the shared typing core (popup/highlight/auto-resize) end to end,
// including its destroy-safe teardown - see project_composer_core_shared_typing.

import { invoke } from "../../shared/ipc";
import type { ChatEvent, ContentBlock, PreviewSnapshot } from "../../types/ipc.generated";
import { ComposerCore } from "../../shared/chat/composer-core/core";
import { SlashProvider } from "../../shared/chat/caret-popup/providers/slash";
import type { SuggestProvider } from "../../shared/chat/caret-popup/types";
import { sessionEvents } from "../../shared/chat/event-store";
import { showToast } from "../../shared/toast";
import { isCurrentSessionBusy } from "./session-thinking-bar";
import { state } from "./state";

export interface PvComposerDeps {
  getSelected: () => PreviewSnapshot | null;
}

export interface PvComposerHandle {
  destroy(): void;
}

/** Mounts the shared composer core onto the panel's `.pv-composer-input` and
 *  wires Enter/click to `sendPvReply`. Returns a handle whose `destroy` must
 *  be called from the panel's own `destroy()` - dropping it leaks a live
 *  composer per panel mount. */
export function mountPvComposer(root: HTMLElement, deps: PvComposerDeps): PvComposerHandle {
  const ta = root.querySelector<HTMLTextAreaElement>(".pv-composer-input");
  const highlightEl = root.querySelector<HTMLElement>(".pv-composer .composer-highlight");
  const sendBtn = root.querySelector<HTMLButtonElement>(".pv-composer-send");
  let composerCore: ComposerCore | null = null;
  let composerSlash: SlashProvider | null = null;
  if (!ta) return { destroy: () => {} };

  composerSlash = new SlashProvider();
  // No single cwd concept for this panel (it's scoped by session, not a
  // project directory) - null still surfaces user/builtin skills, same as
  // Composer's own SlashProvider.start(null) fallback.
  void composerSlash.start(null);
  composerCore = new ComposerCore({
    textarea: ta,
    highlightEl,
    providers: [composerSlash] as unknown as SuggestProvider<unknown>[],
    onInput: () => {
      if (sendBtn) sendBtn.disabled = ta.value.trim().length === 0;
    },
    onEnter: () => void sendPvReply(root, deps, composerCore),
  });
  sendBtn?.addEventListener("click", () => void sendPvReply(root, deps, composerCore));

  return {
    destroy: () => {
      composerCore?.destroy();
      composerCore = null;
      composerSlash?.stop();
      composerSlash = null;
    },
  };
}

/** Sends the composer's draft to whichever session pushed the current
 *  snapshot, tagged with a reference to it. Busy/held semantics reuse the
 *  SAME state.heldMessages controller the main composer uses - not
 *  reimplemented here. */
export async function sendPvReply(
  root: HTMLElement,
  deps: PvComposerDeps,
  composerCore: ComposerCore | null,
): Promise<void> {
  const ta = root.querySelector<HTMLTextAreaElement>(".pv-composer-input");
  const snap = deps.getSelected();
  if (!ta || !snap) return;
  const text = ta.value.trim();
  if (!text) return;
  const sessionId = snap.session_id;
  if (!sessionId) {
    showToast("This preview has no owning session to reply to.");
    return;
  }
  const inst = state.sessions.find((s) => s.session_id === sessionId);
  if (!inst) {
    showToast("Session no longer available.");
    return;
  }
  const label = snap.title || snap.slug;
  const tag = `[re: preview v${snap.version}${label ? ` - ${label}` : ""}]`;
  const blocks: ContentBlock[] = [{ type: "text", text: `${tag}\n${text}` }];

  ta.value = "";
  composerCore?.autoResize();
  composerCore?.updateHighlight();
  const sendBtn = root.querySelector<HTMLButtonElement>(".pv-composer-send");
  if (sendBtn) sendBtn.disabled = true;

  if (isCurrentSessionBusy()) {
    state.heldMessages?.stage(blocks);
    return;
  }
  if (state.heldMessages?.hasItemsForActive()) {
    void state.heldMessages.flushHeldWithDraft(blocks);
    return;
  }

  const optimisticEvent = {
    type: "user_message",
    content: blocks,
    timestamp: BigInt(Date.now()),
  } as ChatEvent;
  sessionEvents.pushSynthetic(sessionId, optimisticEvent);
  try {
    await invoke<string>("send_message", { sessionId, cwd: String(inst.cwd ?? "."), blocks });
  } catch (err) {
    console.error("[preview-panel] send_message failed", err);
    sessionEvents.removeSynthetic(sessionId, optimisticEvent);
    ta.value = text;
    composerCore?.autoResize();
    composerCore?.updateHighlight();
    showToast(`Send failed: ${err}`);
  }
}
