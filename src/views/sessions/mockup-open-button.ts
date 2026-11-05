// "Mockup" in a chat's header: opens the newest preview that chat pushed in the
// preview panel, so Joe never hunts for the card or the panel's history picker.
// Hidden until the chat has pushed one. A sub read in place has its own
// session_id on its previews, which is why this is keyed to the chat on screen
// and not to its main chat.

import { invoke } from "../../shared/ipc";
import { getTransport } from "../../shared/transport";
import type { PreviewMeta } from "../../types/ipc.generated";
import type { SessionHeader } from "./session-header";
import { state } from "./state";
import "./mockup-open-button.css";

/** Drops the previous header's live-push listener: the header is rebuilt on every
 *  chat switch and the module keeps one button, like subchat-view's sub list. */
let dispose: (() => void) | null = null;

/** The newest preview `sessionId` pushed. `list_previews` is newest-first; the
 *  session filter is still applied here because the daemon lists the whole store
 *  when it cannot route the read to the chat's host. */
export function newestPreviewOf(list: unknown, sessionId: string): PreviewMeta | undefined {
  return (Array.isArray(list) ? (list as PreviewMeta[]) : []).find((m) => m.session_id === sessionId);
}

export function mountMockupButton(header: SessionHeader, sessionId: string): void {
  dispose?.();
  dispose = null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mockup-open-btn";
  btn.hidden = true;
  btn.title = "Open this chat's mockup";
  btn.setAttribute("aria-label", "Open this chat's mockup");
  btn.innerHTML = `<i class="ph ph-monitor-play"></i><span>Mockup</span>`;
  header.trailSlot.prepend(btn);

  let live = true;
  let unlisten: (() => void) | null = null;

  btn.addEventListener("click", () => {
    void (async () => {
      let id: string | undefined;
      try {
        id = newestPreviewOf(await invoke<PreviewMeta[]>("list_previews", { sessionId }), sessionId)?.id;
      } catch (err) {
        console.error("[mockup-button] list_previews failed", err);
      }
      if (!id) {
        // Its last preview is gone (history cap): nothing to open any more.
        btn.hidden = true;
        return;
      }
      state.previewController?.open(id);
    })();
  });

  void (async () => {
    try {
      const list = await invoke<PreviewMeta[]>("list_previews", { sessionId });
      if (live && newestPreviewOf(list, sessionId)) btn.hidden = false;
    } catch (err) {
      console.error("[mockup-button] list_previews failed", err);
    }
    try {
      const off = await getTransport().listen<{ snapshot?: PreviewMeta }>("preview", (p) => {
        if (p?.snapshot?.session_id === sessionId) btn.hidden = false;
      });
      if (live) unlisten = off;
      else off();
    } catch (err) {
      console.warn("[mockup-button] listen(preview) failed", err);
    }
  })();

  dispose = () => {
    live = false;
    unlisten?.();
    btn.remove();
  };
}
