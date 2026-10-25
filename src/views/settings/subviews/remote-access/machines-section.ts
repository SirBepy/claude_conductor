// Paired-machines section of the Remote access settings view (multi-machine
// federation, H4) - machine rows (this one first) + pairing form. Split out
// of remote-access.ts (3a45b917 added this inline) to keep that file under
// the ~300-line view rule.

import { html } from "lit-html";
import { api } from "../../../../shared/api";
import { isRemote } from "../../../../shared/transport";
import { renderEntityList, renameFieldHtml, wireRenameFields } from "./entity-list";
import { iconButtonHtml, isIconPickerOpen, onIconPickerClosed, wireIconPickers } from "./icon-picker";
import { assignMachineIcons } from "../../../sessions/machine-icons";

function $(root: HTMLElement, sel: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(sel);
}

interface MachineRow {
  machine_id: string;
  label: string;
  os: string;
  icon?: string | null;
  isSelf: boolean;
  reach?: string | null;
  can_drive?: boolean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Paired-machines section: machine rows (this one first) + pairing form.
 *  Hidden entirely when list_machines() fails - the phone (RemoteUnavailableError)
 *  and any desktop build without the federation backend yet both degrade the
 *  same way, rather than showing a form that can never do anything. */
/** Peer ids seen by the last render, so the next one can tell which peer
 *  just arrived. `null` until the first render: everything already paired
 *  when the page opens is old news, not a fresh link. */
let knownPeerIds: Set<string> | null = null;

/** How long the "Linked with" line and the new row's highlight stay up. */
const LINKED_NOTICE_MS = 6000;
let linkedTimer: ReturnType<typeof setTimeout> | undefined;

function announceLinked(root: HTMLElement, labels: string[]): void {
  const el = $(root, "#ra-machine-linked");
  if (!el || labels.length === 0) return;
  el.innerHTML = `<i class="ph ph-check-circle"></i> Linked with ${labels.map(escapeHtml).join(", ")}`;
  el.hidden = false;
  clearTimeout(linkedTimer);
  linkedTimer = setTimeout(() => { el.hidden = true; }, LINKED_NOTICE_MS);
}

/** Forget the previous page's peers, so reopening the view never announces
 *  a machine that was paired while it was closed as if it just happened. */
export function resetMachinesSection(): void {
  knownPeerIds = null;
  clearTimeout(linkedTimer);
}

let refreshDeferred = false;

/** A render skipped for an open grid or a focused name field is replayed once
 *  that ends; dropping it would leave stale names until the next event. One
 *  pending replay at a time, since it re-reads the lists anyway. */
function deferRefresh(root: HTMLElement, arm: (run: () => void) => void): void {
  if (refreshDeferred) return;
  refreshDeferred = true;
  arm(() => {
    refreshDeferred = false;
    void renderMachinesSection(root);
  });
}

export async function renderMachinesSection(root: HTMLElement): Promise<void> {
  const section = $(root, "#ra-machines-section");
  if (!section) return;
  try {
    const { self, peers } = await api.listMachines();
    const previous = knownPeerIds;
    const fresh = previous ? peers.filter((p) => !previous.has(p.machine_id)) : [];
    knownPeerIds = new Set(peers.map((p) => p.machine_id));

    // Typing in a name or browsing the icon grid must survive a
    // machines-changed re-render, which rebuilds the rows (and the grid's anchor).
    const active = document.activeElement;
    const list = $(root, "#ra-machine-list");
    if (isIconPickerOpen()) {
      deferRefresh(root, (run) => onIconPickerClosed(run));
      return;
    }
    if (active instanceof HTMLInputElement && list?.contains(active)) {
      deferRefresh(root, (run) => active.addEventListener("focusout", () => setTimeout(run, 0), { once: true }));
      return;
    }

    const icons = assignMachineIcons([...(self ? [self] : []), ...peers]);
    // One row per machine, this one first. The self row has no drive/unpair
    // controls; its id maps to a null machine id in set_machine_profile.
    const rows: MachineRow[] = [
      ...(self ? [{ machine_id: self.machine_id, label: self.label, os: self.os, icon: self.icon, isSelf: true as const }] : []),
      ...peers.map((p) => ({ ...p, isSelf: false as const })),
    ];
    const selfId = self?.machine_id ?? null;

    renderEntityList(
      root,
      "#ra-machine-list",
      rows,
      (p) => `
        <div class="ra-device-row" data-id="${escapeHtml(p.machine_id)}">
          ${iconButtonHtml(p.machine_id, icons.get(p.machine_id) ?? "ph-desktop", p.icon)}
          <div class="ra-device-info">
            ${renameFieldHtml(p.machine_id, p.label, escapeHtml)}
            <span class="ra-device-date">${p.isSelf ? "This machine &middot; " : ""}${escapeHtml(p.os)}${!p.isSelf && p.reach ? ` &middot; ${escapeHtml(p.reach)}` : ""}</span>
          </div>
          ${p.isSelf ? "" : `${isRemote() ? "" : `<label class="ra-machine-drive" title="Off: ${escapeHtml(p.label)} still sees every chat here, but can only drive the chats it started">
            <span class="ra-machine-drive-label">Can drive chats</span>
            <span class="kit-toggle">
              <input type="checkbox" class="ra-machine-drive-input" data-id="${escapeHtml(p.machine_id)}" ${p.can_drive === false ? "" : "checked"}>
              <span class="kit-toggle-track"></span>
            </span>
          </label>`}
          <button class="btn-danger-sm ra-unpair-btn" data-id="${escapeHtml(p.machine_id)}">Unpair</button>`}
        </div>
      `,
      ".ra-unpair-btn",
      async (id) => {
        await api.unpairMachine(id);
        await renderMachinesSection(root);
      },
      { errorLabel: "unpair_machine" },
    );
    if (peers.length === 0) {
      list?.insertAdjacentHTML("beforeend", `
        <div class="v-empty">
          <i class="ph ph-devices v-empty-icon"></i>
          <div class="v-empty-title">No paired machines yet</div>
          <div class="v-empty-hint">Paste another machine's pairing URL below to pair it.</div>
        </div>
      `);
    }

    // Self targets the daemon being talked to, which the RPC spells as null.
    const target = (id: string) => (id === selfId ? null : id);
    wireIconPickers(root, "#ra-machine-list", (id, icon) => api.setMachineProfile(target(id), { icon }), "set_machine_profile");
    wireDriveToggles(root);
    wireRenameFields(root, "#ra-machine-list", (id, name) => api.setMachineProfile(target(id), { label: name }), "set_machine_profile");

    const freshIds = new Set(fresh.map((p) => p.machine_id));
    root.querySelectorAll<HTMLElement>("#ra-machine-list .ra-device-row").forEach((row) => {
      if (row.dataset.id && freshIds.has(row.dataset.id)) row.classList.add("ra-row-new");
    });
    announceLinked(root, fresh.map((p) => p.label));

    section.style.display = "";
  } catch (e) {
    console.error("[remote-access] list_machines unavailable", e);
    section.style.display = "none";
  }
}

/** A failed save puts the switch back, since the daemon still holds the old
 *  value. */
function wireDriveToggles(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>("#ra-machine-list .ra-machine-drive-input").forEach((input) => {
    input.onchange = () => {
      const id = input.dataset.id ?? "";
      const value = input.checked;
      input.disabled = true;
      void api
        .setMachineCanDrive(id, value)
        .catch((e) => {
          console.error("[remote-access] set_machine_can_drive failed", e);
          input.checked = !value;
        })
        .finally(() => { input.disabled = false; });
    };
  });
}

export function wireMachinePairForm(root: HTMLElement): void {
  const btn = $(root, "#ra-machine-pair-btn") as HTMLButtonElement | null;
  const urlInput = $(root, "#ra-machine-pair-url") as HTMLInputElement | null;
  const myUrlInput = $(root, "#ra-machine-my-url") as HTMLInputElement | null;
  const errEl = $(root, "#ra-machine-pair-error");
  if (!btn || !urlInput) return;
  btn.onclick = () => {
    void (async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      btn.disabled = true;
      if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
      try {
        await api.pairMachine(url, myUrlInput?.value.trim() || null);
        urlInput.value = "";
        await renderMachinesSection(root);
      } catch (e) {
        if (errEl) {
          errEl.textContent = e instanceof Error ? e.message : "Failed to pair - check the URL and try again";
          errEl.hidden = false;
        }
      } finally {
        btn.disabled = false;
      }
    })();
  };
}

export function machinesSectionTemplate() {
  return html`
    <div class="kit-section" id="ra-machines-section" style="display:none">
      <div class="kit-section-title">Paired machines</div>
      <p id="ra-machine-linked" class="ra-machine-linked" hidden></p>
      <div id="ra-machine-list" class="ra-device-list"></div>
      <div class="ra-machine-pair-form">
        <input type="text" id="ra-machine-pair-url" class="ra-token-field" placeholder="Paste the other machine's pairing URL">
        <input type="text" id="ra-machine-my-url" class="ra-token-field" placeholder="URL that machine can use to reach this one (optional)">
        <button class="btn-secondary ra-machine-pair-btn" id="ra-machine-pair-btn">Pair</button>
        <p id="ra-machine-pair-error" class="ra-machine-pair-error" hidden></p>
      </div>
    </div>
  `;
}
