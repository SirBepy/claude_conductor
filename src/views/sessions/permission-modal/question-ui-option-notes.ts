// Per-option notes on the AUQ card: which options still count as picked, the
// notes that will actually ship, and the click/input wiring for the pencil and
// the note box. Split out of question-ui-render.ts.

import type { QuestionRenderState } from "./question-ui-templates";
import type { OptionNotes, Selection } from "./types";

export interface OptionNotesDeps {
  host: HTMLElement;
  state: QuestionRenderState;
  notes: OptionNotes;
  selections: Map<number, Selection>;
  render: () => void;
  syncMessagesPadding: () => void;
  notifyDraftChange: () => void;
}

export interface OptionNotesController {
  isPicked: (qi: number, label: string) => boolean;
  /** The notes that will actually ship: only on options still ticked. */
  tickedNotes: (qi: number) => [string, string][];
  /** Wires the pencil, the note preview and the note box after a render(). */
  wire: () => void;
}

export function createOptionNotes(deps: OptionNotesDeps): OptionNotesController {
  const { host, state, notes, selections, render, syncMessagesPadding, notifyDraftChange } = deps;

  function isPicked(qi: number, label: string): boolean {
    const sel = selections.get(qi);
    return sel instanceof Set ? sel.has(label) : sel === label;
  }

  function tickedNotes(qi: number): [string, string][] {
    return Array.from(notes.get(qi) ?? [])
      .filter(([label, text]) => text.trim() && isPicked(qi, label))
      .map(([label, text]) => [label, text.trim()]);
  }

  function openNote(qi: number, label: string | null): void {
    state.editingNote = label === null ? null : { qi, label };
    render();
    if (label === null) return;
    const field = host.querySelector<HTMLTextAreaElement>(`.prompt-panel[data-panel="${qi}"] .prompt-opt__note-input`);
    field?.focus();
    if (field) field.selectionStart = field.selectionEnd = field.value.length;
  }

  // Everything here sits inside the option's <label>, so each click handler
  // preventDefaults: a click on the label's plain text would otherwise toggle
  // the option it is annotating.
  function wire(): void {
    const panelOf = (el: Element): number => Number(el.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
    host.querySelectorAll<HTMLButtonElement>("[data-note-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const qi = panelOf(btn);
        const label = btn.dataset.noteToggle ?? "";
        const open = state.editingNote?.qi === qi && state.editingNote.label === label;
        openNote(qi, open ? null : label);
      });
    });
    host.querySelectorAll<HTMLElement>(".prompt-opt__note").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const label = el.closest(".prompt-opt")?.querySelector<HTMLInputElement>("input")?.dataset.label;
        if (label !== undefined) openNote(panelOf(el), label);
      });
    });
    host.querySelectorAll<HTMLTextAreaElement>(".prompt-opt__note-input").forEach((field) => {
      field.addEventListener("click", (e) => e.preventDefault());
      field.addEventListener("input", () => {
        const qi = panelOf(field);
        const label = field.dataset.noteFor ?? "";
        const forQ = notes.get(qi) ?? new Map<string, string>();
        if (field.value.trim()) forQ.set(label, field.value);
        else forQ.delete(label);
        notes.set(qi, forQ);
        syncMessagesPadding();
        notifyDraftChange();
      });
    });
  }

  return { isPicked, tickedNotes, wire };
}
