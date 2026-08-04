import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { markerToStatusClass } from "../../shared/status-icons";
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
  /** `st-*` ring class applied to `.session-avatar` in every mode. */
  statusClass: string;
  avatarExtras?: LeadingExtras;
  isPortrait: boolean;
  /** Chat title, escaped plain text - the landscape project-slot content and
   *  the portrait tooltip value. "" for draft/parked - no name to show. */
  title: string;
  /** Project folder name, escaped. */
  projectLabel: string;
  /** Landscape-only prefix before `title` (the scheduled clock badge). */
  titlePrefix: string;
  /** Remote/autopilot badges after the title (landscape) or project name
   *  (portrait). Empty when the row has neither flag set. */
  badges: string;
  /** Drain-sort chip appended after `projectLabel` in landscape. */
  drainChip: string;
  /** Portrait's secondary slot: model battery + drain chip, for every row kind. */
  portraitSecondary: string;
  /** Prebuilt `<button>` HTML, or "" (portrait hides the menu for every row type). */
  menuBtn: string;
}

/** The one `<li>` template for the whole sidebar list. */
export function renderSidebarRow(o: RowOptions): string {
  // `title` is "" for draft/parked rows (no chat name to show) - classic falls
  // back to a single project-name line instead of an empty heading over it.
  const text = o.isPortrait
    ? `<span class="session-row-project" data-tip="${o.title}"><span class="proj-name">${o.projectLabel}</span>${o.badges}</span>
              <span class="session-chips">${o.portraitSecondary}</span>`
    : o.title
      ? `<span class="session-row-project">${o.titlePrefix}${o.title}${o.badges}</span>
              <span class="session-row-subtitle">${o.projectLabel}${o.drainChip}</span>`
      : `<span class="session-row-project">${o.titlePrefix}${o.projectLabel}${o.badges}</span>`;
  return `<li data-${o.idAttr}="${escapeHtml(o.id)}"${o.liExtraAttrs} class="${o.liClasses}">
            ${leadingVisual(o.charId, o.statusClass, o.cwd, o.avatarExtras)}
            <div class="session-row-text">
              ${text}
            </div>
            ${o.menuBtn}
          </li>`;
}

/** The dot a live row shows when nothing is in flight - `statusDotClass`'s
 *  own fallthrough. Draft/parked rows have no backing `Instance` to run
 *  through that function, so they reuse its idle result directly rather
 *  than inventing a separate "no dot" state. */
const IDLE_DOT_CLASS = markerToStatusClass("done");

/** Shared slot-filling for every row kind - identity (id/classes/menu) comes
 *  from the caller, every visual field below is computed identically
 *  regardless of whether the row is a live session, draft, or parked draft. */
