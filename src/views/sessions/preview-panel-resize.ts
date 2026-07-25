// Resize-drag mechanics for the docked preview panel (ai_todo 308, split off
// of preview-panel.ts). This was already a standalone free function bound in
// PreviewPanel's constructor - it touches none of PreviewPanel's private
// state, only `root` (the flex item resized here) and an onCommit callback -
// so it's a clean extraction, just previously co-located.

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 2000;

// Resize-drag wiring is kept out of the PreviewPanel class body as a free
// function bound in the constructor. Resizes `root` itself (the actual flex
// item inside `.sessions-layout`, not the inner `.preview-panel` div) since
// sizing lives on the host's `flex` (see preview-panel.ts's applyWidth doc).
export function wireResizeHandle(root: HTMLElement, onCommit: (px: number) => void): () => void {
  const handle = root.querySelector<HTMLElement>("[data-resize]");
  if (!handle) return () => {};

  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  let liveWidth = 0;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const delta = startX - e.clientX; // dragging left (toward the chat) grows the panel
    liveWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    root.style.flex = `0 0 ${liveWidth}px`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    onCommit(liveWidth);
  };
  const onDown = (e: MouseEvent) => {
    dragging = true;
    startX = e.clientX;
    startWidth = root.getBoundingClientRect().width;
    liveWidth = startWidth;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  };
  handle.addEventListener("mousedown", onDown);

  return () => {
    handle.removeEventListener("mousedown", onDown);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
}
