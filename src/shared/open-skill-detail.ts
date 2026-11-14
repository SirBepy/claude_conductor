// One way to open a skill's detail screen from anywhere (a chip, a table row,
// a chart bar). skill-detail reads its target from this window global rather
// than a route param, so setting it and routing must always happen together.

import { getActiveView, showView } from "./navigation";
import { closeSettingsPopup, isSettingsPopupOpen } from "./settings-popup";

/** The view the detail screen was opened from. The Skills list has no entry
 *  point of its own, so Back returns here instead of to that list. */
let cameFrom: string | null = null;

export function openSkillDetail(skill: string): void {
  const from = getActiveView();
  if (from !== "skill-detail") cameFrom = from;
  (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = skill;
  showView("skill-detail");
}

/** Back from the detail screen: closes the settings popup it opened in, else
 *  returns to the view it was opened from. */
export function leaveSkillDetail(): void {
  if (isSettingsPopupOpen()) {
    closeSettingsPopup();
    return;
  }
  showView(cameFrom && cameFrom !== "skill-detail" ? cameFrom : "dashboard");
}
