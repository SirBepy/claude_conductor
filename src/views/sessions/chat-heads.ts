// The chat heads (docs/chat-heads-design.md): the stack of round heads that replaced
// the 260px chat list. This file turns the live sessions into `<li>` entries for the
// reconciler; sidebar.ts renders them into the same `#sessions-list` the rows used,
// so every `li[data-session-id]` consumer (click, menu, hover card, specs) keeps working.

import { escapeHtml } from "../../shared/escape-html";
import { getSettings } from "../../shared/state";
import { getBinding } from "../../shared/shortcuts";
import { isRemote } from "../../shared/transport";
import { isBlocked } from "../../shared/chat/rate-limit-banner";
import type { Instance } from "../../types/ipc.generated";
import {
  deriveQuestionSet,
  isJarvisOrWorker,
  isSubchat,
  loadHiddenSessions,
  loadUnreadSet,
  projectName,
  sessionSubtitle,
  statusDotClass,
} from "./sessions-helpers";
import { state, windowIdOf } from "./state";
import type { ParkedDraft, PendingNewSession } from "./state";
import { isSubchatsOn, pendingPromptSessionIds } from "./permission-modal";
import { isQuietPrompt, parkedAskersFor } from "./permission-modal/gating";
import { mainChatInfo, showsSubs } from "./main-chat";
import type { MainChatInfo } from "./main-chat";
import { listedAsProjectMain } from "./project-main-chats";
import { characterForSession, characterIconUrl } from "./session-characters";
import { chainRowKey, recordChainLinks, supersededPredecessors } from "./successor-follow";
import { modelBatteryHtml, projBadgeHtml } from "./sidebar-row-visuals";
import { mainChatRingSpec, ringHtml, ringSpecFor } from "./sidebar-ring";
import type { RingSpec } from "./sidebar-ring";
import { questionProgressFor } from "./question-progress";
import { subInitials } from "./sub-list";
import { orderHeads, readHeadOrder, totalWaiting } from "./chat-heads-model";
import type { HeadOrderItem } from "./chat-heads-model";

/** Per-window, in memory only: the stack starts open on launch and Joe's open or closed
 *  choice has no reason to outlive the window (design: "open/closed per window"). */
export const headsUi = {
  open: true,
  /** The hidden chats stand in the stack's place while this is on. */
  showHidden: false,
  /** Index into the visible heads while Ctrl is held, -1 when nothing is picked. */
  highlight: -1,
  /** Ctrl is held: every head wears its number. */
  numbers: false,
};

export interface HeadEntry { key: string; html: string }

export interface HeadBuild {
  entries: HeadEntry[];
  /** Ids of the visible chat heads in stack order: Ctrl+1..9 and the Ctrl+Up/Down walk. */
  openIds: string[];
}

interface HeadDraft extends HeadOrderItem {
  html: (kbd: string, highlighted: boolean) => string;
  /** Session id (or draft placeholder id) the keyboard opens. */
  openId: string;
  waiting: number;
}

/** A head's red number: how many cards wait on Joe behind it. A main chat counts its
 *  asking subs too; a plain chat counts its parked cards (one at least while it asks). */
function waitingFor(id: string, asking: boolean, main: MainChatInfo | undefined): number {
  if (main) return main.askingDots;
  if (!asking) return 0;
  const parked = parkedAskersFor(id).filter((a) => !isQuietPrompt(a.prompt)).length;
  return Math.max(1, parked);
}

/** The ring of a head: today's ring (plan arc, question segments) plus the two states
 *  the old list drew no ring for, a read chat (faint white) and a chat on another machine
 *  (sky). A remote chat that is working or asking keeps its state colour: state wins. */
export function headRingSpec(base: RingSpec, remote: boolean): RingSpec {
  if (base.kind !== "none") return base;
  return { kind: "solid", tone: remote ? "remote" : "idle" };
}

function headRingHtml(spec: RingSpec): string {
  return ringHtml(spec);
}

