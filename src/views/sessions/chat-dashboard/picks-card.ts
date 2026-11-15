// The dashboard's Autopilot picks card (pc-1750): every choice the chat made by
// itself on an unattended run, with Agree and Overrule on each. Owns its own DOM
// inside the zone's `.pk-host` (like the Answers and Subchats cards), so a
// re-derive never wipes the overrule box Joe is typing into, and keeps the open
// box and its text in the instance, not in the HTML.

import "./picks-card.css";
import { invoke } from "../../../shared/ipc";
import { getTransport } from "../../../shared/transport";
import { escapeHtml } from "../../../shared/escape-html";
import { localTime } from "../../../shared/formatters";
import { showToast } from "../../../shared/toast";
import {
  normalisePicks, overruleMessage,
  type AutopilotPick, type PicksSide, type PicksState,
} from "../../../shared/chat/dashboard/picks-model";

export interface PicksCardHost {
  /** The chat's id; null until the renderer knows it. */
  sessionId(): string | null;
  /** Asks the dashboard for a redraw. */
  schedule(): void;
  /** Sends text as Joe's message to `ownerId`, the main chat the list belongs
   *  to (not this window's chat, which may be a sub); false when it could not. */
  send(text: string, ownerId: string): Promise<boolean>;
}

const STATUS_LABEL: Record<AutopilotPick["status"], string> = {
  unreviewed: "To review",
  agreed: "Agreed",
  overruled: "To fix",
  corrected: "Fixed",
};

export class PicksCard {
  private side: PicksSide | undefined;
  private asked = false;
  private unlisten: (() => void) | null = null;
  private disposed = false;
  private host: HTMLElement | null = null;
  private html = "";
  /** The pick whose overrule box is open, and the text typed into each box. */
  private overruling: string | null = null;
  private readonly typed = new Map<string, string>();
  private doneOpen = false;
  /** Overrules and re-sends in flight, so a double click sends one correction, not two. */
  private readonly sending = new Set<string>();
  /** Picks whose last send to the chat was refused. */
  private readonly failed = new Set<string>();
  /** The correction the chat already received for a pick whose save then failed, so a retry only saves. */
  private readonly delivered = new Map<string, string>();
  /** Held while Joe types, so a pick arriving mid-sentence cannot steal the focus. */
  private pending: PicksState | null = null;
  private last: PicksState | null = null;

  constructor(private readonly cb: PicksCardHost) {}

  /** What the dashboard derives from; undefined until the first read. */
  sideData(): PicksSide | undefined {
    return this.side;
  }

  async subscribe(): Promise<void> {
    try {
      const un = await getTransport().listen("autopilot-picks-changed", () => void this.load());
      if (this.disposed) un();
      else this.unlisten = un;
    } catch (err) {
      console.warn("[chat-dashboard] listen(autopilot-picks-changed) failed", err);
    }
  }

  /** Reads the list the first time the chat's id is known. */
  ensureLoaded(): void {
    if (this.asked || !this.cb.sessionId()) return;
    this.asked = true;
    void this.load();
  }

  private async load(): Promise<void> {
    const sessionId = this.cb.sessionId();
    if (!sessionId) return;
    try {
      this.adopt(await invoke<unknown>("picks_state", { sessionId }));
    } catch (err) {
      console.warn("[chat-dashboard] picks_state failed", err);
    }
  }

  private adopt(raw: unknown): void {
    if (this.disposed) return;
    this.side = normalisePicks(raw);
    this.cb.schedule();
  }

  /** Draws `state` into `host`. Skips the write when the markup is the same. */
  update(host: HTMLElement, state: PicksState): void {
    if (this.host !== host) {
      this.host = host;
      this.html = "";
      host.addEventListener("click", (e) => this.onClick(e));
      host.addEventListener("input", (e) => this.onInput(e));
      host.addEventListener("focusout", (e) => this.onFocusOut(e));
    }
    this.last = state;
    const typing = host.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement;
    if (typing && this.html) {
      this.pending = state;
      return;
    }
    this.pending = null;
    const html = this.render(state);
    if (html === this.html) return;
    this.html = html;
    host.innerHTML = html;
  }

  detach(): void {
    this.host = null;
    this.html = "";
  }

