import type { SlashEntry, SlashSource } from "../../../../types/ipc.generated";
import { invoke } from "../../../ipc";
import { getTransport } from "../../../transport";
import { setSlashEntries, slashEntryQualifiedName } from "../../slash-registry";
import { insertAtCaret } from "../insert-at-caret";
import { match } from "../match";
import type { SuggestProvider } from "../types";

export class SlashProvider implements SuggestProvider<SlashEntry> {
  triggerChar = "/";
  private cache: SlashEntry[] = [];
  private unlisten: (() => void) | null = null;
  private projectDir: string | null = null;

  async start(projectDir: string | null): Promise<void> {
    this.projectDir = projectDir;
    await this.refetch();
    this.unlisten = await getTransport().listen("slash-commands-changed", () => {
      void this.refetch();
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  shouldTrigger({ textBefore }: { textBefore: string; caretPos: number }): boolean {
    return /(^|\s)\/[^\s]*$/.test(textBefore);
  }

  query(token: string): SlashEntry[] {
    return match(this.cache, token.slice(1));
  }

  renderRow(e: SlashEntry, selected: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = selected ? "row selected" : "row";

    const head = document.createElement("div");
    head.className = "head";
    const fullName = slashEntryQualifiedName(e) ?? e.name;
    head.textContent = e.args ? `/${fullName} ${e.args}` : `/${fullName}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    const kind = (e.source as { kind: string }).kind;
    // Only project-local kinds get a badge; everything else (builtin, user,
    // plugin) renders quietly with just the description.
    if (kind === "project-skill" || kind === "project-command") {
      const badge = document.createElement("span");
      badge.className = `badge ${kind}`;
      badge.textContent = sourceLabel(e.source);
      meta.appendChild(badge);
    }
    if (e.description) {
      meta.append(e.description);
    }

    row.appendChild(head);
    row.appendChild(meta);
    return row;
  }

  onPick(e: SlashEntry, ta: HTMLTextAreaElement, [start, end]: [number, number]): void {
    const insert = `/${slashEntryQualifiedName(e) ?? e.name} `;
    insertAtCaret(ta, insert, start, end);
    ta.focus();
  }

  private async refetch(): Promise<void> {
    try {
      this.cache = await invoke<SlashEntry[]>("list_slash_commands", {
        projectDir: this.projectDir,
      });
    } catch (e) {
      console.error("[SlashProvider] list_slash_commands failed", e);
      this.cache = [];
    }
    setSlashEntries(this.cache);
  }
}

function sourceLabel(s: SlashSource): string {
  const k = (s as { kind: string }).kind;
  switch (k) {
    case "builtin":
      return "built";
    case "user-command":
      return "cmd";
    case "project-command":
      return "local";
    case "user-skill":
      return "skill";
    case "project-skill":
      return "local";
    case "plugin-skill":
      return `plugin:${(s as { plugin: string }).plugin}`;
    case "plugin-command":
      return `plugin:${(s as { plugin: string }).plugin}`;
    default:
      return k;
  }
}
