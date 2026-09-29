// Keyboard driving for the AUQ card. Tab enters the option list from a text
// box (the composer usually owns focus when a card appears, so arrows can't
// just act globally), and every other key only acts while an option itself
// has focus - typing into the composer or the answer box is never touched.

import type { QuestionRenderState } from "./question-ui-templates";
import type { Question } from "./types";

export interface QuestionKeyboardDeps {
  host: HTMLElement;
  questions: Question[];
  hasSummary: boolean;
  totalPanels: number;
  state: QuestionRenderState;
  answeredAt: (qi: number) => boolean;
  goToTab: (target: number) => void;
  togglePick: (qi: number, label: string) => void;
}

function panelOptions(host: HTMLElement, qi: number): HTMLInputElement[] {
  return Array.from(host.querySelectorAll<HTMLInputElement>(`.prompt-panel[data-panel="${qi}"] .prompt-q__opts input`));
}

function answerField(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector<HTMLTextAreaElement>(".prompt-card__answer-bar textarea");
}

// A never-focused textarea puts its caret at 0, which would land a redirected
// keystroke in front of whatever was already typed.
function focusAnswerField(host: HTMLElement): boolean {
  const field = answerField(host);
  if (!field) return false;
  field.focus();
  field.selectionStart = field.selectionEnd = field.value.length;
  return true;
}

/** Focuses whatever the active panel should hand the keyboard: its picked (or
 *  first) option, the Submit button on review so Enter sends, else the answer
 *  box of a free-text-only question. */
export function focusActivePanel(host: HTMLElement, activeTab: number, isReview: boolean): boolean {
  const opts = panelOptions(host, activeTab);
  if (opts.length) {
    (opts.find((o) => o.checked) ?? opts[0])?.focus();
    return true;
  }
  if (isReview) {
    const primary = host.querySelector<HTMLButtonElement>('[data-act="primary"]');
    primary?.focus();
    return Boolean(primary);
  }
  return focusAnswerField(host);
}

/** Returns true when the key was consumed by the card. */
export function handleQuestionCardKey(e: KeyboardEvent, deps: QuestionKeyboardDeps): boolean {
  const { host, questions, hasSummary, totalPanels, state, answeredAt, goToTab, togglePick } = deps;
  // defaultPrevented: the slash popup's own Tab/arrow handling already ran on
  // the textarea before this document-level listener.
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !host.isConnected) return false;
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const isReview = () => hasSummary && state.activeTab === questions.length;
  const refocus = () => { if (host.isConnected) focusActivePanel(host, state.activeTab, isReview()); };
  // Ungated, unlike the Next arrow: paging is free like the dots, so an
  // unanswered question can be skipped and come back to later.
  const page = (dir: -1 | 1) => {
    const next = state.activeTab + dir;
    if (next < 0 || next > totalPanels - 1) return;
    goToTab(next);
    refocus();
  };

  const option = target instanceof HTMLInputElement && host.contains(target) && target.closest(".prompt-q__opts")
    ? target
    : null;

  if (!option) {
    // Review has no options, so focus rests on a card button there - paging
    // must still work from it or Left could never leave review.
    if (target instanceof HTMLButtonElement && host.contains(target) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      page(e.key === "ArrowLeft" ? -1 : 1);
      return true;
    }
    if (!(target instanceof HTMLTextAreaElement)) return false;
    const inCardOrComposer = host.contains(target) || Boolean(target.closest(".session-composer"));
    if (!inCardOrComposer) return false;
    const opts = panelOptions(host, state.activeTab);
    if (!opts.length) return false;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      (opts.find((o) => o.checked) ?? opts[0])?.focus();
      return true;
    }
    // Up from the very start of the answer box climbs back into the options
    // sitting above it, mirroring Down off the last option.
    if (e.key === "ArrowUp" && target === answerField(host) && target.selectionStart === 0 && target.selectionEnd === 0) {
      e.preventDefault();
      opts[opts.length - 1]?.focus();
      return true;
    }
    return false;
  }

  const qi = Number(option.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
  const q = questions[qi];
  if (!q) return false;
  const opts = panelOptions(host, qi);
  const idx = opts.indexOf(option);
  const label = option.dataset.label ?? "";

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (idx < opts.length - 1) opts[idx + 1]?.focus();
      else focusAnswerField(host);
      return true;
    case "ArrowUp":
      e.preventDefault();
      if (idx > 0) opts[idx - 1]?.focus();
      return true;
    case "ArrowLeft":
    case "ArrowRight":
      e.preventDefault();
      page(e.key === "ArrowLeft" ? -1 : 1);
      return true;
    case " ":
      // Native Space clicks the input, and a single-select click auto-advances
      // - Space must stay put so a pick can be combined with a typed answer.
      e.preventDefault();
      togglePick(qi, label);
      return true;
    case "Enter": {
      e.preventDefault();
      if (!q.multiSelect && !answeredAt(qi)) togglePick(qi, label);
      const primary = host.querySelector<HTMLButtonElement>('[data-act="primary"]');
      if (primary && !primary.disabled) primary.click();
      refocus();
      return true;
    }
    case "Tab":
      if (e.shiftKey) return false;
      e.preventDefault();
      focusAnswerField(host);
      return true;
    default:
      // Typing on an option means "write an answer": move focus before the
      // keypress fires so the character itself lands in the answer box.
      if (e.key.length === 1) focusAnswerField(host);
      return false;
  }
}
