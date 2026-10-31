// The composer's per-project skill scope warning. A skill or
// plugin scoped to other projects is missing from this chat's `claude`, which
// refuses it when typed ("disabled via skillOverrides"). So a draft that starts
// with one shows a quiet line above the input, and sending it enables the skill
// for this project first, restarting the chat with its history kept.

import type { SlashEntry } from "../../types/ipc.generated";
import { invoke } from "../ipc";
import { isRemote } from "../transport";
import { state } from "../../views/sessions/state";
import { isMirrored } from "../../views/sessions/sessions-helpers";
import { isPendingSessionId } from "./pending-session-id";
import { slashEntryQualifiedName } from "./slash-registry";

/** The off-here entry the draft's leading `/name` names, or null. */
export function offHereEntry(text: string, entries: readonly SlashEntry[]): SlashEntry | null {
  const m = /^\/([\w:.-]+)/.exec(text.trimStart());
  if (!m) return null;
  const typed = m[1];
  return entries.find((e) => e.off_here && (slashEntryQualifiedName(e) ?? e.name) === typed) ?? null;
}

function displayName(e: SlashEntry): string {
  return slashEntryQualifiedName(e) ?? e.name;
}

function pluginName(e: SlashEntry): string | null {
  const src = e.source as { kind: string; plugin?: string };
  return src.kind === "plugin-skill" || src.kind === "plugin-command" ? (src.plugin ?? null) : null;
}

export interface SkillScopeHost {
  getProjectDir: () => string | null;
  getSessionId: () => string | null;
  getEntries: () => readonly SlashEntry[];
  /** Re-reads the slash list so the enabled skill stops showing as off. */
  refreshEntries: () => Promise<void>;
  /** "Send anyway": send the draft as-is, skipping the enable step. */
  sendAnyway: () => void;
  /** "Enable here": the same path Enter takes. */
  sendWithEnable: () => void;
  notice: (text: string) => void;
}

export class SkillScopeWarning {
  private el: HTMLElement | null = null;
  private busy = false;

  constructor(private host: SkillScopeHost) {}

  bind(el: HTMLElement | null): void {
    this.el = el;
    this.busy = false;
  }

  /** Re-evaluates the warning against the current draft. */
  update(text: string): void {
    if (!this.el || this.busy) return;
    const e = offHereEntry(text, this.host.getEntries());
    if (!e) {
      this.el.hidden = true;
      this.el.replaceChildren();
      return;
    }
    const plugin = pluginName(e);
    const icon = document.createElement("i");
    icon.className = "ph ph-eye-slash";
    const msg = document.createElement("span");
    const code = document.createElement("code");
    code.textContent = `/${displayName(e)}`;
    msg.append(code, " is off in this project");
    if (plugin) msg.append(` (turns on the whole ${plugin} plugin)`);
    msg.append(".");
    const parts: Node[] = [icon, msg];
    // The phone can't save settings, but `enable_skill_here` reaches it as two
    // narrow daemon RPCs (http-transport.ts), so both platforms get the button.
    // A mirrored chat on the phone has no working action: the daemon refuses
    // the scope write for a session hosted elsewhere, and a plain send already
    // goes through as-is, so the line stays informational.
    if (!this.phoneOnMirroredChat()) {
      parts.push(this.link("Enable here", "", () => this.host.sendWithEnable()));
      parts.push(this.link("Send anyway", "quiet", () => this.host.sendAnyway()));
    }
    this.el.replaceChildren(...parts);
    this.el.hidden = false;
  }

  /** Whether a send of `text` has to enable a skill first. */
  needsEnable(text: string): SlashEntry | null {
    if (this.phoneOnMirroredChat()) return null;
    return offHereEntry(text, this.host.getEntries());
  }

  /** The phone's `add_project_to_skill_scope` is refused for a session hosted
   * on a paired machine ("not available for a session hosted on another
   * machine"), so enabling would fail and block the send. Desktop keeps its own
   * path for mirrored chats, hence the isRemote gate. */
  private phoneOnMirroredChat(): boolean {
    if (!isRemote()) return false;
    const sid = this.host.getSessionId();
    return isMirrored(state.sessions.find((s) => s.session_id === sid));
  }

  /** Enables `e` for this project and restarts the chat. False (draft kept,
   * reason shown) when it couldn't. */
  async enable(e: SlashEntry): Promise<boolean> {
    const projectDir = this.host.getProjectDir();
    if (!projectDir || !e.scope_key) {
      this.host.notice(`Couldn't enable /${displayName(e)}: this chat has no project.`);
      return false;
    }
    const sid = this.host.getSessionId();
    this.busy = true;
    this.status(`Enabling /${displayName(e)} here and restarting the chat...`, true);
    try {
      await invoke<boolean>("enable_skill_here", {
        projectDir,
        key: e.scope_key,
        sessionId: sid && !isPendingSessionId(sid) ? sid : null,
      });
      await this.host.refreshEntries();
      this.busy = false;
      this.hide();
      this.host.notice(`/${displayName(e)} is now enabled in this project.`);
      return true;
    } catch (err) {
      console.error("[skill-scope] enable_skill_here failed", err);
      this.busy = false;
      this.hide();
      this.host.notice(`Couldn't enable /${displayName(e)}: ${String(err)}`);
      return false;
    }
  }

  hide(): void {
    if (!this.el) return;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private status(text: string, spinning: boolean): void {
    if (!this.el) return;
    const icon = document.createElement("i");
    icon.className = spinning ? "ph ph-circle-notch composer-scope-spin" : "ph ph-check";
    const span = document.createElement("span");
    span.textContent = text;
    this.el.replaceChildren(icon, span);
    this.el.hidden = false;
  }

  private link(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `composer-scope-link ${cls}`.trim();
    b.textContent = label;
    // mousedown keeps focus in the textarea, so Enter still works after.
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", onClick);
    return b;
  }
}
