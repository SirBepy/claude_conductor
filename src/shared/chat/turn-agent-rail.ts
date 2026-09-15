/**
 * Agent rail (todo 899): live Task/Agent subagent avatars in the turn footer,
 * so Joe can see how many are running without clicking anything - his own
 * words: "if youre using 4 agents right now... id like to know there are 4
 * guys working". A dot per live subagent (a Task/Agent tool_use with no
 * matching tool_result yet this turn); on finish it plays a death animation
 * then folds into a dashed "N done" ghost pill (Variant B, decided - dead
 * ones actually die, they don't just vanish or silently merge into a step).
 *
 * Free functions over `TurnFooterState`, the same shape turn-meta-row.ts /
 * turn-status-chip.ts / turn-progress-bar.ts already use. In-turn scope only:
 * everything here is derived from this turn's own tool_use/tool_result
 * stream (chat-event-handler-tools.ts) - no registry state, no cross-session
 * count, no containment relationship to the TodoWrite checklist (an agent's
 * lifetime isn't bounded by a step - see the todo for why nesting under the
 * checklist was rejected).
 *
 * Reuses the delegated `.tool-chip` click handler
 * (chat-renderer-click-handlers.ts's createHandleToolChipClick): every dot
 * and the ghost pill are real `.tool-chip`s inside a `.tool-strip` +
 * `.tool-strip-panel` pair, so clicking one just works with no new listener.
 */

import { authorTagFor } from "./author-tag-source";
import { hydrateCharacterAvatars } from "../projects";
import { escapeHtml } from "../escape-html";
import type { TurnFooterState } from "./turn-chips";

const PALETTE_SIZE = 6;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Same categorical palette author-message-group.ts uses for peer avatars
 *  (chat-messages-user.css's author-color-0..5), keyed by the subagent's own
 *  tool_use id so its dot color stays stable across re-renders. */
function colorClassFor(id: string): string {
  return `author-color-${hashStr(id) % PALETTE_SIZE}`;
}

/** Same avatar markup/pipeline as author-message-group.ts's peer chips: a
 *  real character portrait when one resolves, else the generic robot icon.
 *  Subagents carry no session id of their own, so authorTagFor has nothing
 *  to resolve today and this always falls through to the icon - reusing the
 *  pipeline (rather than a second one, or mockup-only initials) keeps it
 *  wired for whenever one does. */
function avatarHtml(id: string, colorClass: string): string {
  const { charId } = authorTagFor(id);
  const inner = charId
    ? `<img class="char-avatar" data-character-id="${escapeHtml(charId)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:pixelated">`
    : `<i class="ph ph-robot"></i>`;
  return `<span class="author-avatar agent-dot-avatar ${colorClass}">${inner}</span>`;
}

interface AgentRailDot {
  chip: HTMLElement;
  group: HTMLElement;
  activityEl: HTMLElement;
  label: string;
  /** The checklist step active at spawn time, phrased as "spawned during: X"
   *  in the detail panel - never as ownership (todo 899's Variant-C-rejected
   *  note: an agent's lifetime isn't bounded by that step). Null when the
   *  turn had no checklist yet. */
  spawnedDuring: string | null;
}

export interface AgentRailState {
  row: HTMLElement;
  strip: HTMLElement;
  panel: HTMLElement;
  /** Live dots only, keyed by the Task/Agent tool_use id. A finished one is
   *  deleted here the instant it folds into the ghost pill. */
  dots: Map<string, AgentRailDot>;
  ghostChip: HTMLElement | null;
  ghostGroup: HTMLElement | null;
  finished: { label: string; spawnedDuring: string | null }[];
}

/** Lazily creates the rail row + its strip/panel pair, placed as its own row
 *  above the checklist (todo 899's placement call) and below the meta row -
 *  inserted right before the checklist's own element when one already
 *  exists (the common case: TodoWrite/write_plan usually runs before any
 *  Task dispatch), else at the same anchor the checklist/progress bar use. */
function ensureRail(st: TurnFooterState): AgentRailState {
  if (st.agentRail) return st.agentRail;
  const row = document.createElement("div");
  row.className = "agent-rail";
  const strip = document.createElement("div");
  strip.className = "tool-strip agent-rail-strip";
  const panel = document.createElement("div");
  panel.className = "tool-strip-panel";
  panel.hidden = true;
  row.appendChild(strip);
  row.appendChild(panel);

  if (st.todoChecklist) {
    st.todoChecklist.el.insertAdjacentElement("beforebegin", row);
  } else if (st.metaRow) {
    st.metaRow.insertAdjacentElement("afterend", row);
  } else {
    st.footer.prepend(row);
  }

  const state: AgentRailState = {
    row, strip, panel, dots: new Map(), ghostChip: null, ghostGroup: null, finished: [],
  };
  st.agentRail = state;
  return state;
}

/** Rebuild the ghost pill's label/detail from `rail.finished`. Created on
 *  first use, then reused - it persists for the rest of the turn even after
 *  every dot has died, since it's the only remaining record that anything
 *  ran (Variant A - vanishing entirely - was rejected for losing exactly
 *  this). */
function renderGhostPill(rail: AgentRailState): void {
  const n = rail.finished.length;
  if (n === 0) return;
  if (!rail.ghostChip) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tool-chip tool-chip--agent-ghost";
    chip.dataset.tool = "agent-rail-ghost";
    const icon = document.createElement("i");
    icon.className = "ph ph-check-circle";
    const label = document.createElement("span");
    label.className = "tool-chip-label";
    chip.appendChild(icon);
    chip.appendChild(label);
    rail.strip.appendChild(chip);
    rail.ghostChip = chip;

    const group = document.createElement("div");
    group.className = "tool-strip-group agent-rail-finished";
    group.dataset.tool = "agent-rail-ghost";
    group.hidden = true;
    rail.panel.appendChild(group);
    rail.ghostGroup = group;
  }
  rail.ghostChip.querySelector<HTMLElement>(".tool-chip-label")!.textContent = `${n} done`;
  rail.ghostGroup!.innerHTML = rail.finished
    .map((f) => {
      const spawned = f.spawnedDuring
        ? ` <span class="agent-rail-finished-spawned">- spawned during: ${escapeHtml(f.spawnedDuring)}</span>`
        : "";
      return `<div class="agent-rail-finished-row">${escapeHtml(f.label)}${spawned}</div>`;
    })
    .join("");
}

