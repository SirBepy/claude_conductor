import { escapeHtml } from "../../shared/escape-html";
import { characterIconUrl } from "./session-characters";
import { scheduledTooltip, heldTooltip } from "./sessions-helpers";
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

/** Shared shape for scheduled/held markers: an icon + optional count span,
 *  wrapped in a tooltip-bearing span. `alwaysShowCount` is the one
 *  intentional behavioral fork - scheduled hides the count at 1, held
 *  always shows it - so it stays an explicit option, never a branch here. */
function markerHtml(
  count: number | undefined,
  opts: { icon: string; cssClass: string; countClass: string; tipAttr: "title" | "data-tip"; tooltip: string; alwaysShowCount: boolean },
): string {
  if (!count) return "";
  const title = escapeHtml(opts.tooltip);
  const showCount = opts.alwaysShowCount || count > 1;
  const countHtml = showCount ? `<span class="${opts.countClass}">${count}</span>` : "";
  return `<span class="${opts.cssClass}" ${opts.tipAttr}="${title}"><i class="ph ${opts.icon}"></i>${countHtml}</span>`;
}

/** Scheduled marker for the portrait row: a corner badge on the character
 *  rather than a chip in the text line, so the battery stays the only
 *  right-hand element and sits at a fixed x on every row. */
export function scheduledCornerHtml(count: number | undefined): string {
  return markerHtml(count, {
    icon: "ph-clock-countdown", cssClass: "session-sched-corner", countClass: "session-sched-count",
    tipAttr: "data-tip", tooltip: scheduledTooltip(count ?? 0), alwaysShowCount: false,
  });
}

/** Held-message marker, portrait avatar's corner opposite the scheduled one
 *  (so the two never overlap); count always shows, unlike scheduledCornerHtml. */
export function heldCornerHtml(count: number | undefined): string {
  return markerHtml(count, {
    icon: "ph-paper-plane-tilt", cssClass: "session-held-corner", countClass: "session-held-count",
    tipAttr: "data-tip", tooltip: heldTooltip(count ?? 0), alwaysShowCount: true,
  });
}

/** Inline "X% of 5h" chip shown in a row's subtitle while sorting by drain.
 *  Muted "—% of 5h" placeholder until the async drain fetch resolves. */
