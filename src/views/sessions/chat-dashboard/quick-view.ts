// The read view behind the dashboard's quick-view buttons (Bigger plan,
// Decided, Project memory). v1 is deliberately plain: a dialog that shows the
// files the daemon found (chat_quick_view, daemon/methods/quick_views.rs) as
// markdown, with a file list when there are several. Joe will make it richer
// later (docs/chat-dashboard-design.md), so nothing here is editable.

import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import type { QuickViewId } from "./dashboard-zones";

export interface QuickViewDoc {
  name: string;
  body: string;
}

export interface QuickViewData {
  view: QuickViewId;
  title: string;
  docs: QuickViewDoc[];
  /** Why there is nothing to read, in words Joe can read as-is. */
  message: string;
}

export async function fetchQuickView(sessionId: string, view: QuickViewId): Promise<QuickViewData> {
  const raw = await invoke<Partial<QuickViewData> | null>("chat_quick_view", { sessionId, view });
  return {
    view,
    title: raw?.title ?? view,
    docs: Array.isArray(raw?.docs) ? raw!.docs!.filter((d) => typeof d?.name === "string" && typeof d.body === "string") : [],
    message: raw?.message ?? "",
  };
}

const HOST_CLASS = "cdash-qvm";

/** Closes the open read view, if any. */
export function closeQuickView(): void {
  document.querySelector(`.${HOST_CLASS}`)?.dispatchEvent(new CustomEvent("cdash-qvm-close"));
}

/** Opens the read view for `data`. One at a time: a second open replaces the first. */
export function openQuickView(data: QuickViewData): void {
  closeQuickView();
  const host = document.createElement("div");
  host.className = HOST_CLASS;
  host.dataset.view = data.view;
  const multi = data.docs.length > 1;
  host.innerHTML = `<div class="cdash-qvm-backdrop" data-close></div>`
    + `<div class="cdash-qvm-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(data.title)}">`
    + `<div class="cdash-qvm-head"><span class="cdash-qvm-title">${escapeHtml(data.title)}</span>`
    + `<button type="button" class="cdash-qvm-x" data-close title="Close" aria-label="Close"><i class="ph ph-x"></i></button></div>`
    + `<div class="cdash-qvm-main${multi ? " has-list" : ""}">`
    + (multi ? `<nav class="cdash-qvm-list" aria-label="Files">${data.docs.map((d, i) => `<button type="button" class="cdash-qvm-file" data-i="${i}">${escapeHtml(d.name)}</button>`).join("")}</nav>` : "")
    + `<div class="cdash-qvm-body"></div></div></div>`;
  const body = host.querySelector<HTMLElement>(".cdash-qvm-body")!;
  const show = (i: number): void => {
    const doc = data.docs[i];
    body.scrollTop = 0;
    if (!doc) {
      body.innerHTML = `<p class="cdash-qvm-none">${escapeHtml(data.message || "Nothing to show.")}</p>`;
      return;
    }
    body.innerHTML = `<div class="cdash-qvm-doc" data-name="${escapeHtml(doc.name)}">${renderMarkdown(doc.body)}</div>`;
    host.querySelectorAll<HTMLElement>(".cdash-qvm-file").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
  };
  show(0);

  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    host.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  host.addEventListener("cdash-qvm-close", close);
  host.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-close]")) close();
    const file = t.closest<HTMLElement>(".cdash-qvm-file");
    if (file) show(Number(file.dataset.i));
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(host);
  host.querySelector<HTMLElement>(".cdash-qvm-x")?.focus();
}
