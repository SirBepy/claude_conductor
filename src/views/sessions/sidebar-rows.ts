import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { projectName, sessionSubtitle, statusIndicator } from "./sessions-helpers";
import type { SessionSort, SessionStateStyle } from "./sessions-helpers";
import type { PendingNewSession, ParkedDraft } from "./state";
import {
  drainChipHtml,
  leadingVisual,
  draftLeadingVisual,
  scheduledBadgeHtml,
  scheduledCornerHtml,
  modelBatteryHtml,
} from "./sidebar-row-visuals";

/** Renders a live-session row's `<li>`, shared by the segmented list AND
 *  Hidden so their badges/classes can never drift apart. `kbdHint` is the
 *  pre-formed ` data-kbd-hint="n"` attribute, "" for Hidden rows. */
export function renderSessionRow(
  s: Instance,
  ctx: {
    isActive: boolean;
    unread: Set<string>;
    attention: Set<string>;
    question: Set<string>;
    rateLimited: ReadonlySet<string>;
    closing: Set<string>;
    style: SessionStateStyle;
    isPortrait: boolean;
    rowClass: string;
    sort: SessionSort;
    drainMap: Map<string, number>;
    scheduledCountMap: Map<string, number>;
    kbdHint: string;
  },
): string {
  const indicator = statusIndicator(s, ctx.unread, ctx.attention, ctx.question, ctx.style, escapeHtml, ctx.rateLimited);
  const needsAttention = ctx.attention.has(s.session_id);
  const isClosing = ctx.closing.has(s.session_id);
  return `<li data-session-id="${escapeHtml(s.session_id)}"${ctx.kbdHint} class="${ctx.isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${ctx.rateLimited.has(s.session_id) ? "is-rate-limited" : ""} ${ctx.rowClass}">
            ${ctx.isPortrait
              ? leadingVisual(s, indicator, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited, {
                  badgeClass: "is-centred",
                  extra: scheduledCornerHtml(ctx.scheduledCountMap.get(s.session_id)),
                })
              : leadingVisual(s, indicator, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited)}
            <div class="session-row-text">
              ${ctx.isPortrait
                ? `<span class="session-row-project" data-tip="${escapeHtml(sessionSubtitle(s))}"><span class="proj-name">${escapeHtml(projectName(s))}</span>${s.is_remote ? `<i class="ph ph-device-mobile session-remote-badge" data-tip="Remote chat"></i>` : ""}${s.autopilot ? `<span class="autopilot-badge" data-tip="Autopilot active">autopilot</span>` : ""}</span>
              <span class="session-chips">${modelBatteryHtml(s.model)}${ctx.sort === "drain" ? drainChipHtml(ctx.drainMap.get(s.session_id)) : ""}</span>`
                : `<span class="session-row-project">${scheduledBadgeHtml(ctx.scheduledCountMap.get(s.session_id))}${escapeHtml(sessionSubtitle(s))}${s.is_remote ? `<i class="ph ph-device-mobile session-remote-badge" title="Remote chat"></i>` : ""}${s.autopilot ? `<span class="autopilot-badge" title="Autopilot active">autopilot</span>` : ""}</span>
              <span class="session-row-subtitle">${escapeHtml(projectName(s))}${ctx.sort === "drain" ? drainChipHtml(ctx.drainMap.get(s.session_id)) : ""}</span>`}
            </div>
            ${ctx.isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>`}
          </li>`;
}

/** Pending draft row: unsent-draft markup before the first message, the
 *  "starting..." placeholder after. */
export function renderDraftRow(
  pending: PendingNewSession,
  isActive: boolean,
  isPortrait: boolean,
  rowClass: string,
): string {
  const activeCls = isActive ? "active" : "";
  // Key by placeholderId, NOT a constant "pending": consecutive drafts must
  // have distinct keys. A constant key let a just-discarded draft's exit
  // suppression (exitingKeys) leak onto the next draft, so the new draft was
  // filtered out and never rendered until its key changed (i.e. a message
  // turned it into a real session). The li carries data-placeholder-id so
  // keyOf() in sidebar-anim derives the matching `p:<id>` key.
  const pid = escapeHtml(pending.placeholderId);
  // 3-dot button hidden in portrait mode, same as live rows - right-click
  // (wired in sessions.ts's openMenuForRow) is the only way in there.
  return !pending.firstMessageSent
    ? `<li class="${activeCls} pending draft ${rowClass}" data-pending="1" data-placeholder-id="${pid}" title="Draft — type a message to start">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">Draft New Chat</span>
            <span class="session-row-subtitle">${escapeHtml(pending.projectName || "New session")}</span>
          </div>
          ${isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>`}
        </li>`
    : `<li class="${activeCls} pending ${rowClass}" data-pending="1" data-placeholder-id="${pid}" title="Starting new session... click X to discard if stuck">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">starting...</span>
            <span class="session-row-subtitle">${escapeHtml(pending.projectName || "New session")}</span>
          </div>
          ${isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>`}
        </li>`;
}

/** Parked-draft row markup (paused draft, resumes on click). */
export function renderParkedDraftRow(d: ParkedDraft, isPortrait: boolean, rowClass: string): string {
  return `<li class="parked-draft ${rowClass}" data-placeholder-id="${escapeHtml(d.placeholderId)}" title="Parked draft — click to resume">
        ${draftLeadingVisual(d.config.characterId, d.projectPath)}
        <div class="session-row-text">
          <span class="session-row-project">Draft New Chat</span>
          <span class="session-row-subtitle">${escapeHtml(d.projectName || "New session")}</span>
        </div>
        ${isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-parked-placeholder-id="${escapeHtml(d.placeholderId)}">
          <i class="ph ph-dots-three-vertical"></i>
        </button>`}
      </li>`;
}
