/** Waiting-on chip (todo 675): what a `waiting` turn is blocked on, separate
 *  from the self-reported status chip in turn-status-chip.ts. Split off
 *  turn-chips.ts by todo 729. */

import { api } from "../api";
import { isTauri } from "../transport";
import { openWaitingTailPanel } from "./waiting-tail-panel";
import type { TurnChipKey, TurnFooterRegistry, TurnFooterState } from "./turn-chips";

export interface WaitingOnTarget {
  label: string;
  kind: "ci" | "local-process" | "external";
  /** Already re-validated server-side (`mcp::server::waiting_target::sanitize`).
   *  Null when the backend rejected the client-supplied href/path - the chip
   *  still shows `label`, just with nothing to click. */
  href: string | null;
}

const WAITING_ON_ICON: Record<WaitingOnTarget["kind"], string> = {
  ci: "ph-github-logo",
  external: "ph-arrow-square-out",
  "local-process": "ph-terminal-window",
};

/** Parse a `waiting_on` Notification event's JSON body and apply it to the
 *  given turn's footer. Never throws into the event pipeline - a malformed
 *  or unrecognized body is silently dropped (no chip), never a broken one. */
export function applyWaitingOnNotification(
  reg: TurnFooterRegistry,
  key: TurnChipKey | null,
  body: string,
): void {
  if (key === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const { label, kind, href } = parsed as Record<string, unknown>;
  if (typeof label !== "string" || (kind !== "ci" && kind !== "local-process" && kind !== "external")) return;
  reg.setWaitingOn(key, { label, kind, href: typeof href === "string" ? href : null });
}

/** Click delegate for a waiting-on chip (attached in chat-renderer.ts, which
 *  owns `sessionId` - this module stays session-agnostic otherwise). A chip
 *  with no `href` (rejected server-side) carries no data-href and is a no-op. */
export function onWaitingChipClick(chip: HTMLElement, sessionId: string | null): void {
  const href = chip.dataset.href;
  if (!href) return;
  if (chip.dataset.kind === "local-process") {
    if (sessionId) openWaitingTailPanel(chip, sessionId, href);
    return;
  }
  if (isTauri()) void api.openExternal(href);
  else window.open(href, "_blank", "noopener");
}

/** Re-callable: overwrites the chip in place. The caller owns creating the
 *  meta row first, since a self-report can settle before any usage data. */
export function renderWaitingChip(st: TurnFooterState, target: WaitingOnTarget): void {
  if (!st.waitingChip) {
    const chip = document.createElement("span");
    chip.className = "turn-chip turn-chip--waiting-on";
    chip.appendChild(document.createElement("i"));
    chip.appendChild(document.createElement("span"));
    st.metaRow!.appendChild(chip);
    st.waitingChip = chip;
  }
  const chip = st.waitingChip;
  chip.dataset.kind = target.kind;
  if (target.href) chip.dataset.href = target.href;
  else delete chip.dataset.href;
  chip.classList.toggle("turn-chip--clickable", !!target.href);
  chip.title = target.href ? `${target.label} - click to open` : target.label;
  (chip.children[0] as HTMLElement).className = `ph ${WAITING_ON_ICON[target.kind]}`;
  (chip.children[1] as HTMLElement).textContent = target.label;
}
