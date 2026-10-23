// Widget registry contract (multi-account milestone 05). See
// docs/multi-account/05-dashboard-rework.md and dashboard-widget-logic.ts
// for the pure scope/enable/order rules this type plugs into.

export type WidgetScope = "global" | "account";

export interface WidgetContext {
  /** Selected account-selector card, or `null` pre-onboarding (empty
   * registry) - account-scoped widgets fall back to the legacy aggregate
   * history in that case (no `account_id` filter). */
  accountId: string | null;
  /** True once at least one account is registered - lets a widget tell
   * "no accounts yet" apart from "account exists but has no data". */
  hasAccounts: boolean;
}

export interface Widget {
  id: string;
  title: string;
  /** Phosphor icon name (e.g. "ph-chart-line") shown next to the title in the
   * widget header + the "add widget" menu so each widget is recognisable
   * without opening it. */
  icon: string;
  scope: WidgetScope;
  /** Takes half the width: adjacent half widgets share a two-column block
   * balanced by height (dashboard.ts `rebalanceWidgets`); a lone one spans. */
  half?: boolean;
  /** Documents what live-data events should trigger a re-render; dashboard.ts
   * currently just re-renders every mounted widget on history/token-history
   * updates (matching the pre-milestone dashboard's full-rebuild behaviour),
   * so this is advisory/for future incremental refresh rather than enforced. */
  dataDeps: string[];
  /** Renders into `root` (the widget body element - dashboard.ts owns the
   * surrounding shell/header/tag). Returns an optional teardown, called
   * before the widget is unmounted or re-rendered. */
  render(root: HTMLElement, ctx: WidgetContext): (() => void) | void;
}
