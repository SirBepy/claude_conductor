// Missed scheduled-items panel (ai_todo 322, item 4). Replaces the old blocking
// askConfirm popup with a non-blocking, dismissible card docked bottom-right:
// one row per missed item (name + time), per-item dismiss, dismiss-all, and
// PERMANENT dismissal (localStorage keyed by item id) so a dismissed item never
// resurfaces - even after relaunch. The old `seenMissedIds` was in-memory only
// (reset every launch), which is exactly what the dev hated: "if i dismiss it
// once, i dont wanna see it anymore".
import { escapeHtml } from "./shared/escape-html";

export interface MissedEntry {
  id: string;
  name: string;
  time: string;
  /** ScheduledItem.kind.type - "new_chat" | "message" | "jarvis_hygiene". */
  kind: string;
}

const LS_KEY = "cc_dismissed_missed_ids";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(s: Set<string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...s]));
  } catch {
    /* quota or storage disabled */
  }
}

const dismissed = loadDismissed();
let current: MissedEntry[] = [];
let onOpenSchedule: (() => void) | null = null;
let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.className = "missed-panel-host";
  host.hidden = true;
  host.addEventListener("click", onHostClick);
  document.body.appendChild(host);
  return host;
}

function kindIcon(kind: string): string {
  return kind === "new_chat" ? "ph-plus-circle" : "ph-paper-plane-tilt";
}

function render(): void {
  const h = ensureHost();
  if (current.length === 0) {
    h.hidden = true;
    h.innerHTML = "";
    return;
  }
  h.hidden = false;
  const rows = current
    .map(
      (m) => `
      <li class="missed-row" data-id="${escapeHtml(m.id)}">
        <i class="ph ${kindIcon(m.kind)} missed-row-icon"></i>
        <div class="missed-row-main">
          <div class="missed-row-name">${escapeHtml(m.name)}</div>
          <div class="missed-row-meta">
            <span class="missed-row-time">${escapeHtml(m.time)}</span>
            <span class="missed-pill">Missed</span>
          </div>
        </div>
        <div class="missed-row-actions">
          <button class="icon-btn-sq missed-icon-btn missed-icon-btn--open" title="Open schedule" data-open><i class="ph ph-arrow-square-out"></i></button>
          <button class="icon-btn-sq missed-icon-btn missed-icon-btn--dismiss" title="Dismiss - won't show again" data-dismiss="${escapeHtml(m.id)}"><i class="ph ph-x"></i></button>
        </div>
      </li>`,
    )
    .join("");
  h.innerHTML = `
    <div class="missed-panel">
      <div class="missed-head">
        <i class="ph ph-warning-circle"></i>
        <div class="missed-head-title">Missed scheduled items</div>
        <div class="missed-head-count">${current.length}</div>
      </div>
      <ul class="missed-list">${rows}</ul>
      <div class="missed-foot">
        <button class="btn-dismiss-all" data-dismiss-all><i class="ph ph-x-circle"></i> Dismiss all</button>
        <button class="btn-open" data-open><i class="ph ph-calendar"></i> Open schedule</button>
      </div>
    </div>`;
}

function animateOutThen(id: string, fn: () => void): void {
  const row = host?.querySelector<HTMLElement>(`.missed-row[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add("leaving");
    setTimeout(fn, 220);
  } else {
    fn();
  }
}

function dismissOne(id: string): void {
  dismissed.add(id);
  saveDismissed(dismissed);
  animateOutThen(id, () => {
    current = current.filter((m) => m.id !== id);
    render();
  });
}

function dismissAll(): void {
  for (const m of current) dismissed.add(m.id);
  saveDismissed(dismissed);
  host?.querySelectorAll(".missed-row").forEach((r) => r.classList.add("leaving"));
  setTimeout(() => {
    current = [];
    render();
  }, 220);
}

function onHostClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const dismissBtn = t.closest<HTMLElement>("[data-dismiss]");
  if (dismissBtn?.dataset.dismiss) {
    dismissOne(dismissBtn.dataset.dismiss);
    return;
  }
  if (t.closest("[data-dismiss-all]")) {
    dismissAll();
    return;
  }
  if (t.closest("[data-open]")) {
    onOpenSchedule?.();
  }
}

/** Refresh the panel with the current set of missed items. Permanently
 *  dismissed items are filtered out; an empty result hides the panel. Safe to
 *  call on every `scheduled-items-changed` tick. */
export function updateMissedPanel(missed: MissedEntry[], openSchedule: () => void): void {
  onOpenSchedule = openSchedule;
  current = missed.filter((m) => !dismissed.has(m.id));
  render();
}