  private onFocusOut(e: FocusEvent): void {
    // Focus moving to a button of this card (Send to chat) must not redraw it
    // under the click; that click redraws anyway.
    if (e.relatedTarget instanceof Node && this.host?.contains(e.relatedTarget)) return;
    // The box lost focus, so a held redraw can land now.
    setTimeout(() => {
      if (this.pending && this.host) this.update(this.host, this.pending);
    }, 0);
  }

  private onInput(e: Event): void {
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement)) return;
    const id = t.closest<HTMLElement>("[data-pk]")?.dataset["pk"];
    if (id) this.typed.set(id, t.value);
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-pk-act]");
    if (!btn || !this.host?.contains(btn)) return;
    const act = btn.dataset["pkAct"];
    const id = btn.closest<HTMLElement>("[data-pk]")?.dataset["pk"] ?? "";
    switch (act) {
      case "agree":
        this.failed.delete(id);
        void this.review(id, "agree");
        break;
      case "overrule-open":
        this.overruling = id;
        this.redraw();
        [...this.host.querySelectorAll<HTMLElement>("[data-pk]")].find((el) => el.dataset["pk"] === id)?.querySelector("textarea")?.focus();
        break;
      case "overrule-cancel":
        this.overruling = null;
        this.failed.delete(id);
        this.redraw();
        break;
      case "overrule-send":
        void this.overrule(id);
        break;
      case "resend":
        void this.resend(id);
        break;
      case "done-toggle":
        this.doneOpen = !this.doneOpen;
        this.redraw();
        break;
    }
  }

  private redraw(): void {
    if (this.host && this.last) this.update(this.host, this.last);
  }

  private find(id: string): AutopilotPick | undefined {
    return this.side?.picks.find((p) => p.id === id);
  }

  private async review(id: string, action: "agree" | "overrule", instead = ""): Promise<boolean> {
    const sessionId = this.cb.sessionId();
    if (!sessionId || !id) return false;
    try {
      this.adopt(await invoke<unknown>("picks_review", { sessionId, id, action, instead }));
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private async overrule(id: string): Promise<void> {
    // An untouched box still holds the earlier answer (rowHtml prefills it), and no input event fired for it.
    const instead = (this.typed.get(id) ?? this.find(id)?.instead ?? "").trim();
    if (!instead) {
      showToast("Say what you want instead.");
      // A redraw held while Joe typed lands now: focus moved to this button, not away.
      this.redraw();
      return;
    }
    if (this.sending.has(id)) return;
    this.sending.add(id);
    try {
      await this.overruleNow(id, instead);
    } finally {
      this.sending.delete(id);
    }
  }

  /** Sends `text` to the chat that owns the list (a sub's dashboard reads its
   *  main chat's picks, and only that chat changes the code). Marks the row when
   *  the send is refused, so the failure is visible where Joe looked. */
  private async deliver(id: string, text: string): Promise<boolean> {
    const owner = this.side?.owner || this.cb.sessionId();
    let ok = false;
    if (owner) {
      try {
        ok = await this.cb.send(text, owner);
      } catch (err) {
        console.warn("[chat-dashboard] picks send failed", err);
      }
    }
    if (ok) this.failed.delete(id);
    else this.failed.add(id);
    return ok;
  }

  private async overruleNow(id: string, instead: string): Promise<void> {
    const pick = this.find(id);
    if (!pick) return;
    const message = overruleMessage(pick, instead);
    // Sent before the row is marked, so a refused send never leaves a row that
    // reads "To fix" for a correction nobody received; the box keeps its text.
    // A correction the chat already got (the save failed after it) is not sent twice.
    if (this.delivered.get(id) !== message && !(await this.deliver(id, message))) {
      this.redraw();
      return;
    }
    this.delivered.set(id, message);
    if (!(await this.review(id, "overrule", instead))) {
      this.redraw();
      return;
    }
    this.delivered.delete(id);
    this.failed.delete(id);
    this.overruling = null;
    this.typed.delete(id);
    this.redraw();
  }

  private async resend(id: string): Promise<void> {
    const pick = this.find(id);
    if (!pick?.instead || this.sending.has(id)) return;
    this.sending.add(id);
    this.redraw();
    try {
      await this.deliver(id, overruleMessage(pick, pick.instead));
    } finally {
      this.sending.delete(id);
      this.redraw();
    }
  }

  private rowHtml(p: AutopilotPick): string {
    const others = p.options.filter((o) => o !== p.pick);
    const when = p.date ? localTime(new Date(p.date)) : "";
    const meta = [p.who, p.landed, when].filter(Boolean).map(escapeHtml).join(" · ");
    const chip = `<span class="pk-chip pk-${p.status}">${STATUS_LABEL[p.status]}</span>`;
    const instead = p.instead ? `<div class="pk-instead"><i class="ph ph-arrow-bend-down-right"></i>You want: ${escapeHtml(p.instead)}</div>` : "";
    const refused = this.failed.has(p.id)
      ? `<div class="pk-instead pk-send-failed"><i class="ph ph-warning"></i>The chat did not get this message.</div>` : "";
    const fixed = p.corrected_note ? `<div class="pk-instead"><i class="ph ph-check"></i>${escapeHtml(p.corrected_note)}</div>` : "";
    let acts = "";
    if (p.status === "unreviewed") {
      acts = `<button type="button" class="pk-btn pk-agree" data-pk-act="agree"><i class="ph ph-check"></i>Agree</button>`
        + `<button type="button" class="pk-btn pk-over" data-pk-act="overrule-open"><i class="ph ph-arrow-u-up-left"></i>Overrule</button>`;
    } else if (p.status === "overruled") {
      acts = `<button type="button" class="pk-btn" data-pk-act="resend" title="Send the correction to the chat again"${this.sending.has(p.id) ? " disabled" : ""}><i class="ph ph-paper-plane-tilt"></i>Send again</button>`
        + `<button type="button" class="pk-btn pk-over" data-pk-act="overrule-open">Change answer</button>`;
    }
    const form = this.overruling === p.id
      ? `<div class="pk-form"><textarea rows="2" placeholder="What should it be instead?">${escapeHtml(this.typed.get(p.id) ?? p.instead ?? "")}</textarea>`
        + `<div class="pk-form-acts"><button type="button" class="pk-btn pk-over" data-pk-act="overrule-send"><i class="ph ph-paper-plane-tilt"></i>Send to chat</button>`
        + `<button type="button" class="pk-btn" data-pk-act="overrule-cancel">Cancel</button></div></div>`
      : "";
    return `<article class="pk-item pk-s-${p.status}" data-pk="${escapeHtml(p.id)}">`
      + `<div class="pk-q">${escapeHtml(p.question)}${chip}</div>`
      + `<div class="pk-pick"><i class="ph ph-seal-check"></i><b>${escapeHtml(p.pick)}</b>${others.length ? `<span class="pk-alts">not ${escapeHtml(others.join(", "))}</span>` : ""}</div>`
      + `<div class="pk-why">${escapeHtml(p.reason)}</div>${instead}${fixed}${refused}`
      + (meta ? `<div class="pk-meta">${meta}</div>` : "")
      + (acts ? `<div class="pk-acts">${acts}</div>` : "") + form + `</article>`;
  }

  private render(s: PicksState): string {
    const toReview = s.unreviewed.length;
    const lead = toReview > 0
      ? `${toReview} ${toReview === 1 ? "choice" : "choices"} Claude made without you. Agree, or say what you want instead.`
      : s.overruled.length > 0 ? "Waiting for the code changes you asked for." : "Everything is reviewed.";
    const over = s.overruled.length > 0
      ? `<div class="pk-sect">To fix <span class="pk-n">${s.overruled.length}</span></div>${s.overruled.map((p) => this.rowHtml(p)).join("")}` : "";
    const fold = s.done.length > 0
      ? `<button type="button" class="pk-fold" data-pk-act="done-toggle" aria-expanded="${this.doneOpen}"><i class="ph ph-check"></i>${s.done.length} reviewed<i class="ph ${this.doneOpen ? "ph-caret-up" : "ph-caret-down"}"></i></button>`
        + (this.doneOpen ? s.done.map((p) => this.rowHtml(p)).join("") : "") : "";
    return `<p class="pk-lead">${escapeHtml(lead)}</p>${s.unreviewed.map((p) => this.rowHtml(p)).join("")}${over}${fold}`;
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.host = null;
  }
}
