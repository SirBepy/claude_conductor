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

export interface LearnTarget {
  topic: string;
  handle: string;
  /** Vault person id when known, else the recipient label. */
  recipient: string;
  mine: { n: number; body: string };
  /** Claude's newest version before the edit, or null if it wrote none. */
  claudes: { n: number; body: string } | null;
}

/** "Check & learn": fact-check the user's hand edit, then save what the edit
 *  says about their style - per-recipient lessons in that person's vault
 *  note, general ones in the shared style file `write_draft` tells every
 *  chat to read. Saved without asking: the user chose that, a wrong lesson is
 *  fixed by editing the note. */
export function buildLearnPrompt(t: LearnTarget): string {
  const lines = [
    `[re: draft ${t.handle} v${t.mine.n} - ${t.topic}] Check & learn`,
    "I edited this draft by hand. Two jobs:",
    "",
    `1. Fact-check my version against what can be verified (the draft's receipts, the code, git, what I said). If anything is wrong, write a corrected version back with write_draft (action revise, id "${t.handle}") and say what you changed. If it is right, leave it.`,
    "",
    "2. Learn from my edit" + (t.claudes ? " by comparing it with your last version" : "") +
      ": work out what it says about how I like messages written, and save each lesson now, without asking:",
    `   - about ${t.recipient} only (tone, language, how they are addressed): their Obsidian vault note People/<their name>.md, under a "## Writing to them" heading. Re-read the file first and add lines; never rewrite it.`,
    "   - general, true for any message: ~/.claude/refs/message-drafting.md, one bullet per rule. Create it if it does not exist.",
    "   Skip anything that only fits this one message. Then list what you saved and where, briefly.",
  ];
  if (t.claudes) lines.push("", `Your last version (v${t.claudes.n}):`, quote(t.claudes.body));
  lines.push("", `My version (v${t.mine.n}):`, quote(t.mine.body));
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
  // No free-text box here: the editor's footer box is that box.
  return (
    `<div class="dr-rv-menu" role="menu">` +
      `<div class="dr-rv-scope">${scoped ? "Highlighted part only" : "Whole draft"}</div>` +
      items +
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

  /** Records the body's selection before a press on the presets button or
   *  the footer box moves focus and collapses it. The button also keeps the
   *  selection alive; the box has to take focus to be typed in. Forward the
   *  editor root's own `pointerdown` events here. */
  capturePointerDown(ev: PointerEvent): void {
    const target = ev.target as HTMLElement;
    const onButton = !!target.closest("[data-revise]") && !this.open;
    const onBox = !!target.closest("[data-revise-free]") && document.activeElement !== target;
    if (!onButton && !onBox) return;
    if (onButton) ev.preventDefault();
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
   *  owned the key (Escape on the free-text box; its Enter/send is wired by
   *  the shared composer field, which calls sendFree). */
  handleKeydown(ev: KeyboardEvent): boolean {
    if (!(ev.target as HTMLElement).closest("[data-revise-free]")) return false;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      this.setOpen(false);
    }
    return true;
  }

  /** Sends what was typed in the footer box. */
  sendFree(text: string): void {
    this.send(text);
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
      // The send arrow briefly turns into a check: the only sign the ask went
      // out, since the reply lands in the origin chat, not here.
      const icon = this.deps.root.querySelector(".dr-foot .composer-field-send i");
      if (!icon) return;
      icon.classList.replace("ph-paper-plane-right", "ph-check");
      setTimeout(() => icon.classList.replace("ph-check", "ph-paper-plane-right"), 1500);
    });
  }
}
