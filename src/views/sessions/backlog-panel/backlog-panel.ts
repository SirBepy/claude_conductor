// The "Backlog" panel: the project's AI todos (.claude/todos/), grouped by
// PLAN.md's headings. Reader on the left next to the chat, list on the right.
// Reads work everywhere (phone and a peer's chat too); every write (reorder,
// move, archive, start a chat) is desktop-only and only for a chat this
// daemon hosts, because they edit files on this machine's disk.
//
// Rules live in backlog-model.ts, markup in backlog-render.ts, pointer drag
// in backlog-drag.ts; this module owns state, fetching and events.

import { invoke } from "../../../shared/ipc";
import { isRemote } from "../../../shared/transport";
import { openFileInApp } from "../../../shared/open-file";
import { escapeHtml } from "../../../shared/escape-html";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { markdownForDisplay } from "../../../shared/chat/file-surface";
import type { AiBacklog, AiTodoArchived, AiTodoDoc } from "../../../types/ipc.generated";
import { state } from "../state";
import { isMirrored } from "../sessions-helpers";
import {
  applyGroupOrder, applyMove, buildListGroups, canAct, isEmptyBacklog, isNoopMove, moveForDrop, reorderedGroups,
  type DropSpot, type PlanMove,
} from "./backlog-model";
import { listHtml, readerHtml } from "./backlog-render";
import { attachBacklogDrag } from "./backlog-drag";
import "./backlog-panel.css";

export interface BacklogPanelHandle {
  setSessionScope(sessionId: string | null, cwd: string | null): void;
  refresh(): void;
  destroy(): void;
}

/** How long the archive toast keeps its Undo. */
const UNDO_MS = 6000;
const ERROR_MS = 7000;

const renderMd = (md: string): string => renderMarkdown(markdownForDisplay(md));

class BacklogPanel implements BacklogPanelHandle {
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private backlog: AiBacklog | null = null;
  private docs = new Map<string, AiTodoDoc>();
  /** The row each project had open, for as long as this panel lives. In memory
   *  on purpose: nothing about it is worth surviving a restart. */
  private selectedByCwd = new Map<string, string>();
  /** Narrow layout only: whether the list or the reader fills the panel. */
  private view: "list" | "reader" = "list";
  private busy = false;
  private archiveOpen = false;
  /** What Undo hands back to ai_todo_unarchive; kept only while the toast shows. */
  private undoRecord: AiTodoArchived | null = null;
  /** Last list markup written, so an unchanged refetch leaves the DOM (and the
   *  user's scroll and hover) alone. */
  private lastList = "";
  private lastDoc = new Map<string, string>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Identifies the current scope (and ends at destroy), so a slow reply for a
   *  chat the user already left cannot paint over the current one. */
  private epoch = 0;
  /** A refetch that landed mid-drag and was dropped; replayed when the drag
   *  ends, so a cancelled drag does not leave the list stale. */
  private refetchDropped = false;
  private readonly panel: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly readerEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private disposeDrag: () => void;
  private focusHandler = (): void => this.refresh();
  private resizeObs: ResizeObserver | null = null;
  private wasVisible = false;

