// Resize-drag mechanics for the docked preview panel (ai_todo 308, split off
// of preview-panel.ts). This was already a standalone free function bound in
// PreviewPanel's constructor - it touches none of PreviewPanel's private
// state, only `root` (the flex item resized here) and an onCommit callback -
// so it's a clean extraction, just previously co-located.

export const MIN_WIDTH = 320;
/** Chat floor. Letting it hit `min-width: 0` is what pushed the rail off. */
export const MIN_CHAT_WIDTH = 360;

/** Px the panel and chat pane share. `pane + panel`, not the layout width, so a
 *  collapsed sidebar needs no case and the sum holds while the panel is hidden. */
export function splittableWidth(root: HTMLElement): number {
  const pane = root.parentElement?.querySelector<HTMLElement>(".session-pane");
  const paneWidth = pane ? pane.getBoundingClientRect().width : 0;
  return paneWidth + root.getBoundingClientRect().width;
}

/** The lower bound yields below MIN_WIDTH rather than starve the chat's floor. */
export function clampPanelWidth(desired: number, splittable: number): number {
  const max = Math.max(1, splittable - MIN_CHAT_WIDTH);
  return Math.max(Math.min(MIN_WIDTH, max), Math.min(desired, max));
}

// Resize-drag wiring is kept out of the PreviewPanel class body as a free
// function bound in the constructor. Resizes `root` itself (the actual flex
// item inside `.sessions-layout`, not the inner `.preview-panel` div) since
// sizing lives on the host's `flex` (see preview-panel.ts's applyWidth doc).
// `onCommit` also gets the splittable total, so the drag can be stored as a share.
export function wireResizeHandle(
  root: HTMLElement,
  onCommit: (px: number, splittable: number) => void,
): () => void {
  const handle = root.querySelector<HTMLElement>("[data-resize]");
  if (!handle) return () => {};

  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  let liveWidth = 0;
  let splittable = 0;

  // The iframe is a separate document; mousemove gets swallowed once the
  // cursor crosses it mid-drag, stalling the resize. Disable pointer
  // interaction on the frame wrapper for the drag's duration to prevent that.
  const setFrameInert = (inert: boolean) => {
    const frame = root.querySelector<HTMLElement>(".pv-frame");
    if (frame) frame.style.pointerEvents = inert ? "none" : "";
  };

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const delta = startX - e.clientX; // dragging left (toward the chat) grows the panel
    liveWidth = clampPanelWidth(startWidth + delta, splittable);
    root.style.flex = `0 0 ${liveWidth}px`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    setFrameInert(false);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("mouseleave", onUp);
    onCommit(liveWidth, splittable);
  };
  const onDown = (e: MouseEvent) => {
    dragging = true;
    startX = e.clientX;
    startWidth = root.getBoundingClientRect().width;
    liveWidth = startWidth;
    // Sampled once: mid-drag pane and panel just trade width, total is fixed.
    splittable = splittableWidth(root);
    setFrameInert(true);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("mouseleave", onUp);
    e.preventDefault();
  };
  handle.addEventListener("mousedown", onDown);

  return () => {
    handle.removeEventListener("mousedown", onDown);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("mouseleave", onUp);
    setFrameInert(false);
  };
}
