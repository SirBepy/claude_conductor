// The real widget registry (multi-account milestone 05): wires the pure
// scope/order rules in dashboard-widget-logic.ts to actual render functions.
// Widget ids/scopes here MUST match `WIDGET_METAS` in dashboard-widget-logic.ts.

import type { Widget } from "./widgets/types";
import { todayWidget } from "./widgets/today-widget";
import { renderSkillUsageWidget } from "./widgets/skill-usage-widget";
import {
  sessionChartWidget,
  sessionBarsWidget,
  weeklyChartWidget,
  weeklyBarsWidget,
} from "./widgets/usage-charts";
import { tokenSourceWidget } from "./token-source-widget";

const skillUsageWidget: Widget = {
  id: "skill-usage",
  title: "Skills (last 7 days)",
  icon: "ph-wrench",
  scope: "global",
  dataDeps: ["skillUsage"],
  render: (root) => renderSkillUsageWidget(root),
};

export const WIDGETS: Widget[] = [
  todayWidget,
  skillUsageWidget,
  sessionChartWidget,
  sessionBarsWidget,
  weeklyChartWidget,
  weeklyBarsWidget,
  tokenSourceWidget,
];

export function getWidget(id: string): Widget | undefined {
  return WIDGETS.find((w) => w.id === id);
}

export type { Widget, WidgetContext } from "./widgets/types";
export {
  migrateLegacyPinnedCards,
  resolveDashboardWidgets,
  widgetScope,
  enabledWidgetIds,
  setWidgetEnabled,
  moveWidget,
  widgetNeedsAccountRerender,
  widgetsNeedingAccountRerender,
  WIDGET_METAS,
} from "./dashboard-widget-logic";
export type { DashboardWidgetEntry, WidgetScope } from "./dashboard-widget-logic";
