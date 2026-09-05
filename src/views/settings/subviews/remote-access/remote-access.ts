import { html, render } from "lit-html";
import { api, type RemoteAccessStatus } from "../../../../shared/api";
import { settingsHeader } from "../../ui";
import "./remote-access.css";

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

function statusLineHtml(s: RemoteAccessStatus): string {
  if (!s.tailscale_up) {
    return `<span class="ra-status ra-status-warn"><i class="ph ph-warning"></i> Tailscale isn't connected - start/sign in to Tailscale first</span>`;
  }
  const url = s.url
    ? `<a class="ra-url" id="ra-url-link" href="#">${escapeHtml(s.url)}</a>`
    : `<span class="ra-url">(no URL yet)</span>`;
  const serve = s.serve_running
    ? `<span class="ra-status ra-status-ok"><i class="ph ph-check-circle"></i> Serving</span>`
    : `<span class="ra-status ra-status-dim"><i class="ph ph-pause-circle"></i> Not serving</span>`;
  return `${url} ${serve}`;
}

let currentPairingUrl = "";

async function refreshQr(root: HTMLElement): Promise<void> {
  const box = $(root, "#ra-qr");
  if (!box) return;
  try {
    const result = await api.remoteAccessQr();
    box.innerHTML = result.svg;
    currentPairingUrl = result.url;
    const copyBtn = $(root, "#ra-copy-url");
    if (copyBtn) copyBtn.style.display = "";
  } catch {
    box.innerHTML = `<span class="ra-qr-fallback">QR unavailable — check Tailscale</span>`;
    currentPairingUrl = "";
    const copyBtn = $(root, "#ra-copy-url");
    if (copyBtn) copyBtn.style.display = "none";
  }
}

async function renderDeviceList(root: HTMLElement): Promise<void> {
  const list = $(root, "#ra-device-list");
  if (!list) return;
  try {
    const devices = await api.listRemoteDevices();
    const phone_devices = devices.filter(d => d.id !== "desktop");
    const section = $(root, "#ra-devices-section");
    if (section) section.style.display = phone_devices.length > 0 ? "" : "none";
    if (phone_devices.length === 0) { list.innerHTML = ""; return; }
    list.innerHTML = phone_devices.map(d => `
      <div class="ra-device-row" data-id="${escapeHtml(d.id)}">
        <div class="ra-device-info">
          <span class="ra-device-name">${escapeHtml(d.name)}</span>
          <span class="ra-device-date">Paired ${new Date(d.created_at * 1000).toLocaleDateString()}</span>
        </div>
        <button class="btn-danger-sm ra-revoke-btn" data-id="${escapeHtml(d.id)}">Revoke</button>
      </div>
    `).join("");
    list.querySelectorAll<HTMLButtonElement>(".ra-revoke-btn").forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id ?? "";
        void (async () => {
          btn.disabled = true;
          try {
            await api.revokeRemoteDevice(id);
            await renderDeviceList(root);
          } catch (e) {
            console.error("[remote-access] revoke failed", e);
            btn.disabled = false;
          }
        })();
      };
    });
  } catch (e) {
    console.error("[remote-access] listRemoteDevices failed", e);
  }
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
async function renderMachinesSection(root: HTMLElement, myUrlSeed?: string | null): Promise<void> {
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

    const list = $(root, "#ra-machine-list");
    if (list) {
      if (peers.length === 0) {
        list.innerHTML = `<p class="ra-caption">No paired machines yet.</p>`;
      } else {
        list.innerHTML = peers.map((p) => `
          <div class="ra-device-row" data-id="${escapeHtml(p.machine_id)}">
            <div class="ra-device-info">
              <span class="ra-device-name">${escapeHtml(p.label)}</span>
              <span class="ra-device-date">${escapeHtml(p.os)}${p.reach ? ` &middot; ${escapeHtml(p.reach)}` : ""}</span>
            </div>
            <button class="btn-danger-sm ra-unpair-btn" data-id="${escapeHtml(p.machine_id)}">Unpair</button>
          </div>
        `).join("");
        list.querySelectorAll<HTMLButtonElement>(".ra-unpair-btn").forEach((btn) => {
          btn.onclick = () => {
            const id = btn.dataset.id ?? "";
            void (async () => {
              btn.disabled = true;
              try {
                await api.unpairMachine(id);
                await renderMachinesSection(root);
              } catch (e) {
                console.error("[remote-access] unpair_machine failed", e);
                btn.disabled = false;
              }
            })();
          };
        });
      }
    }

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

function wireMachinePairForm(root: HTMLElement): void {
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

async function hydrate(root: HTMLElement): Promise<void> {
  const status = await api.remoteAccessStatus();

  const toggle = $(root, "#ra-enabled") as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = status.enabled;
    toggle.onchange = () => {
      void (async () => {
        try { await api.setRemoteAccessEnabled(toggle.checked); }
        catch (e) { console.error("[remote-access] set enabled failed", e); }
        await hydrate(root);
      })();
    };
  }

  const statusEl = $(root, "#ra-statusline");
  if (statusEl) {
    statusEl.innerHTML = statusLineHtml(status);
    const link = statusEl.querySelector<HTMLAnchorElement>("#ra-url-link");
    if (link && status.url) {
      const url = status.url;
      link.onclick = (e) => { e.preventDefault(); void api.openExternal(url); };
    }
  }

  // Machine pairing is a separate system from the phone/Tailscale remote
  // access above (iroh/direct-URL based) - it renders (or hides itself, on
  // the phone) regardless of the toggle/tailscale state gating the sections
  // below.
  wireMachinePairForm(root);
  await renderMachinesSection(root, status.url);

  const showQr = status.enabled && status.tailscale_up;
  const qrSection = $(root, "#ra-qr-section");
  const killSection = $(root, "#ra-kill-section");
  if (qrSection) qrSection.style.display = showQr ? "" : "none";
  if (killSection) killSection.style.display = showQr ? "" : "none";

  if (showQr) {
    await refreshQr(root);
    await renderDeviceList(root);

    const copyBtn = $(root, "#ra-copy-url");
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (!currentPairingUrl) return;
        void navigator.clipboard.writeText(currentPairingUrl).then(() => {
          copyBtn.innerHTML = "Copied!";
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy link';
          }, 2000);
        });
      };
    }

    const refreshBtn = $(root, "#ra-refresh-qr");
    if (refreshBtn) {
      refreshBtn.onclick = () => { void refreshQr(root); };
    }

    const killToggle = $(root, "#ra-kill-switch") as HTMLInputElement | null;
    if (killToggle) {
      try {
        const serverEnabled = await api.getRemoteKillSwitch();
        killToggle.checked = !serverEnabled;
        killToggle.onchange = () => {
          void (async () => {
            try { await api.setRemoteKillSwitch(!killToggle.checked); }
            catch (e) { console.error("[remote-access] kill switch failed", e); }
          })();
        };
      } catch { /* ignore */ }
    }
  }
}

