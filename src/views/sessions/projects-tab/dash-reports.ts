// Reports card: finished-chat outcomes, a gallery of images from past chats,
// and files chats produced. All three come from dashboard_history, which
// arrives after the snapshot, so the card shows a quiet loading line first.
// The card fills whatever height the pane has left: short, it is a compact peek
// (the rows that fit, four thumbnails); tall, outcomes become tiles and the
// gallery grows to 3 x 2 (pd-cards.css). "See more" opens the full tab in a modal.
import { html, nothing, render, type TemplateResult } from "lit-html";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../shared/modal";
import { agoLabel, fileIcon, fileName, firstSentence, plainPreview, shortAgo, type ReportsTab } from "./format";
import type { ActionHost } from "./dash-actions";
import type { OutcomeRow } from "./types";
import { card, hidden, icon, inRepo, quiet, repoTag, row, type DashCtx } from "./dash-parts";

const CARD_THUMBS = 6;

const TABS: Array<{ id: ReportsTab, label: string }> = [
  { id: "outcomes", label: "Outcomes" },
  { id: "gallery", label: "Gallery" },
  { id: "files", label: "Files" },
];

const outcomesIn = (c: DashCtx): OutcomeRow[] => (c.history?.outcomes ?? []).filter((o) => inRepo(c, o.repo_cwd));

const tile = (c: DashCtx, o: OutcomeRow): TemplateResult => html`
  <div class="pd-out" @click=${() => c.act.openHistory(o.session_id)}>
    <b>${o.title}</b><p>${plainPreview(o.text)}</p>
    <div class="when">${repoTag(c, o.repo_cwd)}${agoLabel(o.at_ms, c.nowMs)}</div>
  </div>`;

function outcomesFull(c: DashCtx): TemplateResult {
  const items = outcomesIn(c);
  if (!items.length) return quiet("No finished chats yet");
  return html`<div class="pd-outs">${items.map((o) => tile(c, o))}</div>`;
}

/** Both shapes are rendered; the card body's height picks which one shows. */
function outcomesCard(c: DashCtx): TemplateResult {
  const items = outcomesIn(c);
  if (!items.length) return quiet("No finished chats yet");
  return html`<div class="pd-fit has-tiles">${items.map((o) => row(icon("check-circle"),
    html`<b>${o.title}</b> <span class="pd-muted">${firstSentence(o.text)}</span>`,
    { tag: repoTag(c, o.repo_cwd), title: plainPreview(o.text), onClick: () => c.act.openHistory(o.session_id) }))}</div>
    <div class="pd-outs pd-tiles">${items.map((o) => tile(c, o))}</div>`;
}

function galleryCompact(c: DashCtx): TemplateResult {
  const items = (c.history?.gallery ?? []).filter((g) => inRepo(c, g.repo_cwd)).slice(0, CARD_THUMBS);
  if (!items.length) return quiet("No images from past chats");
  return html`<div class="pd-gal compact">${items.map((g) => shot(c, g.id, g.title, false))}</div>`;
}

/** One thumbnail. The caption only shows in the full view; the compact row keeps it as a tooltip. */
function shot(c: DashCtx, id: string, title: string, caption: boolean): TemplateResult {
  const src = c.images.get(id);
  const ok = !!src && src !== "failed";
  return html`<div class="pd-shot" title=${title} @click=${() => ok && c.act.openImage(id)}>
    ${ok ? html`<img src=${src} alt=${title}>`
      : html`<div class="pd-shot-ph">${src === "failed" ? "Image unavailable" : html`<i class="ph ph-spinner"></i>`}</div>`}
    ${caption ? html`<div class="pd-shot-t">${title}</div>` : nothing}
  </div>`;
}

function galleryFull(c: DashCtx): TemplateResult {
  const items = (c.history?.gallery ?? []).filter((g) => inRepo(c, g.repo_cwd));
  if (!items.length) return quiet("No images from past chats");
  return html`<div class="pd-gal">${items.map((g) => shot(c, g.id, g.title, true))}</div>`;
}

function fileRows(c: DashCtx): TemplateResult[] {
  const items = (c.history?.files ?? []).filter((f) => inRepo(c, f.repo_cwd));
  return items.map((f) => row(icon(fileIcon(f.path)), fileName(f.path), {
    dim: !f.exists, tag: repoTag(c, f.repo_cwd),
    meta: `${f.chat_title} · ${shortAgo(f.at_ms, c.nowMs)}`,
    title: f.exists ? f.path : `${f.path} (no longer on disk)`,
    onClick: f.exists ? () => c.act.openFile(f.path) : undefined,
  }));
}

function filesFull(c: DashCtx): TemplateResult | TemplateResult[] {
  const rows = fileRows(c);
  return rows.length ? rows : quiet("No files from past chats");
}

function filesCard(c: DashCtx): TemplateResult {
  const rows = fileRows(c);
  return rows.length ? html`<div class="pd-fit">${rows}</div>` : quiet("No files from past chats");
}

const tabsFor = (c: DashCtx): TemplateResult => html`<div class="pd-rtabs">${TABS.map((t) => html`
  <button type="button" class="pd-rtab ${c.tab === t.id ? "on" : ""}" @click=${() => c.act.setTab(t.id)}>${t.label}</button>`)}</div>`;

export function reports(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "reports")) return nothing;
  let body: TemplateResult;
  if (!c.history) body = quiet("Loading...");
  else if (c.tab === "outcomes") body = outcomesCard(c);
  else if (c.tab === "gallery") body = galleryCompact(c);
  else body = filesCard(c);
  const more = c.history ? html`<a class="pd-link" data-pd-see-more @click=${() => c.act.openReportsModal()}>See more</a>` : nothing;
  return card("Reports", html`<div class="pd-rbody">${body}</div>`,
    { id: "reports", full: true, cls: "pd-reports", trailing: html`${tabsFor(c)}${more}` });
}

/** The current tab at full size, in the shared modal host. Redraws on every dashboard paint so gallery images appear as they load. */
export function openReportsModal(host: ActionHost): void {
  const slot = modalCardSlot();
  const c = host.ctx();
  const hook = (): void => draw();
  const close = (): void => { c.paintHooks.delete(hook); setBackdropCancel(null); closeHostCard(); };

  function draw(): void {
    const label = TABS.find((t) => t.id === c.tab)?.label ?? "";
    const body = c.tab === "outcomes" ? outcomesFull(c) : c.tab === "gallery" ? galleryFull(c) : filesFull(c);
    render(html`
      <div class="modal-card pd-modal wide" role="dialog" aria-modal="true" aria-label="Reports">
        <header class="modal-header"><h3>Reports · ${label}</h3></header>
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
