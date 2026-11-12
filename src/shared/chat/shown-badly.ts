// "Shown badly": Joe flags a send_message card that showed him data badly, from
// the card's right-click menu (a long-press on the phone raises the same
// `contextmenu`). The card's input, his optional note and the chat go to the
// daemon's shown-badly log (`flag_shown_badly`, hooks_server/shown_badly.rs),
// where they are fixed in batches. It is a rare action, so it lives in a menu
// and never as a button on the card.

import "../confirm.css";
import "./shown-badly.css";
import { invoke } from "../ipc";
import { isRemote } from "../transport";
import { lockInputToHost } from "../modal-input-lock";
import { showToast } from "../toast";
import { createMoreMenu } from "../../views/sessions/more-menu-base";
import type { RenderedMessage } from "./chat-classifiers";
import { cardKeyOf } from "./chat-message-card";

/** Same cap the daemon enforces (`shown_badly::MAX_NOTE`). */
export const NOTE_MAX = 500;

/** The card's send_message input as the chat drew it, rebuilt from the parsed
 *  row: the same field names the tool takes, unset fields left out. */
export function cardInputOf(m: RenderedMessage): Record<string, unknown> | null {
  const c = m.card;
  if (m.kind !== "message" || !c) return null;
  const out: Record<string, unknown> = {
    kind: c.kind,
    verdict: c.verdict,
    tone: c.tone,
    text: m.text,
    points: c.points,
    done: c.done,
    not_done: c.notDone,
    waiting_on: c.waitingOn,
    your_move: c.yourMove,
    was: c.was,
    copy: c.copy,
    question: c.question,
    read_answers: c.readAnswers,
    visuals: c.visuals,
    details: m.details,
    next_actions: m.nextActions,
  };
  // A sub's card is the daemon's own card about a sub, drawn in the main chat:
  // say which sub and which card it was, since the kind alone hides that.
  if (m.subCard) out.sub_card = { id: m.subCard.id, kind: m.subCard.kind, sub_id: m.subCard.sub_id ?? null, sub_name: m.subCard.sub_name ?? null };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export async function flagShownBadly(sessionId: string, m: RenderedMessage, note: string): Promise<void> {
  const message = cardInputOf(m);
  if (!message) return;
  // `chatId`, not `sessionId`: the daemon's forwarder would send a mirrored
  // chat's flag to its host instead of this PC's log (methods/registry/shown_badly.rs).
  await invoke("flag_shown_badly", {
    chatId: sessionId,
    messageId: m.subCard ? null : (m.id ?? null),
    message,
    note: note.trim() || null,
  });
}

/** The note dialog: a short optional text, Log it or Cancel. Resolves the note
 *  ("" when left empty), or null when cancelled. */
export function askShownBadlyNote(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-confirm-overlay";
    const box = document.createElement("div");
    box.className = "app-confirm app-confirm--safe sbad-dialog";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML =
      `<div class="app-confirm-head"><div class="app-confirm-icon"><i class="ph-fill ph-flag"></i></div>` +
      `<div><p class="app-confirm-title">Shown badly</p><p class="app-confirm-text">Logged with this card so it gets fixed later.</p></div></div>` +
      `<textarea class="sbad-note" rows="3" maxlength="${NOTE_MAX}" placeholder="What would have been better? (optional)"></textarea>` +
      `<div class="app-confirm-actions"><button class="app-confirm-cancel btn-secondary">Cancel</button><button class="app-confirm-ok btn-primary">Log it</button></div>`;
    overlay.append(box);
    const note = box.querySelector<HTMLTextAreaElement>(".sbad-note")!;
    const unlock = lockInputToHost(overlay);
    function finish(v: string | null): void {
      document.removeEventListener("keydown", onKey, true);
      unlock();
      overlay.remove();
      resolve(v);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && !e.shiftKey && e.target === note) {
        e.preventDefault();
        finish(note.value);
      }
    }
    box.querySelector(".app-confirm-cancel")!.addEventListener("click", () => finish(null));
    box.querySelector(".app-confirm-ok")!.addEventListener("click", () => finish(note.value));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    note.focus();
  });
}

let point: HTMLElement | null = null;

/** A zero-size element at the click, for the menu to anchor on. */
function pointAt(x: number, y: number): HTMLElement {
  if (!point?.isConnected) {
    point = document.createElement("div");
    point.style.cssText = "position:fixed;width:0;height:0;pointer-events:none";
    document.body.appendChild(point);
  }
  point.style.left = `${x}px`;
  point.style.top = `${y}px`;
  return point;
}

const menu = createMoreMenu<[() => void]>({
  build: (el, close, onFlag) => {
    const item = document.createElement("button");
    item.className = "smore-item";
    item.innerHTML = `<i class="ph ph-flag"></i><span>Shown badly</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      onFlag();
    });
    el.appendChild(item);
  },
});

export interface ShownBadlySource {
  sessionId: string | null;
  messages: readonly RenderedMessage[];
}

/** The card a right-click landed on, resolved through its `data-msg-id`. */
export function cardAt(target: EventTarget | null, messages: readonly RenderedMessage[]): RenderedMessage | null {
  const root = target instanceof Element ? target.closest<HTMLElement>(".mc-root[data-msg-id]") : null;
  const key = root?.dataset.msgId;
  if (!key) return null;
  return messages.find((m) => cardKeyOf(m) === key) ?? null;
}

/** `contextmenu` handler for any container that draws cards (the transcript,
 *  the chat dashboard). A right-click on a file chip, a link or a text field
 *  keeps its own menu. */
export function createShownBadlyContextMenu(src: () => ShownBadlySource): (e: MouseEvent) => void {
  return (e: MouseEvent): void => {
    if (e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest("a[href], input, textarea, [contenteditable]")) return;
    // A mouse right-click on selected text wants the webview's own Copy. A
    // long-press selects the word under the finger before contextmenu fires, so
    // on touch (and on the phone page) the selection says nothing and the menu
    // must still open.
    const touch = isRemote() || (e as PointerEvent).pointerType === "touch";
    // An image keeps its own Copy and Save menu under a mouse.
    if (!touch && t.closest("img, video")) return;
    const sel = window.getSelection();
    if (!touch && sel && !sel.isCollapsed && sel.toString().trim() !== "" && sel.containsNode(t, true)) return;
    const { sessionId, messages } = src();
    const m = cardAt(t, messages);
    if (!m || !sessionId) return;
    e.preventDefault();
    menu.open(pointAt(e.clientX, e.clientY), () => {
      void (async () => {
        const note = await askShownBadlyNote();
        if (note === null) return;
        try {
          await flagShownBadly(sessionId, m, note);
          showToast("Logged as shown badly");
        } catch (err) {
          console.error("[shown-badly] flag failed", err);
          showToast(`Could not log it: ${err}`);
        }
      })();
    });
  };
}
