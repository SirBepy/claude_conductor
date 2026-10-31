// One way to open a skill's detail screen from anywhere (a chip, a table row,
// a chart bar). skill-detail reads its target from this window global rather
// than a route param, so setting it and routing must always happen together.

import { showView } from "./navigation";

export function openSkillDetail(skill: string): void {
  (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = skill;
  showView("skill-detail");
}
