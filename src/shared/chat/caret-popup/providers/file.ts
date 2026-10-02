import { invoke } from "../../../ipc";
import { insertAtCaret } from "../insert-at-caret";
import { matchFiles } from "../match-files";
import type { SuggestProvider } from "../types";

export class FileProvider implements SuggestProvider<string> {
  triggerChar = "@";
  private cache: string[] = [];
  private projectDir: string | null = null;
  private inflight: Promise<void> | null = null;
  private fetchedThisOpen = false;
  // Set by the popup at mount time; invoked once refetch() lands so a
  // keystroke that queried against the still-empty cache gets re-evaluated
  // instead of leaving the popup closed (todo 1037).
  private notify: (() => void) | null = null;

  start(projectDir: string | null): void {
    this.projectDir = projectDir;
  }

  onReady(notify: () => void): void {
    this.notify = notify;
  }

  stop(): void {
    // no listener; nothing to detach
  }

  shouldTrigger({ textBefore }: { textBefore: string; caretPos: number }): boolean {
    return /(^|\s)@[^\s]*$/.test(textBefore);
  }

  query(token: string): string[] {
    if (!this.fetchedThisOpen) {
      this.fetchedThisOpen = true;
      void this.refetch();
    }
    return matchFiles(this.cache, token.slice(1));
  }

  onClosed(): void {
    this.fetchedThisOpen = false;
  }

  renderRow(p: string, selected: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = selected ? "row selected" : "row";
    const slash = p.lastIndexOf("/");
    const base = slash < 0 ? p : p.slice(slash + 1);
    const dir = slash < 0 ? "(root)" : p.slice(0, slash);
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = "@" + base;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = dir;
    row.appendChild(head);
    row.appendChild(meta);
    return row;
  }

  onPick(p: string, ta: HTMLTextAreaElement, [start, end]: [number, number]): void {
    const insert = `@${p} `;
    insertAtCaret(ta, insert, start, end);
    ta.focus();
  }

  private async refetch(): Promise<void> {
    if (!this.projectDir) {
      this.cache = [];
      return;
    }
    const projectDir = this.projectDir;
    this.inflight = (async () => {
      try {
        this.cache = await invoke<string[]>("list_project_files", { projectDir });
      } catch (e) {
        console.error("[FileProvider] list_project_files failed", e);
        this.cache = [];
      }
      // Re-run the pipeline even on failure/empty: a keystroke that is still
      // live and no longer matches anything should close, not stay stuck
      // open from a stale render.
      this.notify?.();
    })();
    await this.inflight;
    this.inflight = null;
  }
}
