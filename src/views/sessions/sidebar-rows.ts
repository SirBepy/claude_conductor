import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { characterForSession } from "./session-characters";
import { projectName, sessionSubtitle, statusDotClass } from "./sessions-helpers";
import type { SessionSort } from "./sessions-helpers";
import type { PendingNewSession, ParkedDraft } from "./state";
import {
  drainChipHtml,
  leadingVisual,
  scheduledBadgeHtml,
  scheduledCornerHtml,
  modelBatteryHtml,
} from "./sidebar-row-visuals";
import type { LeadingExtras } from "./sidebar-row-visuals";

/** Every sidebar row - live session, draft, or parked draft - is built from
 *  this ONE bag of slot values and rendered by the ONE template below, so a
 *  row type can never grow a markup path of its own again. */
export interface RowOptions {
  idAttr: "session-id" | "placeholder-id";
  id: string;
  liClasses: string;
  liExtraAttrs: string;
  charId: string | null | undefined;
  cwd: string | null;
  /** "" for draft/parked rows - nothing is in flight, no status glow. */
  statusClass: string;
  avatarExtras?: LeadingExtras;
  isPortrait: boolean;
  /** Chat title / draft state text, escaped plain text - safe as both the
   *  landscape project-slot content and the portrait tooltip value. */
  title: string;
  /** Project folder name, escaped. */
  projectLabel: string;
  /** Landscape-only prefix before `title` (the scheduled clock badge). */
  titlePrefix: string;
  /** Remote/autopilot badges after the title (landscape) or project name
   *  (portrait). "" for draft/parked rows. */
  badges: string;
  /** Drain-sort chip appended after `projectLabel` in landscape. */
  drainChip: string;
  /** Portrait's secondary slot: live rows show model battery + drain chip,
   *  draft/parked show `title` so the state text is never dropped. */
  portraitSecondary: string;
  /** Prebuilt `<button>` HTML, or "" (portrait hides the menu for every row type). */
  menuBtn: string;
}

/** The one `<li>` template for the whole sidebar list. */
export function renderSidebarRow(o: RowOptions): string {
  const text = o.isPortrait
    ? `<span class="session-row-project" data-tip="${o.title}"><span class="proj-name">${o.projectLabel}</span>${o.badges}</span>
              <span class="session-chips">${o.portraitSecondary}</span>`
    : `<span class="session-row-project">${o.titlePrefix}${o.title}${o.badges}</span>
              <span class="session-row-subtitle">${o.projectLabel}${o.drainChip}</span>`;
  return `<li data-${o.idAttr}="${escapeHtml(o.id)}"${o.liExtraAttrs} class="${o.liClasses}">
            ${leadingVisual(o.charId, o.statusClass, o.cwd, o.avatarExtras)}
            <div class="session-row-text">
              ${text}
            </div>
            ${o.menuBtn}
          </li>`;
}

/** Maps a live `Instance` + render context to `RowOptions`. */
export function sessionRowOptions(
  s: Instance,
  ctx: {
    isActive: boolean;
    unread: Set<string>;
    attention: Set<string>;
    question: Set<string>;
    rateLimited: ReadonlySet<string>;
    closing: Set<string>;
    isPortrait: boolean;
    rowClass: string;
    sort: SessionSort;
    drainMap: Map<string, number>;
    scheduledCountMap: Map<string, number>;
    kbdHint: string;
  },
): RowOptions {
  const needsAttention = ctx.attention.has(s.session_id);
  const isClosing = ctx.closing.has(s.session_id);
  const drainChip = ctx.sort === "drain" ? drainChipHtml(ctx.drainMap.get(s.session_id)) : "";
  const tipAttr = ctx.isPortrait ? "data-tip" : "title";
  const badges = `${s.is_remote ? `<i class="ph ph-device-mobile session-remote-badge" ${tipAttr}="Remote chat"></i>` : ""}${s.autopilot ? `<span class="autopilot-badge" ${tipAttr}="Autopilot active">autopilot</span>` : ""}`;
  return {
    idAttr: "session-id",
    id: s.session_id,
    liClasses: `${ctx.isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${ctx.rateLimited.has(s.session_id) ? "is-rate-limited" : ""} ${ctx.rowClass}`,
    liExtraAttrs: ctx.kbdHint,
    charId: characterForSession(s),
    cwd: s.cwd,
    statusClass: statusDotClass(s, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited),
    avatarExtras: ctx.isPortrait
      ? { badgeClass: "is-centred", extra: scheduledCornerHtml(ctx.scheduledCountMap.get(s.session_id)) }
      : undefined,
    isPortrait: ctx.isPortrait,
    title: escapeHtml(sessionSubtitle(s)),
    projectLabel: escapeHtml(projectName(s)),
    titlePrefix: ctx.isPortrait ? "" : scheduledBadgeHtml(ctx.scheduledCountMap.get(s.session_id)),
    badges,
    drainChip,
    portraitSecondary: `${modelBatteryHtml(s.model)}${drainChip}`,
    menuBtn: ctx.isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>`,
  };
}

/** Maps a pending draft (unsent, or "starting..." after the first message) to
 *  `RowOptions`. Keyed off `placeholderId`, not a constant - consecutive
 *  drafts need distinct identities so sidebar-anim's keyOf() and exit
 *  suppression never leak from one draft onto the next. */
export function draftRowOptions(
  pending: PendingNewSession,
  isActive: boolean,
  isPortrait: boolean,
  rowClass: string,
): RowOptions {
  const starting = pending.firstMessageSent;
  const title = starting ? "starting..." : "Draft New Chat";
  const rowTitle = starting
    ? "Starting new session... click X to discard if stuck"
    : "Draft — type a message to start";
  return {
    idAttr: "placeholder-id",
    id: pending.placeholderId,
    liClasses: `${isActive ? "active" : ""} pending ${starting ? "" : "draft"} ${rowClass}`,
    liExtraAttrs: ` data-pending="1" title="${rowTitle}"`,
    charId: pending.config.characterId,
    cwd: pending.projectPath,
    statusClass: "",
    avatarExtras: isPortrait ? { badgeClass: "is-centred" } : undefined,
    isPortrait,
    title,
    projectLabel: escapeHtml(pending.projectName || "New session"),
    titlePrefix: "",
    badges: "",
    drainChip: "",
    portraitSecondary: title,
    // 3-dot button hidden in portrait mode, same as live rows - right-click
    // (openMenuForRow in sessions-wiring.ts) is the only way in there.
    menuBtn: isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>`,
  };
}

/** Maps a parked (paused) draft to `RowOptions`. */
export function parkedRowOptions(d: ParkedDraft, isPortrait: boolean, rowClass: string): RowOptions {
  const title = "Draft New Chat";
  return {
    idAttr: "placeholder-id",
    id: d.placeholderId,
    liClasses: `parked-draft ${rowClass}`,
    liExtraAttrs: ` title="Parked draft — click to resume"`,
    charId: d.config.characterId,
    cwd: d.projectPath,
    statusClass: "",
    avatarExtras: isPortrait ? { badgeClass: "is-centred" } : undefined,
    isPortrait,
    title,
    projectLabel: escapeHtml(d.projectName || "New session"),
    titlePrefix: "",
    badges: "",
    drainChip: "",
    portraitSecondary: title,
    menuBtn: isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-parked-placeholder-id="${escapeHtml(d.placeholderId)}">
          <i class="ph ph-dots-three-vertical"></i>
        </button>`,
  };
}
