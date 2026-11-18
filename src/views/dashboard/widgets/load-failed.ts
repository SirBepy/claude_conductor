// A widget that fetches its own data once on mount marks its body while that load has failed, so the
// dashboard's unchanged-data refresh can remount it (the old per-minute rebuild was the retry).

const ATTR = "data-load-failed";

export function setLoadFailed(root: HTMLElement, failed: boolean): void {
  if (failed) root.setAttribute(ATTR, "");
  else root.removeAttribute(ATTR);
}

/** Widget ids, from the dashboard container, whose body still shows a failed load. */
export function failedWidgetIds(container: HTMLElement): string[] {
  const ids: string[] = [];
  container.querySelectorAll<HTMLElement>(`.dash-widget[data-widget-id] .dash-widget-body[${ATTR}]`).forEach((body) => {
    const id = body.closest<HTMLElement>(".dash-widget")?.dataset["widgetId"];
    if (id) ids.push(id);
  });
  return ids;
}
