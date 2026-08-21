import type { PopupOptions, SuggestProvider } from "./types";

export class CaretSuggestPopup {
  private opts: PopupOptions;
  private el: HTMLDivElement;
  private items: unknown[] = [];
  private selectedIdx = 0;
  private tokenRange: [number, number] = [0, 0];
  private active: SuggestProvider<unknown> | null = null;
  private open = false;
  private onDocMouseDown: (e: MouseEvent) => void;

  constructor(opts: PopupOptions) {
    this.opts = opts;
    this.el = document.createElement("div");
    this.el.className = "caret-popup";
    this.el.hidden = true;
    opts.anchor.appendChild(this.el);

    this.onDocMouseDown = (e) => {
      if (!this.open) return;
      const t = e.target as Node;
      if (!this.el.contains(t) && t !== opts.textarea) {
        this.close();
      }
    };
    document.addEventListener("mousedown", this.onDocMouseDown);
  }

  isOpen(): boolean {
    return this.open;
  }

  handleInput(): void {
    const ta = this.opts.textarea;
    const caret = ta.selectionStart ?? ta.value.length;
    const value = ta.value;
    const before = value.slice(0, caret);

    let chosen: SuggestProvider<unknown> | null = null;
    for (const p of this.opts.providers) {
      if (p.shouldTrigger({ textBefore: before, caretPos: caret })) {
        chosen = p;
        break;
      }
    }
    if (!chosen) {
      this.close();
      return;
    }
    const m = before.match(/(^|\s)([/@][^\s]*)$/);
    const backPart = m?.[2];
    if (!backPart) {
      this.close();
      return;
    }
    const start = caret - backPart.length;
    // Extend past the caret to the end of the word too: the trigger char
    // can land at the start of a word already typed (e.g. "clo" then "/"
    // inserted before it), and the query - and the range replaced on pick -
    // need the whole word, not just what's left of the caret.
    const rest = /^\S*/.exec(value.slice(caret));
    const end = caret + (rest?.[0].length ?? 0);
    const token = value.slice(start, end);
    this.tokenRange = [start, end];

    const results = chosen.query(token);
    if (!results.length) {
      this.close();
      return;
    }
    this.items = results;
    this.active = chosen;
    this.selectedIdx = 0;
    this.open = true;
    this.render();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.selectedIdx = (this.selectedIdx + 1) % this.items.length;
        this.render();
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.selectedIdx = (this.selectedIdx - 1 + this.items.length) % this.items.length;
        this.render();
        return true;
      case "Enter":
      case "Tab": {
        e.preventDefault();
        const item = this.items[this.selectedIdx];
        if (item !== undefined) this.pick(item);
        return true;
      }
      case "Escape":
        e.preventDefault();
        this.close();
        return true;
    }
    return false;
  }

  destroy(): void {
    document.removeEventListener("mousedown", this.onDocMouseDown);
    this.el.remove();
  }

  private pick(item: unknown): void {
    this.active?.onPick(item, this.opts.textarea, this.tokenRange);
    this.close();
  }

  private close(): void {
    const wasOpen = this.open;
    const prev = this.active;
    this.open = false;
    this.active = null;
    this.el.hidden = true;
    this.el.replaceChildren();
    if (wasOpen) prev?.onClosed?.();
  }

  private render(): void {
    if (!this.active) return;
    const active = this.active;
    this.el.hidden = false;
    const rows = this.items.map((it, i) => {
      const row = active.renderRow(it, i === this.selectedIdx);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pick(it);
      });
      return row;
    });
    this.el.replaceChildren(...rows);
    rows[this.selectedIdx]?.scrollIntoView?.({ block: "nearest" });
  }
}
