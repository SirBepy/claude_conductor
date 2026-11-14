// The quick-view buttons of one chat dashboard (Bigger plan, Decided, Project
// memory): which of them have something to read, and opening one. The read
// dialog itself is quick-view.ts; this holds the dashboard-side state.

import type { DashboardState } from "../../../shared/chat/dashboard/dashboard-model";
import { openFileRef } from "../../../shared/chat/file-refs";
import { QUICK_VIEWS, type QuickViewId } from "./dashboard-zones";
import { fetchQuickView, openQuickView } from "./quick-view";

export interface QuickViewsHost {
  sessionId(): string | null;
  /** Asks the dashboard for a redraw. */
  schedule(): void;
}

export class QuickViews {
  /** Which quick views have something to read; false draws the button muted (dashboard-zones.ts). */
  readonly has: Partial<Record<QuickViewId, boolean>> = {};
  private asked = false;
  private disposed = false;
  /** Files the Links and files card lists: a plan doc the chat names can stand in for PLAN.md. */
  private linkedFiles: string[] = [];

  constructor(private readonly host: QuickViewsHost) {}

  /** Looks each quick view up once, when the Links and files card first draws,
   *  so a view with nothing behind it draws muted and says so on hover. A click
   *  reads it again, so this only decides how the button looks. */
  ensure(state: DashboardState): void {
    const links = state.right.find((z) => z.id === "links");
    this.linkedFiles = links && links.id === "links" ? links.state.files.map((f) => f.path) : [];
    const sid = this.host.sessionId();
    if (!links || this.asked || !sid) return;
    this.asked = true;
    for (const q of QUICK_VIEWS) {
      void fetchQuickView(sid, q.id)
        .then((d) => {
          // A plan doc the chat names counts as a plan.
          this.has[q.id] = d.docs.length > 0 || (q.id === "plan" && this.linkedPlanDoc() !== null);
          if (!this.disposed) this.host.schedule();
        })
        .catch((err) => console.warn(`[chat-dashboard] quick view ${q.id} lookup failed`, err));
    }
  }

  private linkedPlanDoc(): string | null {
    return this.linkedFiles.find((p) => /plan[^\\/]*\.md$/i.test(p)) ?? null;
  }

  async open(view: QuickViewId): Promise<void> {
    const sid = this.host.sessionId();
    if (!sid) return;
    try {
      const data = await fetchQuickView(sid, view);
      if (view === "plan" && data.docs.length === 0) {
        const linked = this.linkedPlanDoc();
        if (linked) {
          openFileRef(linked);
          return;
        }
      }
      this.has[view] = data.docs.length > 0;
      openQuickView(data);
      this.host.schedule();
    } catch (err) {
      console.warn(`[chat-dashboard] quick view ${view} failed`, err);
      openQuickView({ view, title: QUICK_VIEWS.find((q) => q.id === view)?.label ?? view, docs: [], message: "Could not read it just now." });
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