/** The model battery without the `data-tip`: the hover card carries the model, and a
 *  tip attribute on the battery would suppress the card while the pointer is on it. */
function batteryHtml(model: string, effort: string | undefined): string {
  const html = modelBatteryHtml(model, effort ?? "");
  return html ? `<span class="chat-head-battery">${html.replace(/ data-tip="[^"]*"/, "")}</span>` : "";
}

function countHtml(n: number): string {
  return n > 0 ? `<span class="chat-head-count" role="img" aria-label="${n} waiting on you">${n}</span>` : "";
}

function portraitHtml(charId: string | null | undefined): string {
  if (!charId) return `<span class="chat-head-portrait is-placeholder"><i class="ph ph-chat-circle-dots"></i></span>`;
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  return `<span class="chat-head-portrait"><img class="char-avatar chat-head-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true" draggable="false"><img class="char-avatar chat-head-img" data-character-id="${id}"${preload} alt="${id}" draggable="false"></span>`;
}

function mainFaceHtml(cwd: string, name: string, machineId: string | null | undefined): string {
  const machine = machineId ? ` data-proj-face-machine="${escapeHtml(machineId)}"` : "";
  return `<span class="chat-head-portrait is-project"><span class="proj-face" data-proj-face="${escapeHtml(cwd)}" data-proj-mono="${escapeHtml(name)}"${machine}><i class="ph ph-folder"></i></span></span>`;
}

function facts(s: Instance, scheduled: number, main: MainChatInfo | undefined): string {
  const out: string[] = [];
  if (scheduled) out.push(`${scheduled} scheduled`);
  if (s.held_count) out.push(`${s.held_count} held`);
  if (main && main.subs.length > 0) out.push(`${main.subs.length} ${main.subs.length === 1 ? "sub" : "subs"}`);
  return out.join(",");
}

interface HeadShell {
  idAttr: "session-id" | "placeholder-id";
  id: string;
  rowKey: string;
  classes: string[];
  st: string;
  face: string;
  ring: string;
  battery: string;
  count: number;
  badge: string;
  extraAttrs?: string;
  label: string;
}

function renderHead(h: HeadShell, kbd: string, highlighted: boolean): string {
  const classes = [...h.classes, highlighted ? "is-highlight" : ""].filter(Boolean).join(" ");
  return `<li class="chat-head ${classes}" data-${h.idAttr}="${escapeHtml(h.id)}" data-row-key="${escapeHtml(h.rowKey)}" data-st="${h.st}"${kbd}${h.extraAttrs ?? ""} aria-label="${escapeHtml(h.label)}"><span class="chat-head-face">${h.face}${h.ring}${h.badge}${h.battery}${countHtml(h.count)}</span></li>`;
}

interface HeadStatusCtx {
  unread: Set<string>;
  attention: Set<string>;
  question: Set<string>;
  rateLimited: ReadonlySet<string>;
  closing: Set<string>;
  /** This chat's subs summary when Use subchats is on, else absent. */
  main: MainChatInfo | undefined;
}

/** The status class and the ring a live chat's head draws: closing overrides the status
 *  for the ring only, and a main chat's ring follows its subs. */
export function liveHeadStatus(s: Instance, ctx: HeadStatusCtx): { dotClass: string; ring: RingSpec } {
  const id = s.session_id;
  const statusClass = statusDotClass(s, ctx.unread, ctx.attention, ctx.question, ctx.rateLimited);
  const dotClass = ctx.closing.has(id) ? "st-closing" : statusClass;
  const base = ctx.main
    ? mainChatRingSpec(dotClass, questionProgressFor(id), {
        working: ctx.main.anyWorking,
        asking: ctx.main.subs.some((x) => x.kind === "asking"),
        allFinished: ctx.main.allFinished,
        hasSubs: ctx.main.subs.length > 0,
      })
    : ringSpecFor(dotClass, s.progress?.plan, questionProgressFor(id));
  return { dotClass, ring: headRingSpec(base, !!s.machine) };
}

