// Paired-machines section of the Remote access settings view (multi-machine
// federation, H4) - self label editor + peer list + pairing form. Split out
// of remote-access.ts (3a45b917 added this inline) to keep that file under
// the ~300-line view rule.

import { html } from "lit-html";
import { api } from "../../../../shared/api";
import { renderEntityList } from "./entity-list";

function $(root: HTMLElement, sel: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(sel);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Commits the "This machine" label field on blur/Enter - empty/whitespace
 *  is never sent (there's nothing sane to rename to), the field just
 *  reverts to the last-known label on the next renderMachinesSection call. */
async function commitMachineLabel(root: HTMLElement, input: HTMLInputElement): Promise<void> {
  const trimmed = input.value.trim().slice(0, 40);
  if (!trimmed) { await renderMachinesSection(root); return; }
  try { await api.setMachineLabel(trimmed); }
  catch (e) { console.error("[remote-access] set_machine_label failed", e); }
}

/** Paired-machines section: self label editor + peer list + pairing form.
 *  Hidden entirely when list_machines() fails - the phone (RemoteUnavailableError)
 *  and any desktop build without the federation backend yet both degrade the
 *  same way, rather than showing a form that can never do anything. */
export async function renderMachinesSection(root: HTMLElement, myUrlSeed?: string | null): Promise<void> {
  const section = $(root, "#ra-machines-section");
  if (!section) return;
  try {
    const { self, peers } = await api.listMachines();

    const labelInput = $(root, "#ra-machine-label") as HTMLInputElement | null;
    if (labelInput && document.activeElement !== labelInput) {
      labelInput.value = self?.label ?? "";
      labelInput.onblur = () => { void commitMachineLabel(root, labelInput); };
      labelInput.onkeydown = (e) => { if (e.key === "Enter") labelInput.blur(); };
    }

    renderEntityList(
      root,
      "#ra-machine-list",
      peers,
      (p) => `
        <div class="ra-device-row" data-id="${escapeHtml(p.machine_id)}">
          <div class="ra-device-info">
            <span class="ra-device-name">${escapeHtml(p.label)}</span>
            <span class="ra-device-date">${escapeHtml(p.os)}${p.reach ? ` &middot; ${escapeHtml(p.reach)}` : ""}</span>
          </div>
          <button class="btn-danger-sm ra-unpair-btn" data-id="${escapeHtml(p.machine_id)}">Unpair</button>
        </div>
      `,
      ".ra-unpair-btn",
      async (id) => {
        await api.unpairMachine(id);
        await renderMachinesSection(root);
      },
      { emptyHtml: `<p class="ra-caption">No paired machines yet.</p>`, errorLabel: "unpair_machine" },
    );

    // Prefill only once (empty + untouched) - never stomp a value the dev is
    // mid-typing on a later refresh.
    const myUrlInput = $(root, "#ra-machine-my-url") as HTMLInputElement | null;
    if (myUrlInput && myUrlSeed && !myUrlInput.value && document.activeElement !== myUrlInput) {
      myUrlInput.value = myUrlSeed;
    }

    section.style.display = "";
  } catch (e) {
    console.error("[remote-access] list_machines unavailable", e);
    section.style.display = "none";
  }
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
      <div class="kit-row">
        <span class="kit-row-label">This machine</span>
        <input type="text" id="ra-machine-label" class="ra-machine-label-input" maxlength="40" placeholder="Label">
      </div>
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
