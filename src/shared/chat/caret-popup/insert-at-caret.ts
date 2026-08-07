/** setRangeText (not .value assignment) keeps the edit on the native undo stack. */
export function insertAtCaret(ta: HTMLTextAreaElement, text: string, start: number, end: number): void {
  ta.setRangeText(text, start, end, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
