// "Drafts" FAB-card body (todo 666): the project's draft messages, grouped by
// what they need. Mount signature matches mountTodosPanel so the card can hold
// either. This module owns the list; drafts-editor.ts owns one open card.

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import { escapeHtml } from "../../shared/escape-html";
import { DraftsEditor, handleOf, currentVersion } from "./drafts-editor";
import type { MessageDraft } from "../../types/ipc.generated";
import "./drafts-panel.css";

export interface DraftsPanelHandle {
  setSessionScope(sessionId: string | null): void;
  refresh(): void;
  destroy(): void;
}

interface DraftsView {
  drafts: MessageDraft[];
}

const GROUPS = [
  { key: "needs-you", label: "Needs you", empty: "Nothing waiting on you." },
  { key: "ready", label: "Ready", empty: "" },
  { key: "copied", label: "Copied", empty: "" },
] as const;

/** First ~140 chars of the shown version, markers stripped, as one line.
 *  Block markers only match at line start, so a hyphenated word or an ISO date
 *  inside the text survives instead of being fused into one number. */
export function excerptOf(body: string): string {
  const flat = body
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}...` : flat;
}

function excerpt(draft: MessageDraft): string {
  const variant = draft.variants[0];
  return excerptOf(variant ? (currentVersion(variant)?.body ?? "") : "");
}

class DraftsPanel implements DraftsPanelHandle {
  private root: HTMLElement;
  private drafts: MessageDraft[] = [];
  private sessionId: string | null = null;
  private openId: string | null = null;
  private editor: DraftsEditor | null = null;
  private unlisten: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add("drafts-panel");
    this.root.addEventListener("click", this.onClick);
    void this.subscribeLive();
    this.focusHandler = () => this.refresh();
    window.addEventListener("focus", this.focusHandler);
    this.render();
  }

  setSessionScope(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.disposeEditor();
    this.sessionId = sessionId;
    this.drafts = [];
    this.openId = null;
    this.render();
    this.refresh();
  }

  refresh(): void {
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<DraftsView>("list_message_drafts", { sessionId: sid })
      .then((view) => {
        // A scope change mid-flight must not paint the previous project's cards.
        if (this.sessionId !== sid) return;
        this.drafts = Array.isArray(view?.drafts) ? view.drafts : [];
        this.render();
      })
      .catch((err) => console.error("[drafts-panel] list_message_drafts failed", err));
  }

  destroy(): void {
    this.disposeEditor();
    this.root.removeEventListener("click", this.onClick);
    if (this.unlisten) {
      try { this.unlisten(); } catch { /* ignore */ }
      this.unlisten = null;
    }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
  }

  private async subscribeLive(): Promise<void> {
    try {
      this.unlisten = await getTransport().listen<{ project_id?: string }>(
        "message_drafts_changed",
        () => this.refresh(),
      );
    } catch (err) {
      console.warn("[drafts-panel] listen(message_drafts_changed) failed", err);
    }
  }

  private disposeEditor(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private render(): void {
    const open = this.drafts.find((d) => d.id === this.openId);
    if (this.openId && !open) {
      // Deleted underneath us, or a scope change: fall back to the list rather
      // than leaving a detached editor pointing at nothing.
      this.openId = null;
    }
    if (open && this.sessionId) {
      if (this.editor) {
        this.editor.update(open);
        return;
      }
      this.root.innerHTML = "";
      this.editor = new DraftsEditor(this.root, open, {
        sessionId: this.sessionId,
        onBack: () => this.close(),
        onChanged: () => this.refresh(),
      });
      return;
    }
    this.disposeEditor();
    this.root.innerHTML = this.listHtml();
  }

  private close(): void {
    this.disposeEditor();
    this.openId = null;
    this.render();
  }

  private listHtml(): string {
    if (this.drafts.length === 0) {
      return (
        `<div class="dr-empty">` +
          `<i class="ph ph-note-pencil"></i>` +
          `<p>No drafts yet.</p>` +
          `<p class="dr-empty-hint">Ask for a message to someone and it lands here, editable, instead of in the transcript.</p>` +
        `</div>`
      );
    }
    return GROUPS.map((g) => {
      const rows = this.drafts.filter((d) => d.state === g.key);
      if (rows.length === 0) return g.empty ? `<div class="dr-group">${g.label}</div><p class="dr-none">${g.empty}</p>` : "";
      return `<div class="dr-group">${g.label}</div>` + rows.map((d) => this.cardHtml(d)).join("");
    }).join("");
  }

  private cardHtml(d: MessageDraft): string {
    const handles = d.variants.map((v) => `<span class="dr-handle">${escapeHtml(handleOf(v))}</span>`).join("");
    const version = d.variants[0] ? currentVersion(d.variants[0]) : undefined;
    const edited = version?.author === "user";
    const scope = d.origin_session_id === this.sessionId ? "" : `<span class="dr-dot">&middot;</span>${escapeHtml(d.origin_label)}`;
    return (
      `<button type="button" class="dr-card${d.state === "needs-you" ? " attn" : ""}" data-open="${escapeHtml(d.id)}">` +
        `<span class="dr-card-top">` +
          `<span class="dr-topic">${escapeHtml(d.topic)}</span>` +
          `<span class="dr-ver">v${version?.n ?? 1}</span>` +
        `</span>` +
        `<span class="dr-excerpt">${escapeHtml(excerpt(d))}</span>` +
        `<span class="dr-meta-row">${handles}${edited ? `<span class="dr-edited">your edit</span>` : ""}${scope}</span>` +
      `</button>`
    );
  }

  private onClick = (ev: MouseEvent): void => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>("[data-open]");
    if (!card) return;
    this.openId = card.dataset.open ?? null;
    this.render();
  };
}

export function mountDraftsPanel(root: HTMLElement): DraftsPanelHandle {
  return new DraftsPanel(root);
}
