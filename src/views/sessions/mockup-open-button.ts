// "Mockup" in a chat's header: opens the newest preview that chat pushed in the
// preview panel, so Joe never hunts for the card or the panel's history picker.
// Hidden until the chat's panel has one to show. It follows the panel's scope
// (a main chat plus its subs, a sub in place covers its family), so the button
// is shown exactly when opening the panel would land on a page. `list_previews`
// is asked with `scopeRoot(sessionId)` like the panel: the daemon matches only
// the named chat and its subs, so a sub's own id would miss the family's pages.

import { invoke } from "../../shared/ipc";
import { getTransport } from "../../shared/transport";
import type { PreviewMeta } from "../../types/ipc.generated";
import type { SessionHeader } from "./session-header";
import { previewsOfSession } from "./preview-panel-history";
import { inFamily, scopeRoot } from "./shared-mockup-scope";
import { state } from "./state";
import "./mockup-open-button.css";

/** Drops the previous header's live-push listener: the header is rebuilt on every
 *  chat switch and the module keeps one button, like subchat-view's sub list. */
let dispose: (() => void) | null = null;

/** The newest preview the panel for `sessionId` would list (`list_previews` is
 *  newest-first). Scoped as the panel is, by family: a main chat whose subs hold
 *  the mockup would otherwise show no button while its own panel is full, and a
 *  sub's button would hide while the family page it opens is right there. */
export function newestPreviewOf(list: unknown, sessionId: string): PreviewMeta | undefined {
  return previewsOfSession(list, sessionId)[0];
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
        id = newestPreviewOf(await invoke<PreviewMeta[]>("list_previews", { sessionId: scopeRoot(sessionId) }), sessionId)?.id;
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
      const list = await invoke<PreviewMeta[]>("list_previews", { sessionId: scopeRoot(sessionId) });
      if (live && newestPreviewOf(list, sessionId)) btn.hidden = false;
    } catch (err) {
      console.error("[mockup-button] list_previews failed", err);
    }
    try {
      const off = await getTransport().listen<{ snapshot?: PreviewMeta }>("preview", (p) => {
        if (inFamily(p?.snapshot?.session_id, sessionId)) btn.hidden = false;
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
