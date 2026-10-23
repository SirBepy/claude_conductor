// The "+" picker: the projects and groups that were closed from the Projects
// list, with a search box. The app's main project picker starts a chat on pick,
// which is the wrong outcome here, so this is a small list in the same modal host.
import { html, render } from "lit-html";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../shared/modal";
import { listSubline } from "./format";
import type { DashboardTargetRef, ListRow } from "./types";

export function openClosedProjectsPicker(closed: ListRow[], onPick: (ref: DashboardTargetRef) => void): void {
  const slot = modalCardSlot();
  let query = "";
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };
  const matches = (): ListRow[] => closed.filter((r) => r.target.name.toLowerCase().includes(query.trim().toLowerCase()));
  const pick = (r: ListRow): void => { close(); onPick({ kind: r.target.kind, id: r.target.id }); };

  function draw(): void {
    const found = matches();
    render(html`
      <div class="modal-card pd-modal" role="dialog" aria-modal="true" aria-label="Open a project">
        <header class="modal-header"><h3>Open a project</h3></header>
        <div class="modal-body pd-mbody">
          <input type="text" class="pd-pick-search" placeholder="Search" autocomplete="off" .value=${query}
            @input=${(e: Event) => { query = (e.target as HTMLInputElement).value; draw(); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && found[0]) pick(found[0]); }}>
          ${found.length === 0
            ? html`<div class="pd-quiet">${closed.length ? "No match" : "Every project is already open"}</div>`
            : found.map((r) => html`<div class="pd-mrow pd-pick" data-pd-pick=${`${r.target.kind}:${r.target.id}`} @click=${() => pick(r)}>
                <i class="ph ph-${r.target.kind === "group" ? "briefcase" : "folder"}"></i>
                <span class="pd-mt">${r.target.name}</span>
                <span class="pd-fetched">${listSubline(r)}</span></div>`)}
        </div>
        <footer class="modal-footer"><button type="button" class="btn btn-secondary" @click=${close}>Cancel</button></footer>
      </div>`, slot);
  }

  setBackdropCancel(close);
  void presentHostCard(() => {
    draw();
    slot.querySelector<HTMLInputElement>(".pd-pick-search")?.focus();
  });
}
