// The two dashboard modals, rendered into the shared #modal-host card slot:
// "Dashboard cards" (builtin switches + custom card management) and "Edit
// repos" (a group's name and member repos).
import { html, nothing, render, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { api } from "../../../shared/api";
import { askConfirm } from "../../../shared/confirm";
import { showToast } from "../../../shared/toast";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../shared/modal";
import { fetchedLabel, scopeOf, sameCwd, BUILTIN_CARDS } from "./format";
import type { ActionHost } from "./dash-actions";
import { pinsEditor } from "./dash-pins";
import type { CardView, DashSnapshot, GroupDef } from "./types";

const toggle = (on: boolean, onChange: (next: boolean) => void): TemplateResult => html`
  <label class="switch"><input type="checkbox" .checked=${on}
    @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}><span class="slider"></span></label>`;

function fail(what: string, err: unknown): void {
  showToast(`Could not ${what}: ${String(err)}`);
}

export function openCardsModal(host: ActionHost): void {
  const c = host.ctx();
  const scope = scopeOf(c.snap.target);
  const hiddenSet = new Set(c.snap.hidden_builtins);
  let cards: CardView[] = c.snap.cards;
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); host.reload(); };
  const pins = pinsEditor(c.snap.pinned_actions ?? [], scope, () => draw());

  // The snapshot's card list, not the scope's own: a project dashboard also
  // paints its group's cards, and every card it paints must be manageable here.
  const reloadCards = async (): Promise<void> => {
    const t = c.snap.target;
    try { cards = (await invoke<DashSnapshot>("dashboard_snapshot", { target: { kind: t.kind, id: t.id } })).cards; }
    catch (err) { fail("load the cards", err); }
    draw();
  };

  const setHidden = (id: string, hide: boolean): void => {
    if (hide) hiddenSet.add(id); else hiddenSet.delete(id);
    void invoke<void>("dashboard_builtin_set_hidden", { scope, builtin: id, hidden: hide }).catch((e) => fail("save", e));
    draw();
  };

  const customRow = (v: CardView): TemplateResult => html`
    <div class="pd-mrow">
      <span class="pd-mt">${v.config.title}</span>
      ${c.snap.target.kind === "project" && v.config.scope.kind === "group"
        ? html`<span class="pd-fetched" title="Added on the group's dashboard; changes here apply to every repo in it">group card</span>` : nothing}
      <span class="pd-fetched">${v.result ? fetchedLabel(v.result.fetched_at_ms) : "not fetched"}</span>
      ${v.config.enabled ? html`<button type="button" class="pd-ib sm" title="Refresh" @click=${() => {
        void invoke("dashboard_card_refresh", { id: v.config.id }).then(reloadCards, (e) => fail("refresh", e));
      }}><i class="ph ph-arrows-clockwise"></i></button>` : nothing}
      <button type="button" class="pd-ib sm" title="Delete" @click=${() => {
        void askConfirm(`Delete the card "${v.config.title}"?`, { confirmLabel: "Delete" }).then(async (ok) => {
          if (!ok) return;
          await invoke("dashboard_card_delete", { id: v.config.id }).catch((e) => fail("delete", e));
          await reloadCards();
        });
      }}><i class="ph ph-trash"></i></button>
      ${toggle(v.config.enabled, (next) => {
        v.config.enabled = next;
        void invoke("dashboard_card_set_enabled", { id: v.config.id, enabled: next }).catch((e) => fail("save", e));
        draw();
      })}
    </div>`;

  function draw(): void {
    render(html`
      <div class="modal-card pd-modal" role="dialog" aria-modal="true" aria-label="Dashboard cards">
        <header class="modal-header"><h3>Dashboard cards</h3></header>
        <div class="modal-body pd-mbody">
          ${pins.view()}
          <div class="pd-msec">Sections</div>
          ${BUILTIN_CARDS.map((b) => html`<div class="pd-mrow"><span class="pd-mt">${b.label}</span>
            ${toggle(!hiddenSet.has(b.id), (on) => setHidden(b.id, !on))}</div>`)}
          <div class="pd-msec">Custom cards</div>
          ${cards.length ? cards.map(customRow) : html`<div class="pd-quiet">None yet</div>`}
          <p class="pd-hint">Ask Claude in a chat here to add a card, e.g. a Shortcut card of my stories.</p>
        </div>
        <footer class="modal-footer"><button type="button" class="btn btn-primary" @click=${close}>Done</button></footer>
      </div>`, slot);
  }

  setBackdropCancel(close);
  void presentHostCard(draw);
  void reloadCards();
}

export function openEditReposModal(host: ActionHost): void {
  const t = host.ctx().snap.target;
  if (t.kind !== "group") return;
  let name = t.name;
  const picked = new Set(t.repos.map((r) => r.cwd));
  let projects: Array<{ path: string, name: string }> = t.repos.map((r) => ({ path: r.cwd, name: r.name }));
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };
  const isPicked = (path: string): boolean => [...picked].some((p) => sameCwd(p, path));

  const save = async (): Promise<void> => {
    try {
      await invoke<GroupDef>("dashboard_group_upsert", { id: t.id, name: name.trim(), repos: [...picked] });
      close();
      host.reload();
    } catch (err) { fail("save the group", err); }
  };

  function draw(): void {
    render(html`
      <div class="modal-card pd-modal" role="dialog" aria-modal="true" aria-label="Edit repos">
        <header class="modal-header"><h3>Edit repos</h3></header>
        <div class="modal-body pd-mbody">
          <label class="pd-field">Name
            <input type="text" autocomplete="off" .value=${name} @input=${(e: Event) => { name = (e.target as HTMLInputElement).value; draw(); }}>
          </label>
          <div class="pd-msec">Repos</div>
          ${projects.map((p) => html`<label class="pd-mrow pd-check">
            <input type="checkbox" .checked=${isPicked(p.path)} @change=${(e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              for (const x of [...picked]) if (sameCwd(x, p.path)) picked.delete(x);
              if (on) picked.add(p.path);
              draw();
            }}><span class="pd-mt">${p.name}</span><span class="pd-fetched">${p.path}</span></label>`)}
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn btn-secondary" @click=${close}>Cancel</button>
          <button type="button" class="btn btn-primary" ?disabled=${!name.trim() || picked.size === 0} @click=${() => void save()}>Save</button>
        </footer>
      </div>`, slot);
  }

  setBackdropCancel(close);
  void presentHostCard(draw);
  void api.listProjects().then((list) => {
    // Keep current members the project list no longer knows, so saving can't silently drop them.
    const extra = projects.filter((m) => !list.some((p) => sameCwd(p.path, m.path)));
    projects = [...list.map((p) => ({ path: p.path, name: String(p.name) })), ...extra];
    draw();
  }).catch((err) => fail("load projects", err));
}
