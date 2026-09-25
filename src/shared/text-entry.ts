// Shared focus predicates, replacing four independent copies that had
// drifted into three different definitions (ai_todo 948). Two predicates on
// purpose, never one with a boolean flag: the two questions read differently
// at a call site, and a bare true/false argument hides which is meant.

/** True for input/textarea/contenteditable - the elements that steal a typed
 *  keystroke and are what raises a phone's soft keyboard. Deliberately
 *  excludes `<select>`: a focused select opens a native picker with no soft
 *  keyboard to lower, and doesn't consume typed characters either, so it
 *  answers a different question than isFormControlElement below. */
export function isTextEntryElement(el: EventTarget | null | undefined): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el instanceof HTMLTextAreaElement
    || el instanceof HTMLInputElement
    || el.isContentEditable;
}

/** isTextEntryElement plus HTMLSelectElement - "would this keystroke be
 *  stolen from a form control", where a select's arrow-key/typeahead
 *  handling counts even though it never raises a soft keyboard. */
export function isFormControlElement(el: EventTarget | null | undefined): boolean {
  return isTextEntryElement(el) || el instanceof HTMLSelectElement;
}
