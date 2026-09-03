// Screenshot-block mounting, split off tool-strip.ts (ai_todo 847): folds a
// turn's image tool_results into the always-visible screenshot gallery.

import type { RenderedMessage } from "./chat-transforms";
import { collectScreenshotShots, mountScreenshotBlock } from "./screenshot-row";
import { addGroupToStrip, type ToolGroup } from "./tool-strip";

/** Mounts/refreshes the always-visible screenshot row for any canonical key
 *  with image tool_results this turn, recomputed fresh over the WHOLE
 *  [start, end) range so it stays correct as more calls stream in. `strip`
 *  is guaranteed non-null whenever a screenshot exists. */
export function mountScreenshotsForRange(
  stripHost: HTMLElement,
  messages: RenderedMessage[],
  start: number,
  end: number,
  strip: HTMLElement,
  panel: HTMLElement,
  groups: Map<string, ToolGroup>,
): void {
  const shotsByKey = collectScreenshotShots(messages, start, end);
  for (const [shotKey, shots] of shotsByKey) {
    if (shots.length === 0) continue;
    let group = groups.get(shotKey);
    if (!group) {
      // Every call for this key was nested under a subagent, so no
      // top-level chip exists yet; the count is the screenshot count.
      group = addGroupToStrip(shotKey, strip, panel);
      groups.set(shotKey, group);
      group.chip.dataset.count = String(shots.length);
      const countEl = group.chip.querySelector(".tool-chip-count");
      if (countEl) countEl.textContent = `x${shots.length}`;
    }
    mountScreenshotBlock(stripHost, shotKey, shots);
  }
}
