// Month/week grid + agenda list rendering for the Schedule calendar view,
// split out of schedule.ts (ai_todo 721) so the pure render tree stops
// sharing a file with the mount/click-delegation wiring.

import { escapeHtml } from "../../shared/escape-html";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import { dayKeyOf, localTime, gridRange, buildOccurrences, type Occurrence } from "./schedule-recurrence";
import { state } from "./schedule-state";
import {
  todayKey,
  WEEKDAY_LABELS,
  MONTH_NAMES,
  DOW_HEAD,
  recurrenceBadge,
  kindIconClass,
  targetLabel,
  navTarget,
  statusPill,
  datetimeLocalValue,
  dotClass,
} from "./schedule-format";

function renderGrid(byDay: Map<string, Occurrence[]>, cells: Date[]): string {
  const tKey = todayKey();
  const head = DOW_HEAD.map((d) => `<div class="cal-dow">${d}</div>`).join("");
  const cellHtml = cells.map((d) => {
    const key = dayKeyOf(d);
    const inMonth = d.getMonth() === state.viewMonth;
    const occs = (byDay.get(key) || []).slice().sort((a, b) => a.time - b.time);
    const dots = occs.slice(0, 4).map((o) => `<span class="${dotClass(o)}"></span>`).join("");
    const more = occs.length > 4 ? `<span class="cal-more">+${occs.length - 4}</span>` : "";
    const cls = [
      "cal-cell",
      inMonth ? "" : "other",
      key === tKey ? "today" : "",
      key === state.selectedKey ? "selected" : "",
    ].filter(Boolean).join(" ");
    return `<div class="${cls}" data-day="${key}">
      <span class="cal-daynum">${d.getDate()}</span>
      <div class="cal-dots">${dots}${more}</div>
    </div>`;
  }).join("");
  return `<div class="cal-grid">${head}${cellHtml}</div>`;
}

function agendaRowHtml(occ: Occurrence): string {
  const timeStr = localTime(new Date(occ.time));
  if (!occ.item && occ.external) {
    const job = occ.external;
    return `<li class="agenda-row agenda-row--external">
      <span class="agenda-time">${escapeHtml(timeStr)}</span>
      <i class="ph ph-clock-countdown agenda-icon"></i>
      <div class="agenda-main">
        <div class="agenda-name">${escapeHtml(job.label)}${job.cwd ? ` &mdash; ${escapeHtml(cwdToProjectName(job.cwd))}` : ""}</div>
        <div class="agenda-meta">${statusPill("external")}</div>
      </div>
    </li>`;
  }
  const item = occ.item!;
  const nav = navTarget(item);
  const rescheduleOpen = state.reschedulingId === item.id;
  const isFailed = item.status.type === "failed";
  const reason = item.status.type === "failed"
    ? item.status.reason
    : (occ.status === "failed" ? item.last_result || "" : "");
  const canFire = occ.status === "upcoming" || occ.status === "firing" || occ.status === "failed";
  const showDelete = occ.status !== "firing";
  return `<li class="agenda-row ${nav ? "agenda-row--nav" : ""}" data-id="${escapeHtml(item.id)}" ${nav ? `data-nav-session="${escapeHtml(nav.sessionId)}" data-nav-mode="${nav.mode}"` : ""}>
    <span class="agenda-time">${escapeHtml(timeStr)}</span>
    <i class="ph ${kindIconClass(item)} agenda-icon"></i>
    <div class="agenda-main">
      <div class="agenda-name">${escapeHtml(targetLabel(item))}</div>
      <div class="agenda-meta">
        ${statusPill(occ.status)}
        ${recurrenceBadge(item.recurrence)}
        ${reason ? `<span class="schedule-reason">${escapeHtml(reason)}</span>` : ""}
      </div>
    </div>
    <div class="agenda-actions">
      ${canFire ? `<button class="icon-btn" data-action="fire-now" data-id="${escapeHtml(item.id)}" title="${isFailed ? "Retry" : "Fire now"}"><i class="ph ${isFailed ? "ph-arrow-clockwise" : "ph-play"}"></i></button>` : ""}
      ${occ.status === "upcoming" ? `<button class="icon-btn" data-action="reschedule-toggle" data-id="${escapeHtml(item.id)}" title="Reschedule"><i class="ph ph-calendar-plus"></i></button>` : ""}
      ${showDelete ? `<button class="icon-btn" data-action="delete" data-id="${escapeHtml(item.id)}" title="Delete"><i class="ph ph-trash"></i></button>` : ""}
      ${nav ? `<i class="ph ph-caret-right agenda-chevron"></i>` : ""}
    </div>
    ${rescheduleOpen ? `
      <div class="schedule-reschedule-inline">
        <input type="datetime-local" data-reschedule-input="${escapeHtml(item.id)}" value="${datetimeLocalValue(item.fire_at)}">
        <button class="btn-primary" data-action="reschedule-confirm" data-id="${escapeHtml(item.id)}">Set</button>
        <button class="btn-secondary" data-action="reschedule-cancel" data-id="${escapeHtml(item.id)}">Cancel</button>
      </div>` : ""}
  </li>`;
}

