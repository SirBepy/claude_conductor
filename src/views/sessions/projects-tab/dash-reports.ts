// Reports card: finished-chat outcomes, a gallery of images from past chats,
// and files chats produced. All three come from dashboard_history, which
// arrives after the snapshot, so the card shows a quiet loading line first.
import { html, nothing, type TemplateResult } from "lit-html";
import { agoLabel, fileIcon, fileName, plainPreview, shortAgo, type ReportsTab } from "./format";
import { card, hidden, icon, inRepo, quiet, repoTag, row, type DashCtx } from "./dash-parts";

const TABS: Array<{ id: ReportsTab, label: string }> = [
  { id: "outcomes", label: "Outcomes" },
  { id: "gallery", label: "Gallery" },
  { id: "files", label: "Files" },
];

function outcomes(c: DashCtx): TemplateResult {
  const items = (c.history?.outcomes ?? []).filter((o) => inRepo(c, o.repo_cwd));
  if (!items.length) return quiet("No finished chats yet");
  return html`<div class="pd-outs">${items.map((o) => html`
    <div class="pd-out" @click=${() => c.act.openHistory(o.session_id)}>
      <b>${o.title}</b><p>${plainPreview(o.text)}</p>
      <div class="when">${repoTag(c, o.repo_cwd)}${agoLabel(o.at_ms, c.nowMs)}</div>
    </div>`)}</div>`;
}

function gallery(c: DashCtx): TemplateResult {
  const items = (c.history?.gallery ?? []).filter((g) => inRepo(c, g.repo_cwd));
  if (!items.length) return quiet("No images from past chats");
  return html`<div class="pd-gal">${items.map((g) => {
    const src = c.images.get(g.id);
    return html`<div class="pd-shot" @click=${() => src && src !== "failed" && c.act.openImage(g.id)}>
      ${src && src !== "failed"
        ? html`<img src=${src} alt=${g.title}>`
        : html`<div class="pd-shot-ph">${src === "failed" ? "Image unavailable" : html`<i class="ph ph-spinner"></i>`}</div>`}
      <div class="pd-shot-t">${g.title}</div>
    </div>`;
  })}</div>`;
}

function files(c: DashCtx): TemplateResult | TemplateResult[] {
  const items = (c.history?.files ?? []).filter((f) => inRepo(c, f.repo_cwd));
  if (!items.length) return quiet("No files from past chats");
  return items.map((f) => row(icon(fileIcon(f.path)), fileName(f.path), {
    dim: !f.exists, tag: repoTag(c, f.repo_cwd),
    meta: `${f.chat_title} · ${shortAgo(f.at_ms, c.nowMs)}`,
    title: f.exists ? f.path : `${f.path} (no longer on disk)`,
    onClick: f.exists ? () => c.act.openFile(f.path) : undefined,
  }));
}

export function reports(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "reports")) return nothing;
  const tabs = html`<div class="pd-rtabs">${TABS.map((t) => html`
    <button type="button" class="pd-rtab ${c.tab === t.id ? "on" : ""}" @click=${() => c.act.setTab(t.id)}>${t.label}</button>`)}</div>`;
  let body: TemplateResult | TemplateResult[];
  if (!c.history) body = quiet("Loading...");
  else if (c.tab === "outcomes") body = outcomes(c);
  else if (c.tab === "gallery") body = gallery(c);
  else body = files(c);
  return card("Reports", body, { id: "reports", full: true, trailing: tabs });
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
