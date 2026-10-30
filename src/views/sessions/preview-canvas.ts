// The Preview panel's canvas stage: the sandboxed iframe holding the pushed
// page. Zoom lives inside the page itself (preview-page-zoom.ts), so the stage
// is only the frame; the page takes every pointer and scroll natively.
// Split out of preview-panel.ts so the tab keeps to data and scoping.

import { invoke } from "../../shared/ipc";
import { buildPreviewDocumentHtml } from "./preview-panel-document";
import type { DeviceWidth } from "./preview-panel-more-menu";

export interface PreviewStage {
  /** Settles once the document is staged (or the failure card replaced the stage). */
  ready: Promise<void>;
}

/** Builds the stage into `canvas`. Returns null if the markup did not land. */
export function mountPreviewStage(canvas: HTMLElement, deviceWidth: DeviceWidth, html: string): PreviewStage | null {
  canvas.innerHTML = `<div class="pv-frame" data-w="${deviceWidth}"><div class="pv-stage"><iframe class="pv-iframe" sandbox="allow-scripts"></iframe></div></div>`;
  const iframe = canvas.querySelector<HTMLIFrameElement>(".pv-iframe");
  const stage = canvas.querySelector<HTMLElement>(".pv-stage");
  if (!iframe || !stage) return null;

  const ready = (async () => {
    // Staged over IPC, not a webview fetch (that was cross-origin and 405'd).
    // `render_preview_doc` resolves per-transport: desktop stages on the hook
    // server (preview_render.rs), remote stages same-origin on the
    // remote-access server (remote_preview_render.rs).
    const doc = buildPreviewDocumentHtml(html, { zoom: true });
    try {
      iframe.src = await invoke<string>("render_preview_doc", { html: doc });
    } catch (err) {
      console.error("[preview-panel] preview-render failed", err);
      // A newer render already replaced this stage; its canvas is not ours to overwrite.
      if (!stage.isConnected) return;
      canvas.innerHTML = `
        <div class="pv-empty">
          <i class="ph ph-warning-circle"></i>
          <p>Preview failed to render</p>
          <p class="pv-empty-hint">${String(err).replace(/[<>&]/g, "")}</p>
        </div>
      `;
    }
  })();
  return { ready };
}