  constructor(private readonly root: HTMLElement, private readonly onCount?: (n: number) => void) {
    root.classList.add("bl-root");
    root.innerHTML =
      `<div class="bl-panel" data-view="list"${isRemote() ? " data-phone" : ""}>` +
      `<div class="bl-reader-col">` +
      `<div class="bl-backbar"><button type="button" class="bl-back" data-bl-act="back"><i class="ph ph-arrow-left"></i>Backlog</button></div>` +
      `<div class="bl-reader"></div>` +
      `<div class="bl-error" role="status" hidden></div>` +
      `<div class="bl-toast" role="status" hidden></div>` +
      `</div>` +
      `<div class="bl-list-col"><div class="bl-list"></div><p class="bl-empty" hidden>No todos</p></div>` +
      `</div>`;
    this.panel = root.querySelector<HTMLElement>(".bl-panel")!;
    this.listEl = root.querySelector<HTMLElement>(".bl-list")!;
    this.readerEl = root.querySelector<HTMLElement>(".bl-reader")!;
    this.toastEl = root.querySelector<HTMLElement>(".bl-toast")!;
    this.errorEl = root.querySelector<HTMLElement>(".bl-error")!;
    this.emptyEl = root.querySelector<HTMLElement>(".bl-empty")!;
    root.addEventListener("click", this.onClick);
    root.addEventListener("change", this.onChange);
    this.disposeDrag = attachBacklogDrag({
      list: this.listEl,
      enabled: () => this.canAct() && !this.busy,
      onRowDrop: (id, spot) => void this.dropRow(id, spot),
      onGroupDrop: (name, before) => void this.dropGroup(name, before),
      // After a drop the write's own refresh covers it, and a refetch racing the
      // write would repaint the pre-write list over the optimistic one.
      onEnd: () => { if (this.refetchDropped && !this.busy) this.refresh(); },
    });
    window.addEventListener("focus", this.focusHandler);
    // Hidden panels have no size; the 0 -> visible edge is the panel being
    // opened, the moment its list may have gone stale (an AI wrote a todo).
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => {
        const visible = root.clientWidth > 0;
        if (visible && !this.wasVisible) this.refresh();
        this.wasVisible = visible;
      });
      this.resizeObs.observe(root);
    }
    this.render();
  }

  // ── Scope & data ─────────────────────────────────────────────────────────

  setSessionScope(sessionId: string | null, cwd: string | null): void {
    if (sessionId === this.sessionId && cwd === this.cwd) return;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.epoch++;
    this.refetchDropped = false;
    this.backlog = null;
    this.docs.clear();
    this.lastDoc.clear();
    this.lastList = "";
    this.view = "list";
    this.archiveOpen = false;
    this.hideToast();
    this.hideError();
    this.onCount?.(0);
    this.render();
    this.refresh();
  }

  /** `mirroredSessionId` mirrors the statusbar chip's rule: only a chat hosted
   *  on a paired machine sends its session id, because the daemon forwards the
   *  read to that machine by it and `cwd` is a path on that machine's disk. */
  private scopeArgs(): Record<string, string> | null {
    if (!this.cwd) return null;
    return this.isMirroredNow() && this.sessionId ? { cwd: this.cwd, sessionId: this.sessionId } : { cwd: this.cwd };
  }

  private isMirroredNow(): boolean {
    if (!this.sessionId) return false;
    return isMirrored(state.sessions.find((s) => s.session_id === this.sessionId));
  }

  private canAct(): boolean {
    return canAct({ remote: isRemote(), mirrored: this.isMirroredNow() });
  }

  refresh(): void {
    const args = this.scopeArgs();
    if (!args) return;
    const epoch = this.epoch;
    void invoke<AiBacklog>("list_ai_backlog", args)
      .then((b) => {
        if (epoch !== this.epoch) return;
        // Mid-drag the list DOM is the user's hand; the drag's end replays this.
        if (this.listEl.classList.contains("is-reordering")) {
          this.refetchDropped = true;
          return;
        }
        this.refetchDropped = false;
        this.backlog = b && Array.isArray(b.todos) ? { groups: Array.isArray(b.groups) ? b.groups : [], todos: b.todos } : { groups: [], todos: [] };
        this.onCount?.(this.backlog.todos.length);
        this.ensureSelection();
        this.renderList();
        this.loadDoc();
      })
      .catch((err) => {
        // Not worth a banner: the eager mount also fetches for a chat with no
        // todos folder, and the list simply stays as it was.
        console.warn("[backlog-panel] list_ai_backlog failed", err);
      });
  }

  private selectedId(): string | null {
    return this.cwd ? this.selectedByCwd.get(this.cwd) ?? null : null;
  }

  private select(id: string | null): void {
    if (!this.cwd) return;
    if (id) this.selectedByCwd.set(this.cwd, id);
    else this.selectedByCwd.delete(this.cwd);
  }

  /** Keeps the remembered row while it still exists, else the first one shown. */
  private ensureSelection(): void {
    if (!this.backlog) return;
    const cur = this.selectedId();
    if (cur && this.backlog.todos.some((t) => t.id === cur)) return;
    const first = buildListGroups(this.backlog).flatMap((g) => g.items)[0];
    this.select(first?.id ?? null);
  }

  /** Fetches the open todo's document. The cached copy paints first so a
   *  refetch after an action does not blank the reader. */
  private loadDoc(): void {
    const id = this.selectedId();
    const args = this.scopeArgs();
    if (!id || !args) return;
    const epoch = this.epoch;
    void invoke<AiTodoDoc>("read_ai_todo", { ...args, id })
      .then((doc) => {
        if (epoch !== this.epoch || !doc) return;
        this.docs.set(id, doc);
        // Unchanged text keeps the reader's DOM, so a focus refetch does not
        // fold the sections the user just opened.
        const sig = JSON.stringify(doc);
        if (this.lastDoc.get(id) === sig && this.readerEl.firstElementChild) return;
        this.lastDoc.set(id, sig);
        if (this.selectedId() === id) this.renderReader();
      })
      .catch((err) => {
        console.warn("[backlog-panel] read_ai_todo failed", err);
        if (epoch !== this.epoch || this.selectedId() !== id || this.docs.has(id)) return;
        this.readerEl.innerHTML = `<p class="bl-quiet">This todo could not be read.</p>`;
      });
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private render(): void {
    this.renderList();
    this.renderReader();
  }

  private renderList(): void {
    const b = this.backlog;
    const none = !b || isEmptyBacklog(b);
    const loading = b === null && !!this.cwd;
    const empty = none && !loading;
    this.panel.toggleAttribute("data-empty", empty);
    // The last todo archived while its reader was open leaves nothing to read.
    if (empty) this.view = "list";
    this.panel.dataset.view = this.view;
    this.emptyEl.hidden = !empty;
    this.listEl.hidden = none;
    const html = b && !none ? listHtml(buildListGroups(b), { selectedId: this.selectedId(), draggable: this.canAct() }) : "";
    if (html !== this.lastList) {
      this.lastList = html;
      this.listEl.innerHTML = html;
    }
  }

  private renderReader(): void {
    const id = this.selectedId();
    const doc = id ? this.docs.get(id) : undefined;
    if (!doc) {
      this.readerEl.innerHTML = "";
      return;
    }
    // The textarea and its draft survive a re-render only if nothing re-renders
    // them, so an open Archive form blocks the repaint (the select/footer are
    // the same for an unchanged todo anyway).
    const keep = this.archiveOpen ? (this.readerEl.querySelector<HTMLTextAreaElement>(".bl-note")?.value ?? "") : "";
    this.readerEl.innerHTML = readerHtml(doc, {
      md: renderMd,
      actions: this.canAct(),
      groups: this.backlog?.groups ?? [],
    });
    if (this.archiveOpen) {
      const box = this.readerEl.querySelector<HTMLElement>("[data-bl-archive]");
      const ta = box?.querySelector<HTMLTextAreaElement>(".bl-note");
      if (box && ta) {
        box.hidden = false;
        ta.value = keep;
      }
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private onClick = (ev: MouseEvent): void => {
    const t = ev.target as HTMLElement;
    // A relative link in a todo's markdown would load inside the webview.
    const a = t.closest<HTMLAnchorElement>(".bl-md a[href]");
    if (a) {
      if (!/^(https?:|mailto:|file:)/i.test(a.getAttribute("href") ?? "")) ev.preventDefault();
      return;
    }
    const row = t.closest<HTMLElement>(".bl-row");
    if (row?.dataset.blId) {
      this.select(row.dataset.blId);
      this.view = "reader";
      this.archiveOpen = false;
      this.hideError();
      this.render();
      this.loadDoc();
      return;
    }
    const act = t.closest<HTMLElement>("[data-bl-act]")?.dataset.blAct;
    if (!act || act === "move") return;
    if (act === "back") {
      this.view = "list";
      this.render();
    } else if (act === "start") void this.startChat();
    else if (act === "archive") this.openArchive();
    else if (act === "archive-cancel") this.closeArchive();
    else if (act === "archive-go") void this.archive();
    else if (act === "source") {
      const id = this.selectedId();
      const doc = id ? this.docs.get(id) : undefined;
      if (doc) openFileInApp(doc.entry.path);
    } else if (act === "undo") void this.undo();
  };

  private onChange = (ev: Event): void => {
    const sel = ev.target as HTMLSelectElement;
    if (sel.dataset.blAct !== "move") return;
    const id = this.selectedId();
    if (!id || !this.backlog) return;
    const group = sel.value === "" ? null : sel.value;
    void this.commitMove(moveForDrop(buildListGroups(this.backlog), id, { group, beforeId: null }));
  };

  // ── Writes (desktop, local chats only) ───────────────────────────────────

  private async dropRow(id: string, spot: DropSpot): Promise<void> {
    if (!this.backlog) return;
    await this.commitMove(moveForDrop(buildListGroups(this.backlog), id, spot));
  }

  private async dropGroup(name: string, before: string | null): Promise<void> {
    const args = this.scopeArgs();
    const prev = this.backlog;
    if (!args || !prev) return;
    // The headings the list actually shows: todos can name a group PLAN.md
    // lacks, and the drop's `before` may be one of those.
    const shown = buildListGroups(prev).flatMap((g) => (g.name == null ? [] : [g.name]));
    const next = reorderedGroups(shown, name, before);
    if (next.join("\n") === shown.join("\n")) return;
    await this.write(
      () => { this.backlog = applyGroupOrder(prev, next); this.renderList(); },
      () => invoke<void>("ai_todo_plan_reorder_groups", { cwd: args.cwd, groups: next }),
      "reorder the groups",
    );
  }

  private async commitMove(move: PlanMove): Promise<void> {
    const args = this.scopeArgs();
    const prev = this.backlog;
    if (!args || !prev || isNoopMove(buildListGroups(prev), move)) return;
    await this.write(
      () => { this.backlog = applyMove(prev, move); this.renderList(); },
      () => invoke<void>("ai_todo_plan_move", { cwd: args.cwd, id: move.id, group: move.group, index: move.index }),
      "move it",
    );
  }

  /** Optimistic write: repaint first, call the command, then re-fetch for the
   *  truth; on failure put the old list back and say so quietly. */
  private async write(optimistic: () => void, call: () => Promise<unknown>, what: string): Promise<void> {
    const prev = this.backlog;
    const epoch = this.epoch;
    this.busy = true;
    optimistic();
    try {
      await call();
    } catch (err) {
      if (epoch === this.epoch) {
        this.backlog = prev;
        this.renderList();
        this.showError(`Could not ${what}: ${errText(err)}`);
      }
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async startChat(): Promise<void> {
    const id = this.selectedId();
    const args = this.scopeArgs();
    const btn = this.readerEl.querySelector<HTMLButtonElement>('[data-bl-act="start"]');
    if (!id || !args || this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    if (btn) btn.disabled = true;
    try {
      const sessionId = await invoke<string>("ai_todo_start_chat", { cwd: args.cwd, id });
      // The user moved to another chat meanwhile: opening this one would yank
      // them off what they are now looking at. The new chat still shows up in
      // the sidebar through the normal instances refresh.
      if (epoch !== this.epoch) return;
      // The new chat is not in the sessions list until the registry is re-read,
      // and selectSession refuses an id it does not know.
      const { refreshSessions } = await import("../sidebar");
      await refreshSessions();
      if (epoch !== this.epoch) return;
      const { openChatById } = await import("../session-controls");
      openChatById(sessionId);
    } catch (err) {
      if (epoch === this.epoch) this.showError(`Could not start a chat: ${errText(err)}`);
    } finally {
      this.busy = false;
      if (btn) btn.disabled = false;
      this.refresh();
    }
  }

  private openArchive(): void {
    const box = this.readerEl.querySelector<HTMLElement>("[data-bl-archive]");
    if (!box) return;
    this.archiveOpen = true;
    box.hidden = false;
    box.querySelector<HTMLTextAreaElement>(".bl-note")?.focus();
  }

  private closeArchive(): void {
    this.archiveOpen = false;
    const box = this.readerEl.querySelector<HTMLElement>("[data-bl-archive]");
    if (box) box.hidden = true;
  }

  private async archive(): Promise<void> {
    const id = this.selectedId();
    const args = this.scopeArgs();
    const prev = this.backlog;
    if (!id || !args || !prev || this.busy) return;
    const note = this.readerEl.querySelector<HTMLTextAreaElement>(".bl-note")?.value.trim() ?? "";
    const epoch = this.epoch;
    this.busy = true;
    try {
      const archived = await invoke<AiTodoArchived>("ai_todo_archive", { cwd: args.cwd, id, note: note || null });
      // The chat changed while the backend worked: `prev` and `id` belong to
      // the old project, and a toast here would offer an Undo that the new
      // scope's cwd makes the backend refuse. The finally refresh repaints.
      if (epoch !== this.epoch) return;
      this.archiveOpen = false;
      this.undoRecord = archived;
      // Next row takes over so the reader is never left on a file that moved.
      const order = buildListGroups(prev).flatMap((g) => g.items);
      const at = order.findIndex((t) => t.id === id);
      const next = order[at + 1] ?? order[at - 1];
      this.backlog = { groups: prev.groups, todos: prev.todos.filter((t) => t.id !== id) };
      this.docs.delete(id);
      this.select(next?.id ?? null);
      this.onCount?.(this.backlog.todos.length);
      this.render();
      this.loadDoc();
      this.showToast(archived.id);
    } catch (err) {
      if (epoch === this.epoch) this.showError(`Could not archive: ${errText(err)}`);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async undo(): Promise<void> {
    const rec = this.undoRecord;
    const args = this.scopeArgs();
    if (!rec || !args) return;
    const epoch = this.epoch;
    this.undoRecord = null;
    this.hideToast();
    try {
      await invoke<void>("ai_todo_unarchive", { cwd: args.cwd, archived: rec });
      // After a chat switch `select` and `scopeArgs` would act on the new
      // project; the restore already ran against the cwd captured above.
      if (epoch !== this.epoch) return;
      this.select(rec.id);
    } catch (err) {
      if (epoch === this.epoch) this.showError(`Could not undo: ${errText(err)}`);
    }
    if (epoch === this.epoch) this.refresh();
  }

  // ── Toast & error ────────────────────────────────────────────────────────

  private showToast(id: string): void {
    this.hideToast(false);
    this.toastEl.innerHTML = `<i class="ph ph-check-circle"></i><span>Archived ${escapeHtml(id)}</span><button type="button" class="bl-toast-undo" data-bl-act="undo">Undo</button>`;
    this.toastEl.hidden = false;
    this.toastTimer = setTimeout(() => this.hideToast(), UNDO_MS);
  }

  private hideToast(forgetUndo = true): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toastEl.hidden = true;
    if (forgetUndo) this.undoRecord = null;
  }

  private showError(msg: string): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorEl.textContent = msg;
    this.errorEl.hidden = false;
    this.errorTimer = setTimeout(() => this.hideError(), ERROR_MS);
  }

  private hideError(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = null;
    this.errorEl.hidden = true;
  }

  destroy(): void {
    this.epoch++;
    this.disposeDrag();
    this.resizeObs?.disconnect();
    window.removeEventListener("focus", this.focusHandler);
    this.root.removeEventListener("click", this.onClick);
    this.root.removeEventListener("change", this.onChange);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.errorTimer) clearTimeout(this.errorTimer);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `onCount` is the open-todo count the split's strip shows quietly on the tab. */
export function mountBacklogPanel(root: HTMLElement, onCount?: (n: number) => void): BacklogPanelHandle {
  return new BacklogPanel(root, onCount);
}
