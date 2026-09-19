// Shared sortable project-list table builder + wiring, used by the "today"
// global widget and by the account-scoped chart/bars widgets' "worked on"
// lists (moved from the deleted src/views/statistics/statistics.ts,
// multi-account milestone 05 - no behaviour change beyond dropping the
// pin-button plumbing, which the widget registry's enable/disable replaces).

import { formatTokens } from "../../../shared/tokens";
import { timeAgo } from "../../../shared/time";
import { projectLabel, isBlacklisted } from "../../../shared/projects";
import { openProjectDetail } from "../../../shared/navigation";
import { getSettings } from "../../../shared/state";
import type { SettingsShape } from "../../../shared/state";
import type { AliasMap } from "../../../shared/tokens";

export interface ListProject {
  cwd: string;
  tokens: number;
  lastActiveAt?: string;
  sessionPct?: number;
}

interface ListSortState { col: string; dir: 1 | -1; }
const listSortState: Record<string, ListSortState> = {};

type Wired = Element & { _wired?: boolean };
function wired(el: Element): Wired { return el as Wired; }

export function plabel(cwd: string): string {
  const aliases = (getSettings().projectAliases || {}) as AliasMap;
  return projectLabel(cwd, aliases);
}

export function isBlackRef(cwd: string): boolean {
  const s = getSettings() as SettingsShape;
  return isBlacklisted(cwd, (s.projectAliases || {}) as AliasMap, s.projectBlacklist as string[] | undefined);
}

function deadPaths(): Set<string> {
  const fn = (window as unknown as { getDeadPaths?: () => Set<string> }).getDeadPaths;
  try { return fn ? fn() : new Set<string>(); } catch { return new Set<string>(); }
}

export interface BuildListOpts {
  title?: string;
  projects: ListProject[];
  maxItems?: number | null;
  showTime?: boolean;
  showPct?: boolean;
  sortable?: boolean;
  defaultSort?: string;
  id?: string;
  style?: string;
}

export function buildProjectListHTML(opts: BuildListOpts): string {
  const {
    title, projects, maxItems, showTime = true, showPct = false,
    sortable = false, defaultSort = "lastActiveAt", id, style,
  } = opts;
  if (!projects || !projects.length) return "";

  const containerId = id || `plist-${Math.random().toString(36).slice(2, 8)}`;
  if (!listSortState[containerId]) {
    listSortState[containerId] = { col: defaultSort, dir: -1 };
  }
  const ss = listSortState[containerId]!;

  const cols: Array<{ key: string; label: string }> = [{ key: "project", label: "Project" }];
  cols.push({ key: "tokens", label: "Total" });
  if (showPct) cols.push({ key: "sessionPct", label: "Session %" });
  if (showTime) cols.push({ key: "lastActiveAt", label: "Last active" });

  const sortVal = (p: ListProject, col: string): string | number => {
    if (col === "project") return plabel(p.cwd).toLowerCase();
    if (col === "tokens") return p.tokens || 0;
    if (col === "sessionPct") return p.sessionPct ?? -1;
    if (col === "lastActiveAt") return p.lastActiveAt || "";
    return 0;
  };
  const sorted = [...projects].sort((a, b) => {
    const av = sortVal(a, ss.col);
    const bv = sortVal(b, ss.col);
    return (av < bv ? -1 : av > bv ? 1 : 0) * ss.dir;
  });

  const capped = !!(maxItems && sorted.length > maxItems);
  const visible = capped && maxItems ? sorted.slice(0, maxItems) : sorted;

  let headerRow = "";
  if (sortable) {
    headerRow = "<thead><tr>" + cols.map((c) => {
      const arrow = ss.col === c.key ? (ss.dir === -1 ? " ↓" : " ↑") : "";
      const cls = ss.col === c.key ? " sort-active" : "";
      return `<th class="${cls}" data-sort="${c.key}" data-list="${containerId}">${c.label}${arrow}</th>`;
    }).join("") + "</tr></thead>";
  }

  const dead = deadPaths();
  const renderRow = (p: ListProject): string => {
    const isDead = dead.has(p.cwd);
    const deadIcon = isDead ? `<span class="dead-path-warning" title="Folder no longer exists">⚠</span> ` : "";
    return `<tr class="proj-row v-focusable" data-cwd="${p.cwd}" role="button" tabindex="0">
      <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${deadIcon}${plabel(p.cwd)}</td>
      <td class="mono">${formatTokens(p.tokens)}</td>
      ${showPct ? `<td class="mono">${p.sessionPct != null ? p.sessionPct + "%" : "-"}</td>` : ""}
      ${showTime ? `<td class="mono">${timeAgo(p.lastActiveAt)}</td>` : ""}
    </tr>`;
  };

  const visibleRows = visible.map(renderRow).join("");
  const remaining = sorted.length - visible.length;
  const showMoreBtn = capped
    ? `<div style="display:flex;justify-content:center;padding-top:8px">
         <button class="btn-secondary show-more-btn" data-list-id="${containerId}" style="font-size: var(--fs-micro);padding:2px 10px">Show ${remaining} more</button>
       </div>`
    : "";

  return `<div class="today-section" ${style ? `style="${style}"` : ""}>
    ${title ? `<div style="font-size: var(--fs-title);font-weight:700;margin-bottom:10px">${title}</div>` : ""}
    <table class="stats-table">
      ${headerRow}
      <tbody>${visibleRows}</tbody>
    </table>
    ${showMoreBtn}
  </div>`;
}

/** Wires row-click (open project detail) and sortable-header clicks for every
 * project-list table under `container`. `onSort` re-renders the caller's
 * content after a sort-column change; `onShowMore` (only relevant to capped
 * lists, e.g. the chart widgets' "worked on" lists) opens the full list. */
export function wireProjectListClicks(
  container: HTMLElement | null,
  onSort?: (listId?: string) => void,
  onShowMore?: (listId: string) => void,
): void {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".proj-row").forEach((row) => {
    const w = wired(row);
    if (row.dataset["cwd"] && !w._wired) {
      w._wired = true;
      row.onclick = () => {
        const cwd = row.dataset["cwd"];
        if (!cwd) return;
        openProjectDetail(cwd);
      };
      row.onkeydown = (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        row.click();
      };
    }
  });
  container.querySelectorAll<HTMLElement>(".show-more-btn").forEach((btn) => {
    const w = wired(btn);
    if (w._wired) return;
    w._wired = true;
    btn.onclick = () => {
      const listId = btn.dataset["listId"];
      if (listId) onShowMore?.(listId);
    };
  });
  container.querySelectorAll<HTMLElement>("th[data-sort][data-list]").forEach((th) => {
    const w = wired(th);
    if (w._wired) return;
    w._wired = true;
    th.onclick = () => {
      const listId = th.dataset["list"];
      const col = th.dataset["sort"];
      if (!listId || !col) return;
      const ss = listSortState[listId];
      if (!ss) return;
      if (ss.col === col) ss.dir = (ss.dir * -1) as 1 | -1;
      else { ss.col = col; ss.dir = -1; }
      onSort?.(listId);
    };
  });
}
