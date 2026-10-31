/**
 * AI-todos statusline chip: the phone's way into the Backlog panel. Desktop
 * has the split's Backlog tab (with its own count) instead, so the chip draws
 * nothing there and no count is fetched for it.
 */

import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";

export class AiTodosChip {
  count = 0;
  loaded = false;

  /** `mirroredSessionId` is set only for a chat hosted on a paired machine:
   *  the daemon forwards the read to that machine by it, since `cwd` is a
   *  path on the host's disk. A local chat sends cwd alone, unchanged. The
   *  chip only draws a number, so it asks for the count: the list reads a
   *  16 KB head of every todo file and PLAN.md for fields it never shows. */
  async refresh(cwd: string, rerender: () => void, mirroredSessionId: string | null = null): Promise<void> {
    if (!isRemote()) return;
    try {
      const n = await invoke<number>(
        "count_ai_todos",
        mirroredSessionId ? { cwd, sessionId: mirroredSessionId } : { cwd },
      );
      // A null/absent count means "none", not "crash the whole bar" - the chip
      // is in the default rows, so every render path reaches this.
      this.count = n ?? 0;
      this.loaded = true;
      rerender();
    } catch { /* transient */ }
  }

  renderChip(cwd: string | null, animClass: (key: string) => string): string {
    if (!cwd || !isRemote()) return "";
    if (!this.loaded) {
      return `<span class="sb-chip sb-skeleton sb-ai-todos" data-skeleton="ai_todos" style="min-width:55px"><i class="ph ph-check-square"></i><span class="sb-skel-bar"></span></span>`;
    }
    const n = this.count;
    if (n === 0) return "";
    return `<span class="sb-chip sb-ai-todos sb-ai-todos-btn${animClass("ai_todos")}" role="button" tabindex="0" title="${n} AI todo${n === 1 ? "" : "s"} in .claude/todos"><i class="ph ph-check-square"></i>${n}<span class="sb-chip-label"> todo${n === 1 ? "" : "s"}</span></span>`;
  }
}
