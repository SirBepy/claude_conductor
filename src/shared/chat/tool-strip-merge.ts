// Footer-merge machinery, split off tool-strip.ts (ai_todo 832): merges two
// ALREADY-BUILT footers into one, distinct from folding raw rows into a strip.

import { ensureMainStrip } from "./tool-strip";
import { mountScreenshotBlock, getScreenshotRowShots } from "./screenshot-row";

/** Write a chip's count to `n` (both the dataset and the visible "xN").
 *  Exported so tool-strip.ts's bumpChip reuses it instead of a second copy. */
export function setChipCount(chip: HTMLElement, n: number): void {
  chip.dataset.count = String(n);
  const countEl = chip.querySelector(".tool-chip-count");
  if (countEl) countEl.textContent = `x${n}`;
}

/** Move everything `src` shows into `dest`, then drop `src`: same-tool chips
 *  merge (counts add, buckets concatenate) and screenshot rows re-mount from
 *  the concatenated shots. Only for a wake turn that rendered no bubble, so
 *  nothing ever sat between the two footers anyway. */
export function absorbFooterContents(src: HTMLElement, dest: HTMLElement): void {
  const srcStrip = src.querySelector<HTMLElement>(":scope > .tool-strip");
  const srcPanelEl = srcStrip?.nextElementSibling;
  const srcPanel = srcPanelEl instanceof HTMLElement && srcPanelEl.classList.contains("tool-strip-panel")
    ? srcPanelEl
    : null;
  if (srcStrip) {
    const { strip, panel } = ensureMainStrip(dest);
    for (const node of [...srcStrip.children]) {
      if (!(node instanceof HTMLElement) || !node.classList.contains("tool-chip")) continue;
      const key = node.dataset.tool;
      const srcBucket = key && srcPanel
        ? srcPanel.querySelector<HTMLElement>(`:scope > .tool-strip-group[data-tool="${key}"]`)
        : null;
      const destChip = key
        ? strip.querySelector<HTMLElement>(`:scope > .tool-chip[data-tool="${key}"]`)
        : null;
      if (destChip) {
        setChipCount(destChip, Number(destChip.dataset.count ?? "0") + Number(node.dataset.count ?? "0"));
        const destBucket = panel.querySelector<HTMLElement>(`:scope > .tool-strip-group[data-tool="${key}"]`);
        if (srcBucket && destBucket) {
          while (srcBucket.firstChild) destBucket.appendChild(srcBucket.firstChild);
        }
        srcBucket?.remove();
        node.remove();
        continue;
      }
      // Meta chips (Scheduled wake, peer, retry) lead the strip - same
      // placement ensureMetaChip gives them on their own footer.
      if (node.classList.contains("tool-chip--meta")) strip.prepend(node);
      else strip.appendChild(node);
      if (srcBucket) panel.appendChild(srcBucket);
    }
    srcStrip.remove();
    srcPanel?.remove();
  }

  // Whatever else the footer carried (a settled todo checklist, say) lands
  // above dest's screenshots, keeping the chips-then-images reading order.
  const shotAnchor = dest.querySelector<HTMLElement>(":scope > .screenshot-block");
  for (const node of [...src.children]) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.classList.contains("turn-meta-chips") || node.classList.contains("screenshot-block")) continue;
    if (shotAnchor) dest.insertBefore(node, shotAnchor);
    else dest.appendChild(node);
  }

  for (const block of [...src.querySelectorAll<HTMLElement>(":scope > .screenshot-block")]) {
    const key = block.dataset.tool ?? "";
    const srcRow = block.querySelector<HTMLElement>(".screenshot-row");
    const shots = (srcRow && getScreenshotRowShots(srcRow)) || [];
    const destRow = dest.querySelector<HTMLElement>(`:scope > .screenshot-block[data-tool="${key}"] .screenshot-row`);
    const existing = (destRow && getScreenshotRowShots(destRow)) || [];
    block.remove();
    if (shots.length > 0) mountScreenshotBlock(dest, key, [...existing, ...shots]);
  }

  src.remove();
}