function liveHead(
  s: Instance,
  ctx: HeadStatusCtx & {
    isActive: boolean;
    scheduledCountMap: Map<string, number>;
    isMain: boolean;
  },
): HeadDraft {
  const id = s.session_id;
  const needsAttention = ctx.attention.has(id);
  const isClosing = ctx.closing.has(id);
  const { dotClass, ring } = liveHeadStatus(s, ctx);
  const asking = ctx.question.has(id);
  const waiting = waitingFor(id, asking, ctx.main);
  const pinnedSub = isSubchat(s);
  const name = projectName(s);
  const cwd = String(s.cwd ?? "");
  const kind = ctx.isMain ? "main" : pinnedSub ? "sub" : "chat";
  const face = ctx.isMain
    ? mainFaceHtml(cwd, name, s.machine?.id)
    : pinnedSub
      ? `<span class="chat-head-portrait is-sub"><span class="chat-head-initials">${escapeHtml(subInitials(sessionSubtitle(s)))}</span></span>`
      : portraitHtml(characterForSession(s));
  const scheduled = ctx.scheduledCountMap.get(id) ?? 0;
  const shell: HeadShell = {
    idAttr: "session-id",
    id,
    rowKey: chainRowKey(id),
    classes: [
      ctx.isActive ? "active" : "",
      `is-${kind}`,
      s.kind === "external" ? "is-external" : "",
      needsAttention ? "needs-attention" : "",
      isClosing ? "closing" : "",
      ctx.rateLimited.has(id) ? "is-rate-limited" : "",
      s.machine?.online === false ? "is-machine-offline" : "",
    ],
    st: dotClass,
    face,
    ring: headRingHtml(ring),
    // A main chat's face is the project itself and a pinned sub is a worker: neither carries the project badge.
    badge: kind === "chat" ? projBadgeHtml(cwd, "chat-head-badge", s.machine?.id) : "",
    battery: ctx.main && ctx.main.subs.length > 0 ? "" : batteryHtml(s.model, s.effort),
    count: waiting,
    extraAttrs: ` data-head-kind="${kind}" data-facts="${escapeHtml(facts(s, scheduled, ctx.main))}"`,
    label: `${sessionSubtitle(s)}, ${name}`,
  };
  return {
    id: shell.rowKey,
    startedAt: s.started_at ?? "",
    openId: id,
    waiting,
    html: (kbd, highlighted) => renderHead(shell, kbd, highlighted),
  };
}

/** The + head keeps the old FAB's id: nine view specs and the phone's new-chat flow find it there. */
function newHead(): HeadEntry {
  return {
    key: "__new",
    html: `<li class="chat-head chat-head-control chat-head-new" id="sessionsFab" data-row-key="__new" data-heads-new="1" aria-label="${escapeHtml(newChatLabel())}" title="${escapeHtml(newChatLabel())}"><span class="chat-head-face"><i class="ph ph-plus"></i></span></li>`,
  };
}

function draftHead(
  idAttr: "placeholder-id",
  placeholderId: string,
  projectPath: string,
  projectLabel: string,
  charId: string | null | undefined,
  model: string,
  effort: string | undefined,
  classes: string[],
  extraAttrs: string,
): HeadDraft {
  const shell: HeadShell = {
    idAttr,
    id: placeholderId,
    rowKey: `p:${placeholderId}`,
    classes: [...classes, "is-draft"],
    st: "st-your-turn",
    face: portraitHtml(charId),
    ring: "",
    badge: projBadgeHtml(projectPath, "chat-head-badge"),
    battery: batteryHtml(model, effort),
    count: 0,
    extraAttrs: ` data-head-kind="draft"${extraAttrs}`,
    label: `Draft, ${projectLabel}`,
  };
  return { id: shell.rowKey, startedAt: "", openId: placeholderId, waiting: 0, html: (kbd, hl) => renderHead(shell, kbd, hl) };
}

