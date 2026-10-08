import { escapeHtml } from "../../shared/escape-html";
import type { Instance, MachineRef } from "../../types/ipc.generated";
import { isRemote } from "../../shared/transport";
import { markerToStatusClass } from "../../shared/status-icons";
import { characterForSession } from "./session-characters";
import { projectName, sessionSubtitle, statusDotClass, stateTooltip } from "./sessions-helpers";
import type { SessionSort } from "./sessions-helpers";
import type { PendingNewSession, ParkedDraft } from "./state";
import {
  drainChipHtml,
  frozenChipHtml,
  frozenRowClass,
  leadingVisual,
  scheduledCornerHtml,
  heldCornerHtml,
  modelBatteryHtml,
} from "./sidebar-row-visuals";
import type { LeadingExtras } from "./sidebar-row-visuals";
import { chainRowKey } from "./successor-follow";

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
  /** Phone/autopilot badges after the project name. "" when neither flag is set. */
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
  /** Whether this row is the selected/active one. Suppresses the frozen row
   *  tint below - active already paints its own background, and resolving
   *  "which background wins" via CSS combinator overrides for every
   *  frozen x needs-attention x active combination doesn't terminate (3
   *  code-check rounds kept finding one more same-specificity tie one level
   *  up). Mutual exclusion in JS instead: at most one background-setting
   *  class ever reaches the DOM. */
  isActive: boolean;
  /** Same reasoning as `isActive` - a row with a parked attention prompt
   *  shows that tint, never the frozen one, instead of a CSS tie-break. */
  needsAttention: boolean;
  frozen: boolean;
  autoFrozen: boolean;
  scheduledCount: number | undefined;
  heldCount: number | undefined;
  model: string;
  drainChip: string;
  /** Set only for a session mirrored in from a paired peer machine (multi-
   *  machine federation); undefined/null for every locally-hosted row. */
  machine?: MachineRef | null;
}): RowOptions {
  const tipAttr = "data-tip";
  const machineOffline = args.machine?.online === false;
  // Phone shows the machine as visible text (no room for a hover tooltip on
  // a touch device); desktop keeps the glyph + tooltip only - decided UX, G9
  // in docs/multi-machine.md.
  const machineLabel = args.machine && isRemote()
    ? `<span class="session-machine-label${machineOffline ? " session-machine-label--offline" : ""}">${escapeHtml(args.machine.label)}</span>`
    : "";
  const machineBadge = args.machine
    ? `<i class="ph ph-desktop session-machine-badge${machineOffline ? " session-machine-badge--offline" : ""}" ${tipAttr}="On ${escapeHtml(args.machine.label)}${machineOffline ? " (offline)" : ""}"></i>${machineLabel}`
    : "";
  const badges = `${args.isRemote ? `<i class="ph ph-device-mobile session-remote-badge" ${tipAttr}="Started from phone"></i>` : ""}${args.isAutopilot ? `<span class="autopilot-badge" ${tipAttr}="Autopilot active">autopilot</span>` : ""}${machineBadge}`;
  return {
    idAttr: args.identity.idAttr,
    id: args.identity.id,
    liClasses: `${args.identity.liClasses}${(args.isActive || args.needsAttention) ? "" : frozenRowClass(args.frozen, args.autoFrozen)}`,
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
    portraitSecondary: `${frozenChipHtml(args.frozen, args.autoFrozen, tipAttr)}${modelBatteryHtml(args.model)}${args.drainChip}`,
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
      liClasses: `${ctx.isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${ctx.rateLimited.has(s.session_id) ? "is-rate-limited" : ""} ${s.machine?.online === false ? "is-machine-offline" : ""} row-portrait`,
      // Explicit key so a /respawn successor lands in its predecessor's own
      // row (keyOf prefers data-row-key over data-session-id).
      liExtraAttrs: `${ctx.kbdHint} data-row-key="${chainRowKey(s.session_id)}"`,
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
    isActive: ctx.isActive,
    needsAttention,
    frozen: !!s.frozen,
    autoFrozen: !!s.auto_frozen,
    scheduledCount: ctx.scheduledCountMap.get(s.session_id),
    heldCount: s.held_count || undefined,
    model: s.model,
    drainChip,
    machine: s.machine,
  });
}

/** Maps a pending draft (unsent, or "starting..." after the first message) to
 *  `RowOptions`. Keyed off `placeholderId` - consecutive drafts need distinct
 *  identities so sidebar-anim's keyOf()/exit suppression don't leak. The
 *  unsent/starting split now lives only in `liClasses`'s "draft" class. */
export function draftRowOptions(
  pending: PendingNewSession,
  isActive: boolean,
  kbdHint: string = "",
): RowOptions {
  const starting = pending.firstMessageSent;
  return buildRowOptions({
    identity: {
      idAttr: "placeholder-id",
      id: pending.placeholderId,
      liClasses: `${isActive ? "active" : ""} pending ${starting ? "" : "draft"} row-portrait`,
      liExtraAttrs: ` data-pending="1"${kbdHint}`,
    },
    charId: pending.config.characterId,
    cwd: pending.projectPath,
    title: "",
    projectLabel: pending.projectName || "New session",
    avatarStatusClass: IDLE_DOT_CLASS,
    dotClass: IDLE_DOT_CLASS,
    // A draft has no session yet, so it was never started from a phone.
    isRemote: false,
    isAutopilot: false,
    isActive,
    needsAttention: false,
    frozen: false,
    autoFrozen: false,
    scheduledCount: undefined,
    heldCount: undefined,
    model: pending.config.model,
    drainChip: "",
  });
}

/** Maps a parked (paused) draft to `RowOptions`. */
export function parkedRowOptions(d: ParkedDraft, kbdHint: string = ""): RowOptions {
  return buildRowOptions({
    identity: {
      idAttr: "placeholder-id",
      id: d.placeholderId,
      liClasses: "parked-draft row-portrait",
      liExtraAttrs: kbdHint,
    },
    charId: d.config.characterId,
    cwd: d.projectPath,
    title: "",
    projectLabel: d.projectName || "New session",
    avatarStatusClass: IDLE_DOT_CLASS,
    dotClass: IDLE_DOT_CLASS,
    // Same as draftRowOptions - a parked draft has no session yet.
    isRemote: false,
    isAutopilot: false,
    isActive: false,
    needsAttention: false,
    frozen: false,
    autoFrozen: false,
    scheduledCount: undefined,
    heldCount: undefined,
    model: d.config.model,
    drainChip: "",
  });
}