export async function renderRemoteAccessView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  try { await hydrate(root); }
  catch (e) { console.error("[remote-access] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings">
      ${settingsHeader("Remote access")}
      <div class="view-body">

        <div class="kit-section">
          <p class="ra-explainer">
            Control this app from your phone over your private Tailscale network.
          </p>
          <div class="kit-row">
            <span class="kit-row-label">Enable remote access</span>
            <label class="kit-toggle">
              <input type="checkbox" id="ra-enabled">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div class="kit-row" style="border:none">
            <span id="ra-statusline" class="ra-statusline"></span>
          </div>
        </div>

        <div class="kit-section" id="ra-qr-section" style="display:none">
          <div class="kit-section-title">Pair a new device</div>
          <div id="ra-qr" class="ra-qr"></div>
          <p class="ra-caption">
            Scan with your phone camera to open the app and pair automatically.
          </p>
          <div class="ra-qr-actions">
            <button class="btn-secondary" id="ra-copy-url" title="Copy pairing URL">
              <i class="ph ph-copy"></i> Copy link
            </button>
            <button class="btn-secondary" id="ra-refresh-qr">
              <i class="ph ph-arrows-clockwise"></i> Refresh QR
            </button>
          </div>
          <p class="ra-caption" style="margin-top:8px">
            Another Conductor can pair with this machine using the same URL.
          </p>
        </div>

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

        <div class="kit-section" id="ra-devices-section" style="display:none">
          <div class="kit-section-title">Paired devices</div>
          <div id="ra-device-list" class="ra-device-list"></div>
        </div>

        <div class="kit-section" id="ra-kill-section" style="display:none">
          <div class="kit-row">
            <span class="kit-row-label">Block all remote access</span>
            <label class="kit-toggle">
              <input type="checkbox" id="ra-kill-switch">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <p class="ra-caption" style="margin-top:4px">
            Disables the remote server immediately. Paired devices get 503 until re-enabled.
          </p>
        </div>

      </div>
    </div>
  `;
}
