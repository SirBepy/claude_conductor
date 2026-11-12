import { escapeHtml } from "../../shared/escape-html";
import type { Instance, MachineRef } from "../../types/ipc.generated";
import { isRemote } from "../../shared/transport";
import { markerToStatusClass } from "../../shared/status-icons";
import { characterForSession } from "./session-characters";
import { projectName, sessionSubtitle, statusDotClass } from "./sessions-helpers";
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
  askingDotsHtml,
  subCountHtml,
  closeWaitChipHtml,
} from "./sidebar-row-visuals";
import type { LeadingExtras } from "./sidebar-row-visuals";
import { chainRowKey } from "./successor-follow";
import { GENERIC_MACHINE_ICON, hasPairedMachines, machineIcon, selfMachineLabel } from "./machine-icons";
import { ringHtml, ringSpecFor, mainChatRingSpec } from "./sidebar-ring";
import type { MainChatInfo } from "./main-chat";
import type { QuestionRingInfo } from "./sidebar-ring";
import { questionProgressFor } from "./question-progress";
import type { PlanStepSnapshot } from "../../types/ipc.generated";

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
  /** Chat title, escaped plain text - the bold first line. "" for draft/parked - no name to show. */
  title: string;
  /** Project folder name, escaped. */
  projectLabel: string;
  /** Autopilot badge after the title (or the project name on a title-less
   *  row). "" when not autopilot. */
  badges: string;
  /** Machine glyph after the project name. "" for a row that carries none. */
  machineBadge: string;
  /** Portrait's secondary slot: model battery + drain chip, for every row kind. */
  portraitSecondary: string;
  /** A main chat's red dots, one per sub asking Joe, after the project name. */
  subDots?: string;
}

/** The one `<li>` template for the whole sidebar list. A titled row is two
 *  lines, title over project; a draft/parked row has no title yet, so its
 *  project name stays the single bold line rather than sitting under a
 *  placeholder heading (d153323b). */
export function renderSidebarRow(o: RowOptions): string {
  const chips = `<span class="session-chips">${o.portraitSecondary}</span>`;
  // Desktop's hover card already shows the full title; only the phone, which
  // has no card, keeps the small tip for an ellipsized title.
  const titleTip = isRemote() ? ` data-tip="${o.title}"` : "";
  const text = o.title
    ? `<span class="session-row-title"><span class="session-row-title-text"${titleTip}>${o.title}</span>${o.badges}</span>
              ${chips}
              <span class="session-row-project"><span class="proj-name">${o.projectLabel}</span>${o.machineBadge}${o.subDots ?? ""}</span>`
    : `<span class="session-row-project"><span class="proj-name">${o.projectLabel}</span>${o.badges}${o.machineBadge}${o.subDots ?? ""}</span>
              ${chips}`;
  return `<li data-${o.idAttr}="${escapeHtml(o.id)}"${o.liExtraAttrs} class="${o.liClasses}">
            ${leadingVisual(o.charId, o.statusClass, o.cwd, o.avatarExtras)}
            <div class="session-row-text${o.title ? " is-two-line" : ""}">
              ${text}
            </div>
          </li>`;
}

/**
 * The machine glyph for a row. A mirrored row (`machine` set) always carries
 * its machine's icon. A row hosted on this daemon is unmarked on desktop,
 * where no mark means "this machine"; the phone is not one of the machines,
 * so there its own daemon's rows are marked too, once a peer exists to tell
 * them apart from.
 */
