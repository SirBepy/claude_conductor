import { escapeHtml } from "../../shared/escape-html";
import { characterIconUrl } from "./session-characters";
import { scheduledTooltip } from "./sessions-helpers";
import { modelFamilyFromId } from "../../shared/effort-presets";
import { modelLabel } from "../../shared/model-name";

// Model as a battery whose fill is the family's rank - compare fill, don't
// decode a symbol. One colour: the rail's five chat-state hues own that
// channel. Fable outranks Opus (Joe, 2026-07-30).
const MODEL_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const RANK_ICON: Record<number, string> = {
  1: "ph-battery-low", 2: "ph-battery-medium", 3: "ph-battery-high", 4: "ph-battery-full",
};

/** Battery glyph for a session's model, or "" for an unrecognised family. */
export function modelBatteryHtml(model: string): string {
  const rank = MODEL_RANK[modelFamilyFromId(String(model ?? ""))];
  if (!rank) return "";
  return `<span class="session-model-battery" data-tip="${escapeHtml(modelLabel(model))}"><i class="ph-bold ${RANK_ICON[rank]}"></i></span>`;
}

/** Scheduled marker for the portrait row: a corner badge on the character
 *  rather than a chip in the text line, so the battery stays the only
 *  right-hand element and sits at a fixed x on every row. */
export function scheduledCornerHtml(count: number | undefined): string {
  if (!count) return "";
  const title = escapeHtml(scheduledTooltip(count));
  const countHtml = count > 1 ? `<span class="session-sched-count">${count}</span>` : "";
  return `<span class="session-sched-corner" data-tip="${title}"><i class="ph ph-clock-countdown"></i>${countHtml}</span>`;
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
 *  Shared by the sidebar rows and the session-header badge (active-session.ts). */
export function projBadgeHtml(cwd: string | null, cls: string): string {
  if (!cwd) return "";
  return `<span class="${cls}"><span class="proj-face" data-proj-face="${escapeHtml(cwd)}"><i class="ph ph-folder"></i></span></span>`;
}

/** Sidebar row's "has pending scheduled message(s)" marker: a clock icon
 *  prefixed before the session title (never clipped by the title's own
 *  ellipsis truncation, unlike a trailing badge), with a count badge ONLY
 *  when more than one is pending (a single scheduled item shows just the
 *  marker, per Joe's ask). Purely visual - no effect on statusPriority/sort.
 *  Mirrors the per-chat scheduled-chip's icon + count-span pattern
 *  (scheduled-chip.ts) so the two read as the same affordance. Persists
 *  unchanged while an item is "firing" (no distinct in-flight look for v1 -
 *  counts already include firing, same as scheduled-chip's filter). */
export function scheduledBadgeHtml(count: number | undefined): string {
  if (!count) return "";
  const title = escapeHtml(scheduledTooltip(count));
  const countHtml = count > 1 ? `<span class="session-scheduled-count">${count}</span>` : "";
  return `<span class="session-scheduled-badge" title="${title}"><i class="ph ph-clock-countdown"></i>${countHtml}</span>`;
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
  /** Portrait-only status dot class (`st-*`), rendered bottom-left on the circle. */
  dotClass?: string;
}

/** Leading visual for ANY sidebar row - live session, draft, or parked draft.
 *  `statusClass` is "" for draft/parked (nothing in flight, no glow). Always
 *  emits the same 40px avatar-wrap structure, even with no character assigned
 *  yet: a centred placeholder glyph inside `.session-avatar`, never a bare
 *  icon that would collapse the row's geometry. */
export function leadingVisual(
  charId: string | null | undefined,
  statusClass: string,
  cwd: string | null,
  extras: LeadingExtras = {},
): string {
  const badge = projBadgeHtml(cwd, `session-proj-badge${extras.badgeClass ? ` ${extras.badgeClass}` : ""}`);
  const dot = extras.dotClass ? `<span class="avatar-status-dot ${extras.dotClass}"></span>` : "";
  if (!charId) {
    const avatarHtml = `<span class="session-avatar session-avatar--placeholder ${statusClass}">
          <i class="ph ph-chat-circle-dots"></i>
        </span>`;
    return avatarWrap(avatarHtml, badge + dot + (extras.extra ?? ""));
  }
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  // Preloaded data URL so the image fills on first paint; data-hydrated makes
  // the post-render hydrate pass a no-op once already filled.
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  // Backdrop: same art blurred+scaled to cover, so a transparent (hexagonal)
  // portrait's corners reveal hero colours instead of the row background.
  const avatarHtml = `<span class="session-avatar ${statusClass}">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  return avatarWrap(avatarHtml, badge + dot + (extras.extra ?? ""));
}