function buildRowOptions(args: {
  identity: {
    idAttr: "session-id" | "placeholder-id";
    id: string;
    liClasses: string;
    liExtraAttrs: string;
    menuBtn: string;
  };
  charId: string | null | undefined;
  cwd: string | null;
  title: string;
  projectLabel: string;
  isPortrait: boolean;
  /** Ring class for `.session-avatar` (landscape + portrait). */
  avatarStatusClass: string;
  /** Portrait-only bottom-left dot; differs from `avatarStatusClass` only
   *  for a closing live session. */
  dotClass: string;
  isRemote: boolean;
  isAutopilot: boolean;
  scheduledCount: number | undefined;
  model: string;
  drainChip: string;
}): RowOptions {
  const tipAttr = args.isPortrait ? "data-tip" : "title";
  const badges = `${args.isRemote ? `<i class="ph ph-device-mobile session-remote-badge" ${tipAttr}="Remote chat"></i>` : ""}${args.isAutopilot ? `<span class="autopilot-badge" ${tipAttr}="Autopilot active">autopilot</span>` : ""}`;
  return {
    idAttr: args.identity.idAttr,
    id: args.identity.id,
    liClasses: args.identity.liClasses,
    liExtraAttrs: args.identity.liExtraAttrs,
    charId: args.charId,
    cwd: args.cwd,
    statusClass: args.avatarStatusClass,
    avatarExtras: args.isPortrait
      ? { badgeClass: "is-centred", extra: scheduledCornerHtml(args.scheduledCount), dotClass: args.dotClass }
      : undefined,
    isPortrait: args.isPortrait,
    title: escapeHtml(args.title),
    projectLabel: escapeHtml(args.projectLabel),
    titlePrefix: args.isPortrait ? "" : scheduledBadgeHtml(args.scheduledCount),
    badges,
    drainChip: args.drainChip,
    portraitSecondary: `${modelBatteryHtml(args.model)}${args.drainChip}`,
    menuBtn: args.identity.menuBtn,
  };
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
  const statusClass = statusDotClass(s, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited);
  // Closing overrides the portrait DOT only, not statusClass/.session-avatar -
  // statusDotClass has no closing awareness, and classic (which never renders
  // the dot) must keep reading its pre-closing colour unchanged.
  const dotClass = isClosing ? "st-closing" : statusClass;
  return buildRowOptions({
    identity: {
      idAttr: "session-id",
      id: s.session_id,
      liClasses: `${ctx.isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${ctx.rateLimited.has(s.session_id) ? "is-rate-limited" : ""} ${ctx.rowClass}`,
      liExtraAttrs: ctx.kbdHint,
      menuBtn: ctx.isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>`,
    },
    charId: characterForSession(s),
    cwd: s.cwd,
    title: sessionSubtitle(s),
    projectLabel: projectName(s),
    isPortrait: ctx.isPortrait,
    avatarStatusClass: statusClass,
    dotClass,
    isRemote: !!s.is_remote,
    isAutopilot: !!s.autopilot,
    scheduledCount: ctx.scheduledCountMap.get(s.session_id),
    model: s.model,
    drainChip,
  });
}

/** Maps a pending draft (unsent, or "starting..." after the first message) to
 *  `RowOptions`. Keyed off `placeholderId` - consecutive drafts need distinct
 *  identities so sidebar-anim's keyOf()/exit suppression don't leak. The
 *  unsent/starting split now lives only in `liClasses`'s "draft" class. */
export function draftRowOptions(
  pending: PendingNewSession,
  isActive: boolean,
  isPortrait: boolean,
  rowClass: string,
): RowOptions {
  const starting = pending.firstMessageSent;
  return buildRowOptions({
    identity: {
      idAttr: "placeholder-id",
      id: pending.placeholderId,
      liClasses: `${isActive ? "active" : ""} pending ${starting ? "" : "draft"} ${rowClass}`,
      liExtraAttrs: ` data-pending="1"`,
      // 3-dot button hidden in portrait mode, same as live rows - right-click
      // (openMenuForRow in sessions-wiring.ts) is the only way in there.
      menuBtn: isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
              <i class="ph ph-dots-three-vertical"></i>
            </button>`,
    },
    charId: pending.config.characterId,
    cwd: pending.projectPath,
    title: "",
    projectLabel: pending.projectName || "New session",
    isPortrait,
    avatarStatusClass: IDLE_DOT_CLASS,
    dotClass: IDLE_DOT_CLASS,
    isRemote: !!pending.config.remote,
    isAutopilot: false,
    scheduledCount: undefined,
    model: pending.config.model,
    drainChip: "",
  });
}

/** Maps a parked (paused) draft to `RowOptions`. */
export function parkedRowOptions(d: ParkedDraft, isPortrait: boolean, rowClass: string): RowOptions {
  return buildRowOptions({
    identity: {
      idAttr: "placeholder-id",
      id: d.placeholderId,
      liClasses: `parked-draft ${rowClass}`,
      liExtraAttrs: "",
      menuBtn: isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="Draft options" data-parked-placeholder-id="${escapeHtml(d.placeholderId)}">
          <i class="ph ph-dots-three-vertical"></i>
        </button>`,
    },
    charId: d.config.characterId,
    cwd: d.projectPath,
    title: "",
    projectLabel: d.projectName || "New session",
    isPortrait,
    avatarStatusClass: IDLE_DOT_CLASS,
    dotClass: IDLE_DOT_CLASS,
    isRemote: !!d.config.remote,
    isAutopilot: false,
    scheduledCount: undefined,
    model: d.config.model,
    drainChip: "",
  });
}
