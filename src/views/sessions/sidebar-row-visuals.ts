import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { characterForSession, characterIconUrl } from "./session-characters";
import { statusDotClass, scheduledTooltip } from "./sessions-helpers";
import { modelFamilyFromId } from "../../shared/effort-presets";
import { modelLabel } from "../../shared/model-name";

// ── Portrait row ─────────────────────────────────────────────────────────────
// Model shown as a battery whose fill is the family's rank. Ranked, not
// arbitrary, so you compare fill instead of decoding a symbol; one colour
// because the rail's five chat-state hues already own the colour channel.
// Fable outranks Opus (Joe, 2026-07-30).
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
}

/** Leading visual for a live session row: character portrait + status glow + optional project badge. */
export function leadingVisual(
  s: Instance,
  indicator: string,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
  rateLimited: ReadonlySet<string> = new Set(),
  extras: LeadingExtras = {},
): string {
  const charId = characterForSession(s);
  if (!charId) return indicator;
  const id = escapeHtml(charId);
  const st = statusDotClass(s, unread, attention, question, rateLimited);
  const url = characterIconUrl(charId);
  // Inline the preloaded data URL so the image is filled on first paint and
  // doesn't flash broken when the row is rebuilt. data-hydrated makes the
  // post-render hydrate pass a no-op for already-filled images.
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  // Two layers share the same src so the single hydrate pass fills both:
  //  - backdrop: same art blurred + scaled to cover, fills the strip edge to
  //    edge so a transparent (hexagonal) portrait's corners reveal blurred hero
  //    colours instead of the row background — no hexagon silhouette.
  //  - foreground: the sharp portrait on top.
  const avatarHtml = `<span class="session-avatar ${st}">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(s.cwd, `session-proj-badge${extras.badgeClass ? ` ${extras.badgeClass}` : ""}`);
  return avatarWrap(avatarHtml, badge + (extras.extra ?? ""));
}

/** Leading visual for a draft/parked-draft row: same structure as live rows
 * but no status glow (nothing is in flight). Falls back to a muted icon when
 * the session has no character assigned yet. */
export function draftLeadingVisual(charId: string | null | undefined, cwd: string): string {
  if (!charId) return `<i class="session-state-icon ph ph-chat-circle-dots"></i>`;
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  const avatarHtml = `<span class="session-avatar">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(cwd, "session-proj-badge");
  return avatarWrap(avatarHtml, badge);
}