function pendingHead(p: PendingNewSession, isActive: boolean): HeadDraft {
  return draftHead(
    "placeholder-id", p.placeholderId, p.projectPath, p.projectName || "New session", p.config.characterId,
    p.config.model, p.config.effort,
    [isActive ? "active" : "", "pending", p.firstMessageSent ? "" : "draft"], ` data-pending="1"`,
  );
}

function parkedHead(d: ParkedDraft): HeadDraft {
  return draftHead(
    "placeholder-id", d.placeholderId, d.projectPath, d.projectName || "New session", d.config.characterId,
    d.config.model, d.config.effort, ["parked-draft"], "",
  );
}

/** A control head: the toggle, the + head, the hidden head and its back head. */
function controlHead(key: string, classes: string, icon: string, label: string, attrs = "", inner = ""): HeadEntry {
  return {
    key,
    html: `<li class="chat-head chat-head-control ${classes}" data-row-key="${key}" ${attrs} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="chat-head-face"><i class="ph ${icon}"></i>${inner}</span></li>`,
  };
}

/** The + head's name: the desktop also names the New chat key, a phone has no keyboard to press. */
function newChatLabel(): string {
  const keys = isRemote() ? null : getBinding("new-chat");
  if (!keys) return "New chat";
  return `New chat (${keys.split("+").map((k) => k.charAt(0).toUpperCase() + k.slice(1)).join("+")})`;
}

/** Everything the stack shows for the live state, in order. Hidden chats and the stack never
 *  share the corner: while `headsUi.showHidden` is on the hidden chats take the stack's place. */
