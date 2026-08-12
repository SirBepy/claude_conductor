// Pure helpers for the dashboard widget registry + the pinnedCards migration
// (multi-account milestone 05). Kept free of DOM/lit-html/api imports so the
// migration and scope/re-render rules are cheaply unit-testable (see
// tests/dashboard-widget-logic.test.mjs), mirroring the sessions/
// account-picker-logic.ts pattern. dashboard.ts and widget-registry.ts are
// the only callers - the widget scope metadata below is a small hand-synced
// mirror of the real `Widget[]` array in widget-registry.ts.

export type WidgetScope = "global" | "account";

export interface WidgetMeta {
  id: string;
  scope: WidgetScope;
}

export interface DashboardWidgetEntry {
  id: string;
  enabled: boolean;
}

/** Registry widget ids in their canonical/default order. */
export const WIDGET_METAS: WidgetMeta[] = [
  { id: "today", scope: "global" },
  { id: "skill-usage", scope: "global" },
  { id: "session-chart", scope: "account" },
  { id: "session-bars", scope: "account" },
  { id: "weekly-chart", scope: "account" },
  { id: "weekly-bars", scope: "account" },
  { id: "token-source", scope: "global" },
];

const REGISTRY_IDS = WIDGET_METAS.map((w) => w.id);

// Statistics widgets were unconditionally visible (never pin-gated); losing
// them on Statistics' deletion would violate "no widget lost", so both ride
// onto every dashboard - migrated or brand new - enabled by default.
const ALWAYS_ON_BY_DEFAULT = ["today", "skill-usage"];

/** One-time forward migration of the old closed-enum `pinnedCards` list into
 * the new ordered `dashboardWidgets` layout. Old ids match 1:1 with new
 * widget ids (no renaming), so this only needs to mark whatever was pinned
 * enabled, force the two former Statistics-only widgets on, and append every
 * remaining registry id disabled so the layout is complete. */
export function migrateLegacyPinnedCards(pinnedCards: unknown): DashboardWidgetEntry[] {
  const legacy = Array.isArray(pinnedCards)
    ? pinnedCards.filter((x): x is string => typeof x === "string")
    : [];
  const out: DashboardWidgetEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string, enabled: boolean): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, enabled });
  };
  for (const id of legacy) {
    if (REGISTRY_IDS.includes(id)) add(id, true);
  }
  for (const id of ALWAYS_ON_BY_DEFAULT) add(id, true);
  for (const id of REGISTRY_IDS) add(id, false);
  return out;
}

/** Reads the persisted `dashboardWidgets` layout, migrating from the legacy
 * `pinnedCards` field exactly once - absence of `dashboardWidgets` is the
 * migration trigger; once it has been saved (even as `[]`), it always wins.
 * Any registry id missing from a persisted layout (e.g. a widget added in a
 * later release) is appended disabled so "add widget" can still surface it
 * instead of it silently vanishing. */
export function resolveDashboardWidgets(settings: {
  dashboardWidgets?: unknown;
  pinnedCards?: unknown;
}): DashboardWidgetEntry[] {
  if (Array.isArray(settings.dashboardWidgets)) {
    const existing = settings.dashboardWidgets.filter(
      (w): w is DashboardWidgetEntry =>
        !!w &&
        typeof w === "object" &&
        typeof (w as DashboardWidgetEntry).id === "string" &&
        typeof (w as DashboardWidgetEntry).enabled === "boolean",
    );
    const seen = new Set(existing.map((w) => w.id));
    for (const id of REGISTRY_IDS) {
      if (!seen.has(id)) existing.push({ id, enabled: false });
    }
    return existing;
  }
  return migrateLegacyPinnedCards(settings.pinnedCards);
}

export function widgetScope(id: string): WidgetScope | null {
  return WIDGET_METAS.find((w) => w.id === id)?.scope ?? null;
}

/** Ordered ids of enabled widgets. Scope never gates visibility - it only
 * decides fetch params + re-render triggers - so account-scoped widgets
 * still render pre-onboarding (against the legacy aggregate history). */
export function enabledWidgetIds(entries: DashboardWidgetEntry[]): string[] {
  return entries.filter((e) => e.enabled).map((e) => e.id);
}

/** Enables/disables a widget, appending it to the end of the layout the
 * first time it's turned on if it wasn't present yet. */
export function setWidgetEnabled(
  entries: DashboardWidgetEntry[],
  id: string,
  enabled: boolean,
): DashboardWidgetEntry[] {
  if (!entries.some((e) => e.id === id)) {
    return enabled ? [...entries, { id, enabled: true }] : entries;
  }
  return entries.map((e) => (e.id === id ? { ...e, enabled } : e));
}

/** Swaps a widget with its neighbour in the given direction; no-op at the
 * ends of the list or for an unknown id. */
export function moveWidget(
  entries: DashboardWidgetEntry[],
  id: string,
  direction: -1 | 1,
): DashboardWidgetEntry[] {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return entries;
  const swapWith = idx + direction;
  if (swapWith < 0 || swapWith >= entries.length) return entries;
  const out = [...entries];
  [out[idx], out[swapWith]] = [out[swapWith]!, out[idx]!];
  return out;
}

/** True when the selected account changed and this widget's content depends
 * on it. Global widgets never need a re-render just because the selection
 * changed. */
export function widgetNeedsAccountRerender(
  id: string,
  prevAccountId: string | null,
  nextAccountId: string | null,
): boolean {
  return widgetScope(id) === "account" && prevAccountId !== nextAccountId;
}

/** Ids among the enabled widgets that need a re-render after an account
 * selection change. */
export function widgetsNeedingAccountRerender(
  entries: DashboardWidgetEntry[],
  prevAccountId: string | null,
  nextAccountId: string | null,
): string[] {
  return enabledWidgetIds(entries).filter((id) =>
    widgetNeedsAccountRerender(id, prevAccountId, nextAccountId),
  );
}