function machineBadgeHtml(machine: MachineRef | null | undefined, markLocal: boolean): string {
  if (!machine && (!markLocal || !isRemote() || !hasPairedMachines())) return "";
  const icon = machine ? machineIcon(machine.id) ?? GENERIC_MACHINE_ICON : machineIcon(null);
  if (!icon) return "";
  const offline = machine?.online === false;
  const label = machine ? machine.label : selfMachineLabel() ?? "this machine";
  return `<i class="ph ${icon} session-machine-badge${offline ? " session-machine-badge--offline" : ""}" data-tip="On ${escapeHtml(label)}${offline ? " (offline)" : ""}"></i>`;
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
  /** The `st-*` class the status ring is drawn from; differs from
   *  `avatarStatusClass` only for a closing live session. */
  dotClass: string;
  /** The chat's latest `write_plan` steps, for the working ring's arc. */
  plan?: readonly PlanStepSnapshot[] | null;
  /** Open question card progress, for the question ring's segments. */
  question?: QuestionRingInfo | null;
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
  /** Tints the model battery (effort-battery.css); absent reads as the default grey. */
  effort?: string;
  drainChip: string;
  /** Set only for a session mirrored in from a paired peer machine (multi-
   *  machine federation); undefined/null for every locally-hosted row. */
  machine?: MachineRef | null;
  /** A live session hosted on this daemon (machine null), as opposed to a
   *  draft/parked row, which runs nowhere yet and never gets a machine mark. */
  isLocalSession?: boolean;
  /** Set for a chat with Use subchats on (the Main chats group): its subs'
   *  summary replaces the plan arc, the battery and the ring's state colours. */
  mainChat?: MainChatInfo | null;
}): RowOptions {
  const tipAttr = "data-tip";
  const badges = args.isAutopilot ? `<span class="autopilot-badge" ${tipAttr}="Autopilot active">autopilot</span>` : "";
  return {
    idAttr: args.identity.idAttr,
    id: args.identity.id,
    liClasses: `${args.identity.liClasses}${(args.isActive || args.needsAttention) ? "" : frozenRowClass(args.frozen, args.autoFrozen)}`,
    liExtraAttrs: args.identity.liExtraAttrs,
    charId: args.charId,
    cwd: args.cwd,
    statusClass: args.avatarStatusClass,
    avatarExtras: {
      badgeClass: "is-centred",
      extra: scheduledCornerHtml(args.scheduledCount) + heldCornerHtml(args.heldCount),
      ringHtml: ringHtml(args.mainChat
        ? mainChatRingSpec(args.dotClass, args.question, {
            working: args.mainChat.anyWorking,
            asking: args.mainChat.subs.some((s) => s.kind === "asking"),
            allFinished: args.mainChat.allFinished,
            hasSubs: args.mainChat.subs.length > 0,
          })
        : ringSpecFor(args.dotClass, args.plan, args.question)),
      machineId: args.machine?.id ?? null,
    },
    title: escapeHtml(args.title),
    projectLabel: escapeHtml(args.projectLabel),
    badges,
    machineBadge: machineBadgeHtml(args.machine, !!args.isLocalSession),
    // A main chat with subs shows "3x" where the model battery sits; one with
    // none yet keeps its battery.
    portraitSecondary: `${frozenChipHtml(args.frozen, args.autoFrozen, tipAttr)}${closeWaitChipHtml(args.mainChat?.closesWhenSubsFinish, tipAttr)}${args.mainChat && args.mainChat.subs.length > 0 ? subCountHtml(args.mainChat.subs.length) : modelBatteryHtml(args.model, args.effort)}${args.drainChip}`,
    subDots: args.mainChat ? askingDotsHtml(args.mainChat.askingDots) : "",
  };
}

/** Ids of the chats whose account has a plan with no 5h window. A chat with no
 *  account of its own is measured against the default account, because that is
 *  the usage snapshot the daemon's drain percentages are computed from. */
export function chatsWithoutFiveHour(
  sessions: readonly Pick<Instance, "session_id" | "account_id">[],
  noWindowAccounts: ReadonlySet<string>,
  defaultAccountId: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    const account = s.account_id ?? defaultAccountId;
    if (account && noWindowAccounts.has(account)) out.add(s.session_id);
  }
  return out;
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
    /** This chat's subs summary when it has Use subchats on, else absent. */
    mainChat?: MainChatInfo | null;
    /** Chats whose account has a plan with no 5h window: their drain chip
     *  would quote a share of a window that does not exist. Absent = none. */
    noFiveHour?: ReadonlySet<string>;
  },
): RowOptions {
  const needsAttention = ctx.attention.has(s.session_id);
  const isClosing = ctx.closing.has(s.session_id);
  const drainChip = ctx.sort === "drain" && !ctx.noFiveHour?.has(s.session_id)
    ? drainChipHtml(ctx.drainMap.get(s.session_id))
    : "";
  const statusClass = statusDotClass(s, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited);
  // Closing overrides the RING only, not statusClass/.session-avatar - statusDotClass has no closing awareness.
  const dotClass = isClosing ? "st-closing" : statusClass;
  return buildRowOptions({
    identity: {
      idAttr: "session-id",
      id: s.session_id,
      liClasses: `${ctx.isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${ctx.rateLimited.has(s.session_id) ? "is-rate-limited" : ""} ${s.machine?.online === false ? "is-machine-offline" : ""} row-portrait`,
      // Explicit key so a /respawn successor lands in its predecessor's own
      // row (keyOf prefers data-row-key over data-session-id).
      // `data-st` hands the status class to the desktop hover card, which
      // has only the <li> to go on.
      liExtraAttrs: `${ctx.kbdHint} data-row-key="${chainRowKey(s.session_id)}" data-st="${dotClass}"`,
    },
    charId: characterForSession(s),
    cwd: s.cwd,
    title: sessionSubtitle(s),
    projectLabel: projectName(s),
    avatarStatusClass: statusClass,
    dotClass,
    plan: s.progress?.plan,
    question: questionProgressFor(s.session_id),
    isAutopilot: !!s.autopilot,
    isActive: ctx.isActive,
    needsAttention,
    frozen: !!s.frozen,
    autoFrozen: !!s.auto_frozen,
    scheduledCount: ctx.scheduledCountMap.get(s.session_id),
    heldCount: s.held_count || undefined,
    model: s.model,
    effort: s.effort,
    drainChip,
    machine: s.machine,
    isLocalSession: true,
    mainChat: ctx.mainChat,
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
    isAutopilot: false,
    isActive,
    needsAttention: false,
    frozen: false,
    autoFrozen: false,
    scheduledCount: undefined,
    heldCount: undefined,
    model: pending.config.model,
    effort: pending.config.effort,
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
    isAutopilot: false,
    isActive: false,
    needsAttention: false,
    frozen: false,
    autoFrozen: false,
    scheduledCount: undefined,
    heldCount: undefined,
    model: d.config.model,
    effort: d.config.effort,
    drainChip: "",
  });
}
