import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";
import { invoke } from "../../shared/ipc";
import { askConfirm } from "../../shared/confirm";
import "./schedule.css";
import type { ScheduledItem } from "../../types/ipc.generated";
import { dayKeyOf } from "./schedule-recurrence";
import { state, mountFresh, reload, rerender } from "./schedule-state";
import { todayKey } from "./schedule-format";

// ── Calendar Schedule view ───────────────────────────────────────────────────
//
// Month grid + per-day agenda. Replaces the old flat list. Recurring items are
// expanded client-side onto every occurrence within the visible grid (the
// backend only stores the *next* fire_at + the recurrence rule), so a daily
// message shows on every day, a weekly one on its weekdays, etc. Clicking an
// agenda item navigates to the chat it targets (open_chats_for_session, which
// resumes a closed chat). Rendered both as a route in the dashboard and, more
// usefully, standalone in the `session-schedule` window.
//
// Split across schedule-state.ts (data/state), schedule-format.ts (label
// helpers) and schedule-render.ts (grid/agenda render) - ai_todo 721. This
// file keeps mount + interaction wiring and stays the import barrel.

// ── mount ────────────────────────────────────────────────────────────────────

export async function renderScheduleView(root: HTMLElement): Promise<() => void> {
  const myMount = mountFresh();

  render(template(), root);
  const bodyEl = root.querySelector<HTMLElement>("#schedule-body");
  if (!bodyEl) {
    console.error("[schedule] view template missing #schedule-body");
    return () => { /* no-op */ };
  }

  // Named + removed in teardown: lit-html reuses `#schedule-body` across
  // re-renders, so an anonymous listener stacked one more copy on every visit
  // to this view and a single Delete opened two confirm dialogs.
  const onBodyClick = (e: MouseEvent): void => {
    // Same mount guard `reload` already uses (:381). The router only captures a
    // view's teardown after its async render resolves, so navigating back here
    // before `reload` finishes leaves the previous mount's handler attached and
    // one Delete fires twice, stacking two confirm dialogs.
    if (state.mountId !== myMount) return;
    const target = e.target as HTMLElement;

    // View-mode toggle (Month / Week).
    const modeBtn = target.closest<HTMLElement>("[data-view-mode]");
    if (modeBtn) {
      const mode = modeBtn.dataset.viewMode === "week" ? "week" : "month";
      if (mode !== state.viewMode) {
        if (mode === "week") state.weekAnchor = state.selectedKey || todayKey();
        state.viewMode = mode;
        rerender(bodyEl);
      }
      return;
    }

    // Week-view day-group collapse toggle.
    const weekHead = target.closest<HTMLElement>("[data-week-head]");
    if (weekHead) {
      const key = weekHead.dataset.weekHead!;
      if (state.collapsedDays.has(key)) state.collapsedDays.delete(key);
      else state.collapsedDays.add(key);
      rerender(bodyEl);
      return;
    }

    // Month / week nav.
    const cal = target.closest<HTMLElement>("[data-cal]");
    if (cal) {
      const which = cal.dataset.cal;
      if (which === "prev") stepMonth(-1);
      else if (which === "next") stepMonth(1);
      else if (which === "today") { state.viewYear = new Date().getFullYear(); state.viewMonth = new Date().getMonth(); state.selectedKey = todayKey(); }
      else if (which === "prev-week") stepWeek(-7);
      else if (which === "next-week") stepWeek(7);
      else if (which === "this-week") state.weekAnchor = todayKey();
      rerender(bodyEl);
      return;
    }

    // Day cell selection.
    const cell = target.closest<HTMLElement>(".cal-cell[data-day]");
    if (cell && !cell.classList.contains("other")) {
      state.selectedKey = cell.dataset.day!;
      state.reschedulingId = null;
      rerender(bodyEl);
      return;
    }

    // Row action buttons (fire/delete/reschedule).
    const btn = target.closest<HTMLButtonElement>("button[data-action]");
    if (btn) {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action && id) void handleAction(action, id, bodyEl, myMount);
      return;
    }

    // Row body click -> navigate to the chat.
    const row = target.closest<HTMLElement>(".agenda-row--nav");
    if (row) {
      const sessionId = row.dataset.navSession;
      const mode = row.dataset.navMode || "history";
      if (sessionId) {
        void invoke("open_chats_for_session", { sessionId, mode }).catch((err) =>
          console.error("[schedule] open_chats_for_session failed", err),
        );
      }
    }
  };
  // Wired before the first load so clicks during it are never dropped.
  bodyEl.addEventListener("click", onBodyClick);

  await reload(bodyEl, myMount);

  let unlistenScheduled: (() => void) | null = null;
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    const p = ev.listen("scheduled-items-changed", () => {
      void reload(bodyEl, myMount);
    });
    unlistenScheduled = () => { void p.then((u) => u()); };
  }

  return () => {
    bodyEl.removeEventListener("click", onBodyClick);
    unlistenScheduled?.();
  };
}

function stepMonth(delta: number): void {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m < 0) { m = 11; y--; }
  else if (m > 11) { m = 0; y++; }
  state.viewMonth = m;
  state.viewYear = y;
}

function stepWeek(deltaDays: number): void {
  const parts = state.weekAnchor.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(y, (m || 1) - 1, (d || 1) + deltaDays);
  state.weekAnchor = dayKeyOf(dt);
}

async function handleAction(action: string, id: string, bodyEl: HTMLElement, myMount: number): Promise<void> {
  switch (action) {
    case "fire-now": {
      try {
        await invoke("schedule_fire_now", { id });
      } catch (err) {
        console.error("[schedule] schedule_fire_now failed", err);
      }
      await reload(bodyEl, myMount);
      break;
    }
    case "delete": {
      const ok = await askConfirm("Delete this scheduled item?", { confirmLabel: "Delete" });
      if (!ok) return;
      try {
        await invoke("schedule_delete", { id });
      } catch (err) {
        console.error("[schedule] schedule_delete failed", err);
      }
      await reload(bodyEl, myMount);
      break;
    }
    case "reschedule-toggle": {
      state.reschedulingId = state.reschedulingId === id ? null : id;
      rerender(bodyEl);
      break;
    }
    case "reschedule-cancel": {
      state.reschedulingId = null;
      rerender(bodyEl);
      break;
    }
    case "reschedule-confirm": {
      const input = bodyEl.querySelector<HTMLInputElement>(`input[data-reschedule-input="${CSS.escape(id)}"]`);
      const value = input?.value;
      if (!value) return;
      const local = new Date(value);
      if (isNaN(local.getTime())) return;
      const item = state.items.find((i) => i.id === id);
      if (!item) return;
      const updated: ScheduledItem = { ...item, fire_at: local.toISOString(), status: { type: "pending" } };
      try {
        await invoke("schedule_update", { item: updated });
      } catch (err) {
        console.error("[schedule] schedule_update failed", err);
      }
      state.reschedulingId = null;
      await reload(bodyEl, myMount);
      break;
    }
    default:
      break;
  }
}

function template() {
  return html`
    <div class="view view-schedule">
      <div class="view-header schedule-view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Schedule</h2>
        <button
          class="icon-btn"
          title="Back to Chats"
          @click=${() => showView("sessions")}
        >
          <i class="ph ph-chats"></i>
        </button>
      </div>
      <div class="view-body schedule-view-body">
        <div id="schedule-body" class="schedule-body"></div>
      </div>
    </div>
  `;
}
