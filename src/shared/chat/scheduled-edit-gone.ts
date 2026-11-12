/** Thrown by a scheduled edit's `onSave` when the item it edits has fired or been
 *  deleted: retrying can never succeed, so the composer leaves edit mode and keeps
 *  the text as a plain draft instead of failing every Send the same way. */
export class ScheduledEditGoneError extends Error {
  constructor() {
    super("scheduled item no longer pending");
    this.name = "ScheduledEditGoneError";
  }
}
