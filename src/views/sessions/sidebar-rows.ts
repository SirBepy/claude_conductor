import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { markerToStatusClass } from "../../shared/status-icons";
import { characterForSession } from "./session-characters";
import { projectName, sessionSubtitle, statusDotClass, stateTooltip } from "./sessions-helpers";
import type { SessionSort } from "./sessions-helpers";
import type { PendingNewSession, ParkedDraft } from "./state";
import {
  drainChipHtml,
  frozenBadgeHtml,
  leadingVisual,
  scheduledCornerHtml,
  heldCornerHtml,
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
  /** Hover text on `.session-avatar`. "" for every state but close_failed. */
  statusTitle: string;
  avatarExtras?: LeadingExtras;
  /** Chat title, escaped plain text - the portrait tooltip value. "" for draft/parked - no name to show. */
  title: string;
  /** Project folder name, escaped. */
  projectLabel: string;
  /** Remote/autopilot badges after the project name. "" when neither flag is set. */
  badges: string;
  /** Portrait's secondary slot: model battery + drain chip, for every row kind. */
  portraitSecondary: string;
}

/** The one `<li>` template for the whole sidebar list. */
export function renderSidebarRow(o: RowOptions): string {
  const text = `<span class="session-row-project" data-tip="${o.title}"><span class="proj-name">${o.projectLabel}</span>${o.badges}</span>
              <span class="session-chips">${o.portraitSecondary}</span>`;
  return `<li data-${o.idAttr}="${escapeHtml(o.id)}"${o.liExtraAttrs} class="${o.liClasses}">
            ${leadingVisual(o.charId, o.statusClass, o.cwd, o.avatarExtras, o.statusTitle)}
            <div class="session-row-text">
              ${text}
            </div>
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
  };
  charId: string | null | undefined;
  cwd: string | null;
  title: string;
  projectLabel: string;
  /** Ring class for `.session-avatar` (landscape + portrait). */
  avatarStatusClass: string;
  /** Hover text for `.session-avatar`. "" for every state but close_failed. */
  statusTitle?: string;
  /** Portrait-only bottom-left dot; differs from `avatarStatusClass` only
   *  for a closing live session. */
  dotClass: string;
  isRemote: boolean;
  isAutopilot: boolean;
  frozen: boolean;
  autoFrozen: boolean;
  scheduledCount: number | undefined;
  heldCount: number | undefined;
  model: string;
  drainChip: string;
}): RowOptions {
  const tipAttr = "data-tip";
  const badges = `${args.isRemote ? `<i class="ph ph-device-mobile session-remote-badge" ${tipAttr}="Remote chat"></i>` : ""}${args.isAutopilot ? `<span class="autopilot-badge" ${tipAttr}="Autopilot active">autopilot</span>` : ""}${frozenBadgeHtml(args.frozen, args.autoFrozen, tipAttr)}`;
  return {
    idAttr: args.identity.idAttr,
    id: args.identity.id,
    liClasses: args.identity.liClasses,
    liExtraAttrs: args.identity.liExtraAttrs,
    charId: args.charId,
    cwd: args.cwd,
    statusClass: args.avatarStatusClass,
    statusTitle: args.statusTitle ?? "",
    avatarExtras: {
      badgeClass: "is-centred",
      extra: scheduledCornerHtml(args.scheduledCount) + heldCornerHtml(args.heldCount),
      dotClass: args.dotClass,
    },
    title: escapeHtml(args.title),
    projectLabel: escapeHtml(args.projectLabel),
    badges,
    portraitSecondary: `${modelBatteryHtml(args.model)}${args.drainChip}`,
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
  // Only close_failed gets a hover title today - the tooltip cascade
  // (stateTooltip) exists for every state, but wiring the rest into the DOM
  // is a separate concern from todo 461.
  const statusTitle = statusClass === "st-close-failed"
    ? stateTooltip(s, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited)
    : "";
  // Closing overrides the DOT only, not statusClass/.session-avatar - statusDotClass has no closing awareness.
  const dotClass = isClosing ? "st-closing" : statusClass;
  return buildRowOptions({
    identity: {
      idAttr: "session-id",
      id: s.session_id,
      liClasses: `${ctx.isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${ctx.rateLimited.has(s.session_id) ? "is-rate-limited" : ""} row-portrait`,
      liExtraAttrs: ctx.kbdHint,
    },
    charId: characterForSession(s),
    cwd: s.cwd,
    title: sessionSubtitle(s),
    projectLabel: projectName(s),
    avatarStatusClass: statusClass,
    statusTitle,
    dotClass,
    isRemote: !!s.is_remote,
    isAutopilot: !!s.autopilot,
    frozen: !!s.frozen,
    autoFrozen: !!s.auto_frozen,
    scheduledCount: ctx.scheduledCountMap.get(s.session_id),
    heldCount: s.held_count || undefined,
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
): RowOptions {
  const starting = pending.firstMessageSent;
  return buildRowOptions({
    identity: {
      idAttr: "placeholder-id",
      id: pending.placeholderId,
      liClasses: `${isActive ? "active" : ""} pending ${starting ? "" : "draft"} row-portrait`,
      liExtraAttrs: ` data-pending="1"`,
    },
    charId: pending.config.characterId,
    cwd: pending.projectPath,
    title: "",
    projectLabel: pending.projectName || "New session",
    avatarStatusClass: IDLE_DOT_CLASS,
    dotClass: IDLE_DOT_CLASS,
    // config.remote is the *intended* flag for once this draft starts, not
    // a live transport fact - nothing is reachable yet, so never badge it.
    isRemote: false,
    isAutopilot: false,
    frozen: false,
    autoFrozen: false,
    scheduledCount: undefined,
    heldCount: undefined,
    model: pending.config.model,
    drainChip: "",
  });
}

/** Maps a parked (paused) draft to `RowOptions`. */
export function parkedRowOptions(d: ParkedDraft): RowOptions {
  return buildRowOptions({
    identity: {
      idAttr: "placeholder-id",
      id: d.placeholderId,
      liClasses: "parked-draft row-portrait",
      liExtraAttrs: "",
    },
    charId: d.config.characterId,
    cwd: d.projectPath,
    title: "",
    projectLabel: d.projectName || "New session",
    avatarStatusClass: IDLE_DOT_CLASS,
    dotClass: IDLE_DOT_CLASS,
    // Same as draftRowOptions - config.remote is only the future intent.
    isRemote: false,
    isAutopilot: false,
    frozen: false,
    autoFrozen: false,
    scheduledCount: undefined,
    heldCount: undefined,
    model: d.config.model,
    drainChip: "",
  });
}