function agendaTitle(key: string | null): string {
  if (!key) return "Select a day";
  const parts = key.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(y, m - 1, d);
  const dayName = dt.toLocaleDateString(undefined, { weekday: "long" });
  return `${dayName}, ${MONTH_NAMES[m - 1]} ${d}`;
}

export function renderBody(): string {
  if (state.loading) {
    return `<div class="schedule-loading"><span class="schedule-spinner"></span>Loading schedule&hellip;</div>`;
  }

  const toggle = `
    <div class="view-toggle">
      <button data-view-mode="month" class="${state.viewMode === "month" ? "active" : ""}">Month</button>
      <button data-view-mode="week" class="${state.viewMode === "week" ? "active" : ""}">Week</button>
    </div>`;
  return `${toggle}${state.viewMode === "week" ? renderWeekView() : renderMonthView()}`;
}

const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));

function renderMonthView(): string {
  const { end, cells } = gridRange(state.viewYear, state.viewMonth);
  const byDay = buildOccurrences(state.items, state.external, end);

  const selectedOccs = state.selectedKey
    ? (byDay.get(state.selectedKey) || []).slice().sort((a, b) => a.time - b.time)
    : [];

  const agenda = selectedOccs.length
    ? `<ul class="agenda-list">${selectedOccs.map(agendaRowHtml).join("")}</ul>`
    : `<div class="agenda-empty">Nothing scheduled this day</div>`;

  const subCount = selectedOccs.length ? `${selectedOccs.length} item${selectedOccs.length > 1 ? "s" : ""}` : "";

  return `
    <div class="cal-head">
      <button class="cal-nav" data-cal="prev" title="Previous month"><i class="ph ph-caret-left"></i></button>
      <div class="cal-month">${MONTH_NAMES[state.viewMonth]} ${state.viewYear}</div>
      <button class="cal-nav" data-cal="next" title="Next month"><i class="ph ph-caret-right"></i></button>
      <button class="cal-today" data-cal="today">Today</button>
    </div>
    ${renderGrid(byDay, cells)}
    <div class="cal-legend">
      <span><span class="dot dot--upcoming"></span>Upcoming</span>
      <span><span class="dot dot--sent"></span>Sent</span>
      <span><span class="dot dot--missed"></span>Missed</span>
      <span><span class="dot dot--failed"></span>Failed</span>
      <span><span class="dot dot--recurring"></span>Recurring</span>
    </div>
    <div class="agenda">
      <div class="agenda-head">
        <div class="agenda-title">${escapeHtml(agendaTitle(state.selectedKey))}</div>
        <div class="agenda-sub">${subCount}</div>
      </div>
      ${agenda}
    </div>
  `;
}

/** The 7 Monday-start days of the week containing `anchorKey`, plus the
 *  end-of-week instant used to cap recurrence expansion. */
function weekRange(anchorKey: string): { days: Date[]; end: Date } {
  const parts = anchorKey.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const anchor = new Date(y, (m || 1) - 1, d || 1);
  const lead = (anchor.getDay() + 6) % 7; // Mon=0
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - lead);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const last = days[6]!;
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59);
  return { days, end };
}

function renderWeekView(): string {
  const { days, end } = weekRange(state.weekAnchor);
  const byDay = buildOccurrences(state.items, state.external, end);
  const tKey = todayKey();
  const start = days[0]!;
  const last = days[6]!;
  const label = `${MONTH_ABBR[start.getMonth()]} ${start.getDate()} – ${MONTH_ABBR[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
  const groups = days
    .map((d) => {
      const key = dayKeyOf(d);
      const occs = (byDay.get(key) || []).slice().sort((a, b) => a.time - b.time);
      const isToday = key === tKey;
      const collapsed = state.collapsedDays.has(key);
      const rows = occs.length
        ? occs.map(agendaRowHtml).join("")
        : `<div class="agenda-empty" style="border:none;border-radius:0">Nothing scheduled</div>`;
      return `<div class="week-day ${collapsed ? "collapsed" : ""}">
      <div class="week-day-head ${isToday ? "is-today" : ""}" data-week-head="${key}">
        <i class="ph ${collapsed ? "ph-caret-right" : "ph-caret-down"}"></i>
        <span>${WEEKDAY_LABELS[(d.getDay() + 6) % 7]}</span>
        <span class="wd-date">${d.getDate()} ${MONTH_ABBR[d.getMonth()]}</span>
        <span class="schedule-count-chip">${occs.length}</span>
      </div>
      <ul class="week-day-rows">${rows}</ul>
    </div>`;
    })
    .join("");
  return `
    <div class="cal-head">
      <button class="cal-nav" data-cal="prev-week" title="Previous week"><i class="ph ph-caret-left"></i></button>
      <div class="cal-month">${escapeHtml(label)}</div>
      <button class="cal-nav" data-cal="next-week" title="Next week"><i class="ph ph-caret-right"></i></button>
      <button class="cal-today" data-cal="this-week">This week</button>
    </div>
    <div class="week-list">${groups}</div>
  `;
}
