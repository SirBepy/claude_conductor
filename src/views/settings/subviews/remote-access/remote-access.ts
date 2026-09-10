import { html, render } from "lit-html";
import { api, type RemoteAccessStatus } from "../../../../shared/api";
import { settingsHeader } from "../../ui";
import { renderMachinesSection, wireMachinePairForm, machinesSectionTemplate } from "./machines-section";
import { renderEntityList } from "./entity-list";
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
  if (!$(root, "#ra-device-list")) return;
  try {
    const devices = await api.listRemoteDevices();
    const phone_devices = devices.filter(d => d.id !== "desktop");
    const section = $(root, "#ra-devices-section");
    if (section) section.style.display = phone_devices.length > 0 ? "" : "none";
    renderEntityList(
      root,
      "#ra-device-list",
      phone_devices,
      (d) => `
        <div class="ra-device-row" data-id="${escapeHtml(d.id)}">
          <div class="ra-device-info">
            <span class="ra-device-name">${escapeHtml(d.name)}</span>
            <span class="ra-device-date">Paired ${new Date(d.created_at * 1000).toLocaleDateString()}</span>
          </div>
          <button class="btn-danger-sm ra-revoke-btn" data-id="${escapeHtml(d.id)}">Revoke</button>
        </div>
      `,
      ".ra-revoke-btn",
      async (id) => {
        await api.revokeRemoteDevice(id);
        await renderDeviceList(root);
      },
      { errorLabel: "revoke" },
    );
  } catch (e) {
    console.error("[remote-access] listRemoteDevices failed", e);
  }
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

        ${machinesSectionTemplate()}

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
