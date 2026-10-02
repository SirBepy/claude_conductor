// The draft editor's "Revise" menu: one-click instructions sent to the chat
// that wrote the draft, so iterating on a message needs no typing. Scoped to
// the highlighted span when there is one, otherwise the whole draft.

import { escapeHtml } from "../../shared/escape-html";
import { sessionEvents } from "../../shared/chat/event-store";
import { showToast } from "../../shared/toast";
import { currentVersion, handleOf } from "../../shared/message-draft-utils";
import { htmlToMarkdown } from "../../shared/chat/draft-markdown";
import type { ChatEvent, ContentBlock, DraftVariant, MessageDraft } from "../../types/ipc.generated";
import { sendOrStage } from "./send-or-stage";
import { sendWithFailureRecovery } from "./send-with-failure-recovery";
import { state } from "./state";

export const REVISE_PRESETS = [
  { key: "shorter", icon: "ph-arrows-in-line-horizontal", label: "Shorter", ask: "Make it shorter. Keep every fact that matters." },
  { key: "explain", icon: "ph-lightbulb", label: "Explain better", ask: "Explain it better: clearer for a reader who does not share our context." },
  { key: "casual", icon: "ph-smiley", label: "More casual", ask: "Make it more casual and friendly." },
  { key: "direct", icon: "ph-arrow-right", label: "More direct", ask: "Make it more direct: lead with the point and cut the softening." },
  {
    key: "accuracy",
    icon: "ph-magnifying-glass",
    label: "Check accuracy",
    ask:
      "Check every factual claim in it with subagents against what can actually be verified (code, git history, " +
      "command output, what I said). Fix anything wrong, and drop certainty language from anything you could not " +
      "verify. Tell me what you changed and why.",
  },
] as const;

export interface RevisionTarget {
  topic: string;
  handle: string;
  version: number;
  body: string;
  /** The highlighted span, or "" for the whole draft. */
  selection: string;
}

/** The body rides along in full: the per-turn injection carries only an
 *  excerpt, and the chat's own copy may be compacted away or belong to a
 *  different chat than the one this lands in. */
export function buildRevisionPrompt(t: RevisionTarget, instruction: string): string {
  const lines = [`[re: draft ${t.handle} v${t.version} - ${t.topic}]`, instruction.trim()];
  if (t.selection.trim()) {
    lines.push("", "Only change this part, leave the rest as it is:", quote(t.selection));
  }
  lines.push(
    "",
    `Current text of ${t.handle}:`,
    quote(t.body),
    "",
    `Write the result back with write_draft (action revise, id "${t.handle}") so it lands as a new version.`,
  );
  return lines.join("\n");
}

function quote(text: string): string {
  return text.trim().split("\n").map((l) => `> ${l}`).join("\n");
}

/** Lands on the authoring chat when it is still open, else on the chat the
 *  panel is scoped to - the body is in the prompt, so either can act on it. */
export async function sendRevision(originId: string, fallbackId: string, text: string): Promise<boolean> {
  const inst =
    state.sessions.find((s) => s.session_id === originId) ??
    state.sessions.find((s) => s.session_id === fallbackId);
  if (!inst) {
    showToast("No open chat to send this to.");
    return false;
  }
  const sessionId = inst.session_id;
  const blocks: ContentBlock[] = [{ type: "text", text }];
  const onScreen = state.renderer?.currentSessionId() === sessionId;
  await sendOrStage(
    blocks,
    async () => {
      const optimistic = { type: "user_message", content: blocks, timestamp: BigInt(Date.now()) } as ChatEvent;
      sessionEvents.pushSynthetic(sessionId, optimistic);
      await sendWithFailureRecovery(sessionId, String(inst.cwd ?? "."), blocks, optimistic);
    },
    { checkActive: onScreen },
  );
  return true;
}

export function reviseMenuHtml(scoped: boolean): string {
  const items = REVISE_PRESETS.map(
    (p) =>
      `<button type="button" class="dr-rv-item" data-revise-preset="${p.key}">` +
        `<i class="ph ${p.icon}"></i>${escapeHtml(p.label)}</button>`,
  ).join("");
  return (
    `<div class="dr-rv-menu" role="menu">` +
      `<div class="dr-rv-scope">${scoped ? "Highlighted part only" : "Whole draft"}</div>` +
      items +
      `<input type="text" class="dr-rv-input" data-revise-free placeholder="Or tell Claude..." />` +
    `</div>`
  );
}