export function buildHeadEntries(
  scheduledCountMap: Map<string, number>,
  scheduledPendingPlaceholders: Set<string>,
  refreshScheduledCounts: () => void,
): HeadBuild {
  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  recordChainLinks(state.sessions);
  const superseded = supersededPredecessors(state.sessions);
  const listSessions = state.sessions.filter(
    (s) => !isJarvisOrWorker(s) && (!isSubchat(s) || s.pinned_to_sidebar === true) && !superseded.has(s.session_id),
  );
  const attention = pendingPromptSessionIds();
  const openRowId = windowIdOf(state.selectedId);
  // The open chat's parked card is already on screen, so its own head keeps off the attention tint.
  if (openRowId) attention.delete(openRowId);
  const question = deriveQuestionSet(listSessions);
  for (const id of pendingPromptSessionIds()) question.add(id);
  const rateLimited = new Set(listSessions.filter(isBlocked).map((s) => s.session_id));
  const hidden = loadHiddenSessions();

  const pendingRealId = pending?.realId ?? null;
  const pendingRealVisible = !!pendingRealId && listSessions.some((s) => s.session_id === pendingRealId);
  let candidates = listSessions;
  if (pendingRealId && !pendingRealVisible) {
    candidates = candidates.filter((s) => s.session_id !== pendingRealId);
  } else if (pending && !pendingRealId && pending.firstMessageSent) {
    // The SessionStart hook registers an External entry before the real id is known; it
    // would double-render the pending head (same rule as the old list).
    candidates = candidates.filter((s) => !(String(s.cwd) === pending.projectPath && !pending.preExistingSessionIds.has(s.session_id)));
  }

  const mainInfo = new Map<string, MainChatInfo>();
  const mainIds = new Set<string>();
  for (const s of listSessions) {
    if (!showsSubs(s.session_id, state.sessions)) continue;
    mainInfo.set(s.session_id, mainChatInfo(s, state.sessions));
    if (isSubchatsOn(s.session_id) && listedAsProjectMain(s, state.sessions)) mainIds.add(s.session_id);
  }
  const closing = new Set(
    listSessions.filter((s) => s.closing && !mainInfo.get(s.session_id)?.closesWhenSubsFinish).map((s) => s.session_id),
  );
  refreshScheduledCounts();

  const mk = (s: Instance): HeadDraft =>
    liveHead(s, {
      isActive: s.session_id === openRowId, unread, attention, question, rateLimited, closing, scheduledCountMap,
      main: mainInfo.get(s.session_id), isMain: mainIds.has(s.session_id),
    });
  const matches = (s: Instance): boolean =>
    !filter || projectName(s).toLowerCase().includes(filter) || sessionSubtitle(s).toLowerCase().includes(filter);

  const shownLive = candidates.filter((s) => !hidden.has(s.session_id) && matches(s)).map(mk);
  const hiddenLive = candidates.filter((s) => hidden.has(s.session_id)).map(mk);
  // The toggle's red number counts every waiting card, hidden chats' included: a hidden
  // chat that asks must not make the closed stack look calm.
  const allWaiting = totalWaiting([...shownLive, ...hiddenLive].map((h) => h.waiting));

  const drafts: HeadDraft[] = [];
  const pendingHidden = !!pending && scheduledPendingPlaceholders.has(pending.placeholderId);
  if (pending && !pendingHidden && !pendingRealVisible) drafts.push(pendingHead(pending, state.selectedId === pending.placeholderId));
  for (const d of state.parkedDrafts) {
    if (!scheduledPendingPlaceholders.has(d.placeholderId)) drafts.push(parkedHead(d));
  }

  const manual = readHeadOrder(getSettings() as Record<string, unknown>);
  const normal = orderHeads([...shownLive, ...drafts], manual);
  const hiddenOrdered = orderHeads(hiddenLive, manual);
  const stack = headsUi.showHidden ? hiddenOrdered : normal;

  // Ctrl+N and the keyboard walk follow the stack Joe sees; a stack of hidden chats is not
  // reachable by number (they are not "heads 1-9").
  const openIds = normal.map((h) => h.openId);
  state.sortedSessionIds = openIds;

  const entries: HeadEntry[] = [];
  // Nothing to stack (a fresh install, or the daemon is not up yet): no toggle, just the + head,
  // which is the old FAB and was always there.
  if (shownLive.length + hiddenLive.length + drafts.length === 0) {
    state.sortedSessionIds = [];
    return { entries: [newHead()], openIds: [] };
  }
  const ringRed = allWaiting > 0;
  entries.push(controlHead(
    "__toggle", `chat-head-toggle${headsUi.open ? " is-open" : ""}${ringRed ? " has-waiting" : ""}`,
    headsUi.open ? "ph-caret-up" : "ph-chats-circle", headsUi.open ? "Hide chats" : "Show chats",
    `data-heads-toggle="1" aria-expanded="${headsUi.open}"`,
    (headsUi.open ? "" : countHtml(allWaiting)) + (ringRed && !headsUi.open ? ringHtml({ kind: "solid", tone: "question", pulse: true }) : ""),
  ));
  if (!headsUi.open) return { entries, openIds };

  if (headsUi.showHidden) {
    entries.push(controlHead("__back", "chat-head-back", "ph-arrow-left", "Back to your chats", `data-heads-back="1"`));
  }
  stack.forEach((h, i) => {
    const slot = headsUi.showHidden ? -1 : i;
    const kbd = slot >= 0 && slot < 9 ? ` data-kbd-hint="${slot + 1}"` : "";
    entries.push({ key: h.id, html: h.html(kbd, !headsUi.showHidden && headsUi.highlight === i) });
  });
  if (!headsUi.showHidden) {
    if (hiddenLive.length > 0) {
      entries.push(controlHead(
        "__hidden", "chat-head-hidden", "ph-eye-slash", `Hidden chats (${hiddenLive.length})`,
        `data-heads-hidden="1"`, `<span class="chat-head-count is-neutral">${hiddenLive.length}</span>`,
      ));
    }
    entries.push(newHead());
  }
  return { entries, openIds };
}
