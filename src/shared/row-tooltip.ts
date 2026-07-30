// Hover tooltip for sidebar rows, reusing widgets.css's `.info-tooltip` box.
// Placed to the SIDE: rows are 52px and stacked, so above lands on the
// neighbour. Delegated, because the sidebar reconciles on every render.

const PAD = 10;
let box: HTMLElement | null = null;

function ensureBox(): HTMLElement {
  if (box?.isConnected) return box;
  box = document.createElement("div");
  box.className = "info-tooltip cc-row-tip";
  document.body.appendChild(box);
  return box;
}

export function hideRowTooltip(): void {
  if (box) box.style.display = "none";
}

function show(anchor: HTMLElement): void {
  const text = anchor.dataset.tip;
  if (!text) return;
  const el = ensureBox();
  el.textContent = text;
  el.style.display = "block";
  const a = anchor.getBoundingClientRect();
  const t = el.getBoundingClientRect();

  // Prefer the right side (the rail lives on the left edge); flip left when
  // there isn't room, and clamp vertically so it never leaves the viewport.
  let left = a.right + PAD;
  if (left + t.width > window.innerWidth - PAD) left = a.left - t.width - PAD;
  if (left < PAD) left = PAD;
  let top = a.top + a.height / 2 - t.height / 2;
  if (top < PAD) top = PAD;
  if (top + t.height > window.innerHeight - PAD) top = window.innerHeight - PAD - t.height;

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/** Wire delegated hover tooltips for every `[data-tip]` inside `root`. Safe to
 *  call repeatedly; only the first call per element binds. */
export function attachRowTooltips(root: HTMLElement): void {
  if (root.dataset.tipWired === "1") return;
  root.dataset.tipWired = "1";
  root.addEventListener("mouseover", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (anchor) show(anchor);
  });
  root.addEventListener("mouseout", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (anchor && (!to || !anchor.contains(to))) hideRowTooltip();
  });
  root.addEventListener("scroll", hideRowTooltip, true);
}