export function drainChipHtml(pct: number | undefined): string {
  if (pct === undefined) {
    return ` <span class="session-row-drain session-row-drain--unknown" title="Token drain (loading...)">—% of 5h</span>`;
  }
  return ` <span class="session-row-drain" title="This chat's share of your current 5h session">${Math.round(pct)}% of 5h</span>`;
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

/** Red dots for the subs asking Joe something, one each (the main chat's own
 *  question included). Shared by a Main chats row and the group's header, where
 *  they keep showing while the group is collapsed. "" for none. */
export function askingDotsHtml(count: number): string {
  if (count <= 0) return "";
  const label = `${count} waiting on you`;
  return `<span class="ask-dots" role="img" aria-label="${label}">${'<i class="ask-dot"></i>'.repeat(count)}</span>`;
}

/** The words for a main chat that picked "Wait for them", shared by the row's mark and
 *  the header's so the surfaces never disagree. */
export const CLOSES_WHEN_SUBS_FINISH = "Closing when its subs finish. Close it again to change your mind.";

/** The quiet mark on a main chat that picked "Wait for them": an hourglass where the
 *  chips sit, with the sentence as its tooltip. "" when the chat is not waiting. */
export function closeWaitChipHtml(on: boolean | undefined, tipAttr: "title" | "data-tip"): string {
  if (!on) return "";
  return `<span class="session-close-wait" ${tipAttr}="${CLOSES_WHEN_SUBS_FINISH}" role="img" aria-label="${CLOSES_WHEN_SUBS_FINISH}"><i class="ph ph-hourglass-medium"></i></span>`;
}

/** "3x": how many subs a main chat has, running and finished, standing where the
 *  model battery would. No word: a bare count is the quietest thing that still
 *  says "this one has subs behind it". */
export function subCountHtml(count: number): string {
  return `<span class="session-sub-count">${count}x</span>`;
}

/** Frozen-chat marker: a bare snowflake in the chips slot (same slot as
 *  `modelBatteryHtml`), plus `frozenRowClass` tinting the whole row - replaces
 *  the old uppercase text chip, which ate into a portrait row's one text line
 *  and could truncate the project name (Joe, 2026-10-01). */
export function frozenChipHtml(frozen: boolean, autoFrozen: boolean, tipAttr: "title" | "data-tip"): string {
  if (!frozen) return "";
  const title = autoFrozen ? "Frozen - waiting for your usage limit to reset" : "Frozen - click Unfreeze chat to resume";
  return `<span class="frozen-chip${autoFrozen ? " frozen-chip--auto" : ""}" ${tipAttr}="${title}"><i class="ph-bold ph-snowflake"></i></span>`;
}

/** Row-level tint class for a frozen chat - `""` when not frozen. Auto-frozen
 *  reuses the "waiting" hue (same bind as `frozen-chip--auto` above) since a
 *  rate-limit auto-freeze IS a waiting state. */
export function frozenRowClass(frozen: boolean, autoFrozen: boolean): string {
  if (!frozen) return "";
  return autoFrozen ? " is-frozen-bg is-auto" : " is-frozen-bg";
}

/** Wrap an avatar strip + optional project badge in the positioning wrapper. */
function avatarWrap(avatarHtml: string, badge: string): string {
  return `<span class="session-avatar-wrap">${avatarHtml}${badge}</span>`;
}


/** Extra bits the portrait row hangs off the same avatar wrapper. */
export interface LeadingExtras {
  /** Appended to the project badge's class list (`is-centred` in portrait rows). */
  badgeClass?: string;
  /** Markup appended inside the wrapper, after the badge (the scheduled corner). */
  extra?: string;
  /** The status ring markup (`ringHtml`), "" when the row has no ring. It
   *  replaced the old bottom-left dot as the portrait row's status signal. */
  ringHtml?: string;
  /** True for a close_failed row: the ring's orange collides with
   *  rate-limited, so a warning glyph is the one spare channel left. */
  warn?: boolean;
  /** Set only for a session mirrored in from a paired peer machine (multi-
   *  machine federation); undefined/null for every locally-hosted row. */
  machineId?: string | null;
}

/** Leading visual for ANY sidebar row - live session, draft, or parked draft.
 *  `statusClass` is "" for draft/parked (nothing in flight, no glow). Always
 *  emits the same 40px avatar-wrap structure, even with no character assigned
 *  yet: a centred placeholder glyph inside `.session-avatar`, never a bare
 *  icon that would collapse the row's geometry. `statusTitle` is "" for every
 *  state except close_failed (todo 461) - other states have no hover copy
 *  wired here yet, so this stays scoped rather than rolling out tooltips app-wide. */
export function leadingVisual(
  charId: string | null | undefined,
  statusClass: string,
  cwd: string | null,
  extras: LeadingExtras = {},
  statusTitle = "",
): string {
  const badge = projBadgeHtml(cwd, `session-proj-badge${extras.badgeClass ? ` ${extras.badgeClass}` : ""}`, extras.machineId);
  // close_failed shares its orange with st-rate-limited (sessions.css), so the
  // ring alone can't read as distinct - a glyph is the only spare channel left.
  const ring = (extras.ringHtml ?? "") + (extras.warn ? `<span class="avatar-warn"><i class="ph-bold ph-warning"></i></span>` : "");
  const titleAttr = statusTitle ? ` title="${escapeHtml(statusTitle)}"` : "";
  if (!charId) {
    const avatarHtml = `<span class="session-avatar session-avatar--placeholder ${statusClass}"${titleAttr}>
          <i class="ph ph-chat-circle-dots"></i>
        </span>`;
    return avatarWrap(avatarHtml, badge + ring + (extras.extra ?? ""));
  }
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  // Preloaded data URL so the image fills on first paint; data-hydrated makes
  // the post-render hydrate pass a no-op once already filled.
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  // Backdrop: same art blurred+scaled to cover, so a transparent (hexagonal)
  // portrait's corners reveal hero colours instead of the row background.
  const avatarHtml = `<span class="session-avatar ${statusClass}"${titleAttr}>
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  return avatarWrap(avatarHtml, badge + ring + (extras.extra ?? ""));
}