export function presetAsk(key: string): string | undefined {
  return REVISE_PRESETS.find((p) => p.key === key)?.ask;
}

export interface ReviseMenuDeps {
  root: HTMLElement;
  bodyEl(): HTMLElement | null;
  draft(): MessageDraft;
  variant(): DraftVariant | undefined;
  sessionId: string;
  flush(): void;
}

/** Owns the Revise menu's own state (open/scope) and wiring (toggle, preset
 *  click, free-text Enter, outside-click dismiss, send) so the editor only
 *  has to construct it and forward its own click/keydown/pointerdown events.
 *  Lives next to `reviseMenuHtml`/`buildRevisionPrompt`/`sendRevision` -
 *  the rest of this one feature - instead of inside drafts-editor.ts. */
export class ReviseMenuController {
  private deps: ReviseMenuDeps;
  private open = false;
  /** The body selection at the moment Revise was pressed; opening the menu
   *  moves focus, so it cannot be read later. */
  private scope = "";

  constructor(deps: ReviseMenuDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Markup for the editor's `.dr-rv-host` div. */
  menuHtml(): string {
    return this.open ? reviseMenuHtml(!!this.scope) : "";
  }

  /** Keeps the body's selection alive through the Revise click and records
   *  it, since a focused button or menu input would collapse it. Forward the
   *  editor root's own `pointerdown` events here. */
  capturePointerDown(ev: PointerEvent): void {
    if (!(ev.target as HTMLElement).closest("[data-revise]") || this.open) return;
    ev.preventDefault();
    const sel = window.getSelection();
    const body = this.deps.bodyEl();
    const inBody = !!sel && sel.rangeCount > 0 && !!body?.contains(sel.getRangeAt(0).commonAncestorContainer);
    this.scope = inBody && !sel!.isCollapsed ? sel!.toString() : "";
  }

  /** Dispatch for a click inside the editor root. Returns true when it owned
   *  the click, so the editor's own handler can skip the rest. */
  handleClick(el: HTMLElement): boolean {
    if (el.closest("[data-revise]")) {
      this.setOpen(!this.open);
      return true;
    }
    const preset = el.closest<HTMLElement>("[data-revise-preset]");
    if (preset) {
      const ask = presetAsk(preset.dataset.revisePreset ?? "");
      if (ask) this.send(ask);
      return true;
    }
    return false;
  }

  /** Dispatch for a keydown inside the editor root. Returns true when it
   *  owned the key (Escape/Enter on the free-text input). */
  handleKeydown(ev: KeyboardEvent): boolean {
    const input = (ev.target as HTMLElement).closest<HTMLInputElement>("[data-revise-free]");
    if (!input) return false;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      this.setOpen(false);
    } else if (ev.key === "Enter" && input.value.trim()) {
      ev.preventDefault();
      this.send(input.value);
    }
    return true;
  }

  destroy(): void {
    document.removeEventListener("pointerdown", this.onOutside, true);
  }

  private onOutside = (ev: PointerEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest(".dr-rv-menu") || el.closest("[data-revise]")) return;
    this.setOpen(false);
  };

  private setOpen(open: boolean): void {
    this.open = open;
    if (!open) this.scope = "";
    const host = this.deps.root.querySelector(".dr-rv-host");
    if (host) host.innerHTML = this.menuHtml();
    this.deps.root.querySelector("[data-revise]")?.classList.toggle("open", open);
    if (open) document.addEventListener("pointerdown", this.onOutside, true);
    else document.removeEventListener("pointerdown", this.onOutside, true);
  }

  /** Saves the open edit first so the chat revises what is on screen, not
   *  the last autosave. */
  private send(instruction: string): void {
    const body = this.deps.bodyEl();
    const variant = this.deps.variant();
    if (!body || !variant) return;
    this.deps.flush();
    const draft = this.deps.draft();
    const text = buildRevisionPrompt(
      {
        topic: draft.topic,
        handle: handleOf(variant),
        version: currentVersion(variant)?.n ?? 1,
        body: htmlToMarkdown(body),
        selection: this.scope,
      },
      instruction,
    );
    this.setOpen(false);
    void sendRevision(draft.origin_session_id, this.deps.sessionId, text).then((sent) => {
      if (!sent) return;
      const icon = this.deps.root.querySelector("[data-revise] i");
      if (!icon) return;
      icon.className = "ph ph-check";
      setTimeout(() => {
        const back = this.deps.root.querySelector("[data-revise] i");
        if (back) back.className = "ph ph-magic-wand";
      }, 1500);
    });
  }
}