/** Add a live dot for a newly-spawned top-level Task/Agent call. Idempotent -
 *  a duplicate id (a replayed event) is a no-op, matching the idempotence
 *  every other turn-footer piece relies on for the live/history-replay path. */
export function addAgentDot(st: TurnFooterState, id: string, label: string, spawnedDuring: string | null): void {
  const rail = ensureRail(st);
  if (rail.dots.has(id)) return;

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "tool-chip tool-chip--agent-dot tool-chip--running";
  chip.dataset.tool = id;
  chip.title = label;
  chip.innerHTML = avatarHtml(id, colorClassFor(id));
  // Ghost pill always trails the live dots; insertBefore(chip, null) is a
  // plain append when it doesn't exist yet.
  rail.strip.insertBefore(chip, rail.ghostChip);

  const group = document.createElement("div");
  group.className = "tool-strip-group agent-rail-detail";
  group.dataset.tool = id;
  group.hidden = true;
  const labelEl = document.createElement("div");
  labelEl.className = "agent-rail-detail-label";
  labelEl.textContent = label;
  const activityEl = document.createElement("div");
  activityEl.className = "agent-rail-detail-activity";
  activityEl.textContent = "Starting…";
  group.appendChild(labelEl);
  group.appendChild(activityEl);
  if (spawnedDuring) {
    const spawnedEl = document.createElement("div");
    spawnedEl.className = "agent-rail-detail-spawned";
    spawnedEl.textContent = `Spawned during: ${spawnedDuring}`;
    group.appendChild(spawnedEl);
  }
  rail.panel.insertBefore(group, rail.ghostGroup);

  void hydrateCharacterAvatars(chip);
  rail.dots.set(id, { chip, group, activityEl, label, spawnedDuring });
}

/** Update a live dot's "what it's doing right now" line, from a child
 *  tool_use whose parentToolUseId names it (Joe picked this: "subagent
 *  thinking bars" alongside the count). No-op if the id isn't a currently
 *  live dot - an unrelated call, a nested sub-subagent, or one already
 *  finished. */
export function updateAgentDotActivity(st: TurnFooterState, parentId: string, activity: string): void {
  const dot = st.agentRail?.dots.get(parentId);
  if (!dot) return;
  dot.activityEl.textContent = activity;
}

/** Play the death animation and fold a finished dot into the ghost pill. The
 *  ghost pill's count/detail update immediately (so a click or an assertion
 *  never has to wait out the animation); only the old chip's removal is
 *  deferred to let the animation play. No-op if the id isn't a live dot. */
export function finishAgentDot(st: TurnFooterState, id: string): void {
  const rail = st.agentRail;
  const dot = rail?.dots.get(id);
  if (!rail || !dot) return;
  rail.dots.delete(id);
  rail.finished.push({ label: dot.label, spawnedDuring: dot.spawnedDuring });
  dot.group.remove();
  renderGhostPill(rail);

  const chip = dot.chip as HTMLButtonElement;
  chip.classList.remove("tool-chip--running");
  chip.classList.add("tool-chip--agent-dot-dying");
  chip.disabled = true;
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    chip.remove();
  };
  chip.addEventListener("animationend", remove, { once: true });
  // Fallback for a reduced-motion environment (or a settle that fires the
  // instant the dot spawns) where the CSS animation never runs/completes.
  setTimeout(remove, 600);
}

/** Sweep every still-live dot to finished when the turn itself settles or is
 *  cancelled - a closed turn shouldn't leave a dot spinning forever just
 *  because its tool_result never arrived (interrupted turn, or a background
 *  agent that outlives the plan). Mirrors settleTodoChecklist's leftover
 *  sweep. No-op when the turn never had a rail. */
export function settleAgentRail(st: TurnFooterState): void {
  const rail = st.agentRail;
  if (!rail) return;
  for (const id of [...rail.dots.keys()]) finishAgentDot(st, id);
}
