// The Preview panel's canvas stage: the sandboxed iframe inside a zoom/pan
// stage (see preview-panel-zoom-gate.ts for when the stage takes the pointer).
// Split out of preview-panel.ts so the tab keeps to data and scoping.

import { invoke } from "../../shared/ipc";
import { setupImageZoomPan } from "../../shared/chat/image-zoom-pan";
import { buildPreviewDocumentHtml } from "./preview-panel-document";
import { mountZoomGate } from "./preview-panel-zoom-gate";
import type { DeviceWidth } from "./preview-panel-more-menu";

export interface PreviewStage {
  /** Removes the zoom/pan listeners. Safe to call twice. */
  dispose: () => void;
  /** Settles once the document is staged (or the failure card replaced the stage). */
  ready: Promise<void>;
}

/** Builds the stage into `canvas`. Returns null if the markup did not land. */
export function mountPreviewStage(canvas: HTMLElement, deviceWidth: DeviceWidth, html: string): PreviewStage | null {
  canvas.innerHTML = `<div class="pv-frame" data-w="${deviceWidth}"><div class="pv-stage"><div class="pv-zoomee"><iframe class="pv-iframe" sandbox="allow-scripts"></iframe></div><button type="button" class="icon-btn pv-zoom-toggle" title="Zoom and pan (or hold Ctrl)" aria-pressed="false"><i class="ph ph-magnifying-glass-plus"></i></button></div></div>`;
  const iframe = canvas.querySelector<HTMLIFrameElement>(".pv-iframe");
  const stage = canvas.querySelector<HTMLElement>(".pv-stage");
  const zoomee = canvas.querySelector<HTMLElement>(".pv-zoomee");
  const toggle = canvas.querySelector<HTMLElement>(".pv-zoom-toggle");
  if (!iframe || !stage || !zoomee || !toggle) return null;
  const disposePan = setupImageZoomPan(zoomee, stage);
  const disposeGate = mountZoomGate(stage, iframe, toggle);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposePan();
    disposeGate();
  };

  const ready = (async () => {
    // Staged over IPC, not a webview fetch (that was cross-origin and 405'd).
    // `render_preview_doc` resolves per-transport: desktop stages on the hook
    // server (preview_render.rs), remote stages same-origin on the
    // remote-access server (remote_preview_render.rs).
    const doc = buildPreviewDocumentHtml(html, { forwardZoomKeys: true });
    try {
      iframe.src = await invoke<string>("render_preview_doc", { html: doc });
    } catch (err) {
      console.error("[preview-panel] preview-render failed", err);
      // The stage is replaced, so its listeners would otherwise outlive it.
      dispose();
      canvas.innerHTML = `
        <div class="pv-empty">
          <i class="ph ph-warning-circle"></i>
          <p>Preview failed to render</p>
          <p class="pv-empty-hint">${String(err).replace(/[<>&]/g, "")}</p>
        </div>
      `;
    }
  })();
  return { dispose, ready };
}
