// The "Quick actions" editor inside the Dashboard cards modal: the per-scope
// pinned slash commands behind the dashboard's one-line chip track.
import { html, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import type { Scope } from "./types";

/** Mirrors the backend's PINNED_MAX; checking here keeps the whole-call rejection from being the first the user hears of it. */
export const PINNED_MAX = 20;

/** The command as it would be pinned, or the reason it cannot be. Empty input is neither: the caller just ignores it. */
export function checkPin(raw: string, pins: string[]): { pin: string } | { error: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const pin = text.startsWith("/") ? text : `/${text}`;
  if (pin.length < 2) return null;
  // The first word decides, as in the backend: "/close now" is a /close in disguise.
  if (/^\/close(\s|$)/i.test(pin)) return { error: "/close cannot be pinned" };
  if (pins.includes(pin)) return { error: `${pin} is already pinned` };
  if (pins.length >= PINNED_MAX) return { error: `At most ${PINNED_MAX} pinned actions` };
  return { pin };
}

export interface PinsEditor {
  view: () => TemplateResult;
}

export function pinsEditor(initial: string[], scope: Scope, redraw: () => void): PinsEditor {
  let pins = [...initial];
  let draft = "";
  let error = "";
  let saving = false;

  // The backend's reply is the saved list (trimmed, deduped), so the editor
  // shows what the dashboard will, not what was typed. A failure keeps the old
  // list and shows the backend's line, since the UI checks cannot cover every rule.
  const save = async (next: string[]): Promise<boolean> => {
    if (saving) return false;
    saving = true;
    try {
      const saved = await invoke<string[] | null>("dashboard_set_pinned_actions", { scope, actions: next });
      pins = Array.isArray(saved) ? saved : next;
      error = "";
      return true;
    } catch (err) {
      error = String(err);
      return false;
    } finally {
      saving = false;
      redraw();
    }
  };

  const add = async (): Promise<void> => {
    const verdict = checkPin(draft, pins);
    if (!verdict) return;
    if ("error" in verdict) { error = verdict.error; redraw(); return; }
    if (await save([...pins, verdict.pin])) draft = "";
    redraw();
  };

  const move = (i: number, by: -1 | 1): void => {
    const next = [...pins];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    void save(next);
  };

  const row = (pin: string, i: number): TemplateResult => html`
    <div class="pd-mrow" data-pd-pin=${pin}>
      <span class="pd-mt">${pin}</span>
      <button type="button" class="pd-ib sm" title="Move up" ?disabled=${i === 0} @click=${() => move(i, -1)}><i class="ph ph-caret-up"></i></button>
      <button type="button" class="pd-ib sm" title="Move down" ?disabled=${i === pins.length - 1} @click=${() => move(i, 1)}><i class="ph ph-caret-down"></i></button>
      <button type="button" class="pd-ib sm" title="Remove" @click=${() => void save(pins.filter((_, j) => j !== i))}><i class="ph ph-x"></i></button>
    </div>`;

  return {
    view: () => html`
      <div class="pd-msec">Quick actions</div>
      ${pins.length ? pins.map(row) : html`<div class="pd-quiet">Empty: the most-used commands from recent chats show instead.</div>`}
      <div class="pd-mrow pd-pin-add">
        <input type="text" class="pd-pin-input" placeholder="/command" autocomplete="off" spellcheck="false"
          .value=${draft}
          @input=${(e: Event) => { draft = (e.target as HTMLInputElement).value; if (error) { error = ""; redraw(); } }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}>
        <button type="button" class="btn btn-secondary pd-pin-btn" @click=${() => void add()}>Add</button>
      </div>
      ${error ? html`<div class="pd-err" role="alert">${error}</div>` : ""}`,
  };
}
