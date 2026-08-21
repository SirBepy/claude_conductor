// Module-level state singleton + data fetch/reload for the Schedule calendar
// view, split out of schedule.ts (ai_todo 721) so the render and mount
// modules import one shared `state` binding instead of each holding a copy.

import { invoke } from "../../shared/ipc";
import type {
  ScheduledItem,
  ExternalScheduledJob,
  Instance,
} from "../../types/ipc.generated";
import { todayKey } from "./schedule-format";
import { renderBody } from "./schedule-render";

export interface ScheduleState {
  mountId: number;
  items: ScheduledItem[];
  external: ExternalScheduledJob[];
  /** session_id -> chat title (Instance.name), for live-vs-history + labels. */
  titles: Map<string, string>;
  loading: boolean;
  /** First of the visible month (local). */
  viewYear: number;
  viewMonth: number; // 0-based
  /** Selected day key (yyyy-mm-dd) whose agenda is shown, or null. */
  selectedKey: string | null;
  /** id of the row currently showing its inline reschedule datetime picker. */
  reschedulingId: string | null;
  /** "month" (grid) or "week" (7 collapsible day-row-groups). */
  viewMode: "month" | "week";
  /** Day key (yyyy-mm-dd) anchoring the visible week - any day within it. */
  weekAnchor: string;
  /** Day keys the user has manually collapsed in week view. */
  collapsedDays: Set<string>;
}

const now0 = new Date();
export let state: ScheduleState = freshState(0);
let nextMountId = 1;

export function freshState(mountId: number): ScheduleState {
  return {
    mountId,
    items: [],
    external: [],
    titles: new Map(),
    loading: true,
    viewYear: now0.getFullYear(),
    viewMonth: now0.getMonth(),
    selectedKey: todayKey(),
    reschedulingId: null,
    viewMode: "month",
    weekAnchor: todayKey(),
    collapsedDays: new Set(),
  };
}

/** Resets the module-level `state` singleton for a new mount, returning its
 * id. ESM disallows reassigning an imported binding from outside its owning
 * module, so schedule.ts's renderScheduleView calls this instead of doing
 * `state = freshState(myMount)` itself. */
export function mountFresh(): number {
  const myMount = nextMountId++;
  state = freshState(myMount);
  return myMount;
}

export async function fetchAll(): Promise<void> {
  try {
    const [items, external, instances] = await Promise.all([
      invoke<ScheduledItem[]>("schedule_list").catch(() => [] as ScheduledItem[]),
      invoke<ExternalScheduledJob[]>("schedule_list_external").catch(() => [] as ExternalScheduledJob[]),
      invoke<Instance[]>("list_instances").catch(() => [] as Instance[]),
    ]);
    state.items = items || [];
    state.external = external || [];
    state.titles = new Map((instances || []).map((i) => [i.session_id, i.name || ""]));
  } catch (err) {
    console.error("[schedule] fetch failed", err);
    state.items = [];
    state.external = [];
    state.titles = new Map();
  } finally {
    state.loading = false;
  }
}

export async function reload(bodyEl: HTMLElement, myMount: number): Promise<void> {
  await fetchAll();
  if (state.mountId !== myMount) return;
  bodyEl.innerHTML = renderBody();
}

export function rerender(bodyEl: HTMLElement): void {
  bodyEl.innerHTML = renderBody();
}
