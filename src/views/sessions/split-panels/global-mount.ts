// The Dashboard / Schedule half of the split (shared/global-panel.ts): mounts
// the real view into a root inside the split body, serialises mounts and
// teardowns, and owns the width those panels keep apart from the chat panels'
// shared fraction. SplitPanels only decides which global panel is open.

import { loadGlobalWidth, saveGlobalWidth } from "./memory";
import type { GlobalPanelView } from "../../../shared/global-panel";

export class GlobalPanelMount {
  private root: HTMLElement | null = null;
  private teardown: (() => void) | null = null;
  private seq = 0;
  /** The dashboard module keeps one mounted instance in module state, so mounts
   *  and their teardowns run strictly one after another. */
  private load: Promise<void> = Promise.resolve();
  private px = loadGlobalWidth();

  constructor(private readonly body: HTMLElement) {}

  get width(): number {
    return this.px;
  }

  /** Renders the real view, not a copy. Both bring their own header (title,
   *  burger, a Chats button); split.css hides what the panel header repeats. */
  mount(view: GlobalPanelView): void {
    const root = document.createElement("div");
    root.className = "pw-panel sp-pane sp-global-pane";
    root.dataset.view = view;
    this.body.appendChild(root);
    this.root = root;
    const seq = ++this.seq;
    this.load = this.load
      .then(async () => {
        // Closed again before its turn came up.
        if (seq !== this.seq) return;
        const teardown =
          view === "dashboard"
            ? await (await import("../../dashboard/dashboard")).renderDashboard(root)
            : await (await import("../../schedule/schedule")).renderScheduleView(root);
        // unmount() bumps seq, so a mount that finishes after the split was
        // destroyed also lands here and tears itself down.
        if (seq !== this.seq) teardown();
        else this.teardown = teardown;
      })
      .catch((err) => console.error("[split-panels] global panel mount failed", err));
  }

  unmount(): void {
    this.seq++;
    this.teardown?.();
    this.teardown = null;
    this.root?.remove();
    this.root = null;
  }

  /** Live width while the divider is dragged; unclamped, painted as it goes. */
  drag(px: number): void {
    this.px = Math.max(0, px);
  }

  /** End of a drag. `bounds` is the range the window can honour right now, or
   *  null when it is too narrow for a split: stored clamped, so a drag past a
   *  minimum doesn't leave a value the next wider window would honour literally. */
  settle(bounds: { min: number; max: number } | null): void {
    if (bounds) this.px = Math.min(bounds.max, Math.max(bounds.min, this.px));
    saveGlobalWidth(this.px);
  }
}
