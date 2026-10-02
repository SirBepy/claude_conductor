export interface SuggestProvider<T> {
  triggerChar: string;
  shouldTrigger(ctx: { textBefore: string; caretPos: number }): boolean;
  query(token: string): T[];
  renderRow(item: T, selected: boolean): HTMLElement;
  onPick(item: T, textarea: HTMLTextAreaElement, tokenRange: [number, number]): void;
  /** Called whenever the popup transitions from open to closed. */
  onClosed?(): void;
  /** Called once, when the popup mounts, with a callback the provider can
   *  invoke after an async cache refresh lands (e.g. a slower remote fetch
   *  that was still in flight when `query()` first ran and returned empty).
   *  Re-runs the popup's input pipeline so a trigger that found nothing
   *  before the fetch resolved gets re-evaluated instead of staying closed
   *  forever (todo 1037). */
  onReady?(notify: () => void): void;
}

export interface PopupOptions {
  anchor: HTMLElement;
  textarea: HTMLTextAreaElement;
  providers: SuggestProvider<unknown>[];
}
