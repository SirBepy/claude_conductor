import { escapeHtml } from "../../shared/escape-html";
import { tierLabel } from "../../shared/model-name";

/** The model and effort as words ("Sonnet medium", "k3.1-pro medium") - the
 *  battery glyphs this replaces named the model by a fill nobody decoded, and
 *  drew nothing at all for an Endpoint account's foreign id (Joe, 2026-11-24:
 *  "write the actual name of the model and effort"). Empty model gives "". */
export function modelEffortTextHtml(model: string, effort = ""): string {
  const label = tierLabel(model, effort);
  return label ? `<span class="session-model-text" data-tip="${escapeHtml(label)}">${escapeHtml(label)}</span>` : "";
}

/** Renders the project tech-icon badge (bottom-right corner of the character portrait).
 *  Shared by the sidebar rows and the session-header badge (active-session.ts).
 *  `machineId` names the paired peer `cwd` lives on, for a session mirrored
 *  in from a paired peer machine - omitted for every locally-hosted row. */
export function projBadgeHtml(cwd: string | null, cls: string, machineId?: string | null): string {
  if (!cwd) return "";
  const machineAttr = machineId ? ` data-proj-face-machine="${escapeHtml(machineId)}"` : "";
  return `<span class="${cls}"><span class="proj-face" data-proj-face="${escapeHtml(cwd)}"${machineAttr}><i class="ph ph-folder"></i></span></span>`;
}

/** The words for a main chat that picked "Wait for them", shared by the row's mark and
 *  the header's so the surfaces never disagree. */
export const CLOSES_WHEN_SUBS_FINISH = "Closing when its subs finish. Close it again to change your mind.";
