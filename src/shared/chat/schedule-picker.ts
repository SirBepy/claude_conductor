// Schedule picker: a reusable popover for picking a future fire time (+
// optional recurrence) for a scheduled message or a scheduled new chat.
// Body-appended, position:fixed, repositioned off an anchor element: mirrors
// the DrainPopover idiom in views/sessions/statusbar-popover-shell.ts rather
// than the held-messages anchor-relative pattern, since the anchor here
// (the split-Send chevron, or a dropdown row) isn't always position:relative.

import { escapeHtml } from "../escape-html";
import type { Recurrence, RecurrenceRule } from "../../types/ipc.generated";
import { openAnchoredPopover } from "./anchored-popover";
import "./schedule-picker.css";

export interface SchedulePickerResult {
  fireAtUtcIso: string;
  recurrence: Recurrence | null;
}

export interface SchedulePickerOptions {
  anchor: HTMLElement;
  onConfirm: (result: SchedulePickerResult) => void;
  /** Prefill for an "Edit" reopen — opens straight into the custom-time view
   * (no presets, no back button) instead of the preset list. */
  initial?: { fireAtUtcIso: string; recurrence: Recurrence | null };
  /** Confirm button verb. Defaults to "Schedule" (edit flows pass "Update"). */
  confirmLabel?: string;
  /** The account's next 5-hour usage-window reset (already +60s-buffered by
   * the caller), added as a preset row once resolved. A settled value or a
   * pending promise both work; null/past-due resolves to no row. Omit to
   * skip the preset entirely (e.g. the edit-reopen flow, which has no
   * presets view at all). */
  nextTokenReset?: Date | null | Promise<Date | null>;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAbsolute(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Today HH:MM" / "Tomorrow HH:MM" / "Jul 10 HH:MM" for a stored UTC iso. */
export function formatFireAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  const time = fmtTime(d);
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Tomorrow ${time}`;
  return `${fmtAbsolute(d)} ${time}`;
}

/** Short recurrence badge text ("Daily" / "Weekly Mon/Wed" / "Every 3d"). */
export function formatRecurrenceBadge(rec: Recurrence): string {
  if (rec.rule.type === "daily") return "Daily";
  if (rec.rule.type === "weekly") {
    const days = [...rec.rule.weekdays].sort((a, b) => a - b).map((i) => WEEKDAY_LABELS[i] ?? "?").join("/");
    return `Weekly ${days}`;
  }
  return `Every ${rec.rule.n}d`;
}

interface Preset {
  label: string;
  at: Date;
  icon?: string;
}

function buildPresets(now: Date): Preset[] {
  const out: Preset[] = [];
  out.push({ label: "In 1 hour", at: new Date(now.getTime() + 60 * 60 * 1000) });

  if (now.getHours() < 20) {
    const tonight = new Date(now);
    tonight.setHours(21, 0, 0, 0);
    out.push({ label: "Tonight 21:00", at: tonight });
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  out.push({ label: "Tomorrow 09:00", at: tomorrow });

  const monday = new Date(now);
  const day = monday.getDay(); // 0=Sun..6=Sat
  let diff = (8 - day) % 7; // days until Monday
  if (diff === 0) diff = 7; // today IS Monday — mean next week's, not today
  monday.setDate(monday.getDate() + diff);
  monday.setHours(9, 0, 0, 0);
  out.push({ label: "Monday 09:00", at: monday });

  return out;
}

/** 0=Mon..6=Sun for a local datetime-local input value (or now if empty). */
function localWeekdayIndex(dtValue: string): number {
  const d = dtValue ? new Date(dtValue) : new Date();
  const js = d.getDay(); // 0=Sun..6=Sat
  return js === 0 ? 6 : js - 1;
}

export function openSchedulePicker(opts: SchedulePickerOptions): void {
  const pop = document.createElement("div");
  pop.className = "schedule-picker-popover";
  document.body.appendChild(pop);

  let view: "presets" | "custom" = opts.initial ? "custom" : "presets";
  let recurRule: "none" | "daily" | "weekly" | "every_n_days" = "none";
  let weekdays = new Set<number>();
  let everyN = 2;
  let dtValue: string;
  let nextResetPreset: Preset | null = null;

  Promise.resolve(opts.nextTokenReset).then((d) => {
    if (!d || d.getTime() <= Date.now()) return;
    nextResetPreset = { label: `Next token reset ${fmtTime(d)}`, at: d, icon: "hourglass-high" };
    if (view === "presets" && pop.isConnected) renderPresets();
  });

  if (opts.initial) {
    dtValue = toLocalInputValue(new Date(opts.initial.fireAtUtcIso));
    const rec = opts.initial.recurrence;
    if (rec) {
      if (rec.rule.type === "daily") {
        recurRule = "daily";
      } else if (rec.rule.type === "weekly") {
        recurRule = "weekly";
        weekdays = new Set(rec.rule.weekdays);
      } else {
        recurRule = "every_n_days";
        everyN = rec.rule.n;
      }
    }
  } else {
    dtValue = toLocalInputValue(new Date(Date.now() + 60000));
  }

  const popover = openAnchoredPopover({
    anchor: opts.anchor,
    el: pop,
    onClose: () => pop.remove(),
  });
  const close = popover.close;
  const reposition = popover.reposition;

  function fireAtDate(): Date {
    return dtValue ? new Date(dtValue) : new Date();
  }

  function buildRecurrence(): Recurrence | null {
    if (recurRule === "none") return null;
    const at = fireAtDate();
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    let rule: RecurrenceRule;
    if (recurRule === "daily") rule = { type: "daily" };
    else if (recurRule === "weekly") rule = { type: "weekly", weekdays: [...weekdays].sort((a, b) => a - b) };
    else rule = { type: "every_n_days", n: Math.max(1, everyN) };
    return { time, rule };
  }

  function updateConfirmLabel(): void {
    const btn = pop.querySelector<HTMLButtonElement>(".schedule-picker-confirm");
    if (!btn) return;
    const at = fireAtDate();
    const label = opts.confirmLabel ?? "Schedule";
    btn.textContent = `${label} for ${fmtAbsolute(at)} ${fmtTime(at)}`;
  }

  function renderPresets(): void {
    const now = new Date();
    const presets = buildPresets(now);
    if (nextResetPreset) presets.splice(1, 0, nextResetPreset);
    pop.innerHTML = `
      <div class="schedule-picker-title">Schedule</div>
      <div class="schedule-picker-rows">
        ${presets.map((p, i) => `
          <button type="button" class="schedule-picker-row" data-preset="${i}">
            <span class="schedule-picker-row-label">${p.icon ? `<i class="ph ph-${escapeHtml(p.icon)}"></i> ` : ""}${escapeHtml(p.label)}</span>
            <span class="schedule-picker-row-abs">${escapeHtml(fmtAbsolute(p.at))}</span>
          </button>
        `).join("")}
        <button type="button" class="schedule-picker-row schedule-picker-custom-row">
          <span class="schedule-picker-row-label"><i class="ph ph-calendar-plus"></i> Custom time…</span>
          <i class="ph ph-caret-right"></i>
        </button>
      </div>
    `;
    pop.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = presets[Number(btn.dataset.preset)];
        if (!p) return;
        opts.onConfirm({ fireAtUtcIso: p.at.toISOString(), recurrence: null });
        close();
      });
    });
    pop.querySelector(".schedule-picker-custom-row")?.addEventListener("click", () => {
      view = "custom";
      renderCustom();
    });
    reposition();
  }

  function renderCustom(): void {
    const at = fireAtDate();
    const label = opts.confirmLabel ?? "Schedule";
    pop.innerHTML = `
      <div class="schedule-picker-title">
        ${opts.initial ? "" : `<button type="button" class="schedule-picker-back" title="Back"><i class="ph ph-caret-left"></i></button>`}
        <span>Custom time</span>
      </div>
      <label class="schedule-picker-field">
        <span>Date &amp; time</span>
        <input type="datetime-local" class="schedule-picker-dt" value="${escapeHtml(dtValue)}" min="${escapeHtml(toLocalInputValue(new Date()))}">
      </label>
      <label class="schedule-picker-field">
        <span>Repeat</span>
        <select class="schedule-picker-recur">
          <option value="none"${recurRule === "none" ? " selected" : ""}>Does not repeat</option>
          <option value="daily"${recurRule === "daily" ? " selected" : ""}>Daily</option>
          <option value="weekly"${recurRule === "weekly" ? " selected" : ""}>Weekly</option>
          <option value="every_n_days"${recurRule === "every_n_days" ? " selected" : ""}>Every N days</option>
        </select>
      </label>
      ${recurRule === "weekly" ? `
        <div class="schedule-picker-weekdays">
          ${WEEKDAY_LABELS.map((wd, i) => `
            <button type="button" class="schedule-picker-weekday${weekdays.has(i) ? " active" : ""}" data-wd="${i}">${wd}</button>
          `).join("")}
        </div>
      ` : ""}
      ${recurRule === "every_n_days" ? `
        <label class="schedule-picker-field schedule-picker-field-inline">
          <span>Every</span>
          <input type="number" class="schedule-picker-n" min="1" max="365" value="${everyN}">
          <span>days</span>
        </label>
      ` : ""}
      <button type="button" class="schedule-picker-confirm">${escapeHtml(label)} for ${escapeHtml(fmtAbsolute(at))} ${escapeHtml(fmtTime(at))}</button>
    `;
    pop.querySelector(".schedule-picker-back")?.addEventListener("click", () => {
      view = "presets";
      renderPresets();
    });
    const dt = pop.querySelector<HTMLInputElement>(".schedule-picker-dt");
    dt?.addEventListener("input", () => {
      dtValue = dt.value;
      updateConfirmLabel();
    });
    const sel = pop.querySelector<HTMLSelectElement>(".schedule-picker-recur");
    sel?.addEventListener("change", () => {
      recurRule = sel.value as typeof recurRule;
      if (recurRule === "weekly" && weekdays.size === 0) weekdays.add(localWeekdayIndex(dtValue));
      renderCustom();
    });
    pop.querySelectorAll<HTMLButtonElement>(".schedule-picker-weekday").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.wd);
        if (weekdays.has(i)) weekdays.delete(i);
        else weekdays.add(i);
        btn.classList.toggle("active");
      });
    });
    const nInput = pop.querySelector<HTMLInputElement>(".schedule-picker-n");
    nInput?.addEventListener("input", () => {
      everyN = Math.max(1, Number(nInput.value) || 1);
    });
    pop.querySelector(".schedule-picker-confirm")?.addEventListener("click", () => {
      if (!dtValue) return;
      opts.onConfirm({ fireAtUtcIso: fireAtDate().toISOString(), recurrence: buildRecurrence() });
      close();
    });
    reposition();
  }

  if (view === "presets") renderPresets();
  else renderCustom();
}
