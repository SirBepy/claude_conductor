import { escapeHtml } from "../../shared/escape-html";
import { modelFamilyFromId } from "../../shared/effort-presets";
import { modelLabel } from "../../shared/model-name";
import { tintedEffort } from "../../shared/chat/dashboard/subs-model";
import "./effort-battery.css";

// Model as a battery whose fill is the family's rank - compare fill, don't
// decode a symbol. One colour: the rail's five chat-state hues own that
// channel. Fable outranks Opus (Joe, 2026-07-30).
const MODEL_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const RANK_ICON: Record<number, string> = {
  1: "ph-battery-low", 2: "ph-battery-medium", 3: "ph-battery-high", 4: "ph-battery-full",
};

/** Phosphor battery class for a model's family rank, or "" when unrecognised. */
export function modelRankIcon(model: string): string {
  const rank = MODEL_RANK[modelFamilyFromId(String(model ?? ""))];
  return rank ? RANK_ICON[rank]! : "";
}

/** Battery glyph for a session's model, or "" for an unrecognised family. The
 *  fill is the model; `effort` tints it (effort-battery.css), and a missing or
 *  default one keeps the battery's own grey. */
export function modelBatteryHtml(model: string, effort = ""): string {
  const icon = modelRankIcon(model);
  if (!icon) return "";
  const tint = tintedEffort(effort);
  const e = tint ? ` data-effort="${escapeHtml(tint)}"` : "";
  const tip = effort ? `${modelLabel(model)}, ${effort}` : modelLabel(model);
  return `<span class="session-model-battery" data-tip="${escapeHtml(tip)}"${e}><i class="ph-bold ${icon}"></i></span>`;
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
