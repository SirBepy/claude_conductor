// Past results: finished-chat outcomes, a gallery of images from past chats,
// and files chats produced. All three come from dashboard_history. The page
// only carries the top bar's links to them; the full-size modal, with a tab per
// kind, is where they show.
import { html, nothing, render, type TemplateResult } from "lit-html";
import { isRemote } from "../../../shared/transport";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../shared/modal";
import { agoLabel, fileIcon, fileName, plainPreview, shortAgo, type ReportsTab } from "./format";
import type { ActionHost } from "./dash-actions";
import type { OutcomeRow } from "./types";
import { hidden, icon, quiet, repoTag, row, type DashCtx } from "./dash-parts";

const TABS: Array<{ id: ReportsTab, label: string }> = [
  { id: "outcomes", label: "Outcomes" },
  { id: "gallery", label: "Gallery" },
  { id: "files", label: "Files" },
];

const tile = (c: DashCtx, o: OutcomeRow): TemplateResult => html`
  <div class="pd-out" @click=${() => c.act.openHistory(o.session_id)}>
    <b>${o.title}</b><p>${plainPreview(o.text)}</p>
    <div class="when">${repoTag(c, o.repo_cwd)}${agoLabel(o.at_ms, c.nowMs)}</div>
  </div>`;

function outcomesFull(c: DashCtx): TemplateResult {
  const items = c.history?.outcomes ?? [];
  if (!items.length) return quiet("No finished chats yet");
  return html`<div class="pd-outs">${items.map((o) => tile(c, o))}</div>`;
}

/** One thumbnail with its caption. */
function shot(c: DashCtx, id: string, title: string): TemplateResult {
  const src = c.images.get(id);
  const ok = !!src && src !== "failed";
  return html`<div class="pd-shot" title=${title} @click=${() => ok && c.act.openImage(id)}>
    ${ok ? html`<img src=${src} alt=${title}>`
      : html`<div class="pd-shot-ph">${src === "failed" ? "Image unavailable" : html`<i class="ph ph-spinner"></i>`}</div>`}
    <div class="pd-shot-t">${title}</div>
  </div>`;
}

function galleryFull(c: DashCtx): TemplateResult {
  const items = c.history?.gallery ?? [];
  if (!items.length) return quiet("No images from past chats");
  return html`<div class="pd-gal">${items.map((g) => shot(c, g.id, g.title))}</div>`;
}

function fileRows(c: DashCtx): TemplateResult[] {
  const items = c.history?.files ?? [];
  return items.map((f) => row(icon(fileIcon(f.path)), fileName(f.path), {
    dim: !f.exists, tag: repoTag(c, f.repo_cwd),
    meta: `${f.chat_title} · ${shortAgo(f.at_ms, c.nowMs)}`,
    title: f.exists ? f.path : `${f.path} (no longer on disk)`,
    ctx: { kind: "file", path: f.path, exists: f.exists },
    // Files open in VS Code on the PC, which the phone cannot reach.
    onClick: f.exists && !isRemote() ? () => c.act.openFile(f.path) : undefined,
  }));
}

function filesFull(c: DashCtx): TemplateResult | TemplateResult[] {
  const rows = fileRows(c);
  return rows.length ? rows : quiet("No files from past chats");
}

const tabsFor = (c: DashCtx): TemplateResult => html`<div class="pd-rtabs">${TABS.map((t) => html`
  <button type="button" class="pd-rtab ${c.tab === t.id ? "on" : ""}" @click=${() => c.act.setTab(t.id)}>${t.label}</button>`)}</div>`;

/** Past results stay off the page: the row along the dashboard's top edge
 *  opens any of the three in the full-size view. */
export function reportsBar(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "reports")) return nothing;
  const open = (tab: ReportsTab): void => { c.act.setTab(tab); c.act.openReportsModal(); };
  return html`<div class="pd-reports" data-pd-card="reports"><span>Past results</span>${TABS.map((t) => html`
    <button type="button" class="pd-act" data-pd-see-more=${t.id} @click=${() => open(t.id)}>${t.label}</button>`)}</div>`;
}

/** The current tab at full size, in the shared modal host. Redraws on every dashboard paint so gallery images appear as they load. */
export function openReportsModal(host: ActionHost): void {
  const slot = modalCardSlot();
  const c = host.ctx();
  const hook = (): void => draw();
  const close = (): void => { c.paintHooks.delete(hook); setBackdropCancel(null); closeHostCard(); };

  function draw(): void {
    // The footer links render before dashboard_history lands; an empty state then would be a lie.
    const body = !c.history ? quiet(c.historyFailed ? "Could not load past results" : "Loading...")
      : c.tab === "outcomes" ? outcomesFull(c) : c.tab === "gallery" ? galleryFull(c) : filesFull(c);
    render(html`
      <div class="modal-card pd-modal wide" role="dialog" aria-modal="true" aria-label="Past results">
        <header class="modal-header pd-mhead"><h3>Past results</h3>${tabsFor(c)}</header>
        <div class="modal-body pd-mbody">${body}</div>
        <footer class="modal-footer"><button type="button" class="btn btn-primary" @click=${close}>Done</button></footer>
      </div>`, slot);
  }

  c.paintHooks.add(hook);
  setBackdropCancel(close);
  void presentHostCard(draw);
}

/** Full-size view of one gallery image: a plain overlay on the app's lightbox chrome. */
export function showImageOverlay(src: string, title: string): void {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay pd-lightbox";
  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  overlay.innerHTML = `<button type="button" class="lightbox-close" aria-label="Close preview"><i class="ph ph-x"></i></button>
    <div class="lightbox-content lightbox-content--image"><img alt=""></div>`;
  const img = overlay.querySelector<HTMLImageElement>("img")!;
  img.src = src;
  img.alt = title;
  overlay.addEventListener("click", (e) => { if (e.target !== img) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}
