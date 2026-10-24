import { html, render } from "lit-html";
import { api } from "../../../../shared/api";
import { settingsHeader } from "../../ui";
import { getTransport, isRemote } from "../../../../shared/transport";
import {
  renderMachinesSection, resetMachinesSection, wireMachinePairForm, machinesSectionTemplate,
} from "./machines-section";
import { renderEntityList, renameFieldHtml, wireRenameFields } from "./entity-list";
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
    box.innerHTML = `<span class="ra-qr-fallback">Not ready yet - the background service is still starting. Try Refresh QR in a moment.</span>`;
    currentPairingUrl = "";
    const copyBtn = $(root, "#ra-copy-url");
    if (copyBtn) copyBtn.style.display = "none";
  }
}

/** A device that has not authed since the field was introduced reads "not yet"
 *  rather than a wrong date; the first request stamps it. */
export function lastUsedLabel(lastUsed: number | null | undefined): string {
  if (!lastUsed) return "not yet";
  return new Date(lastUsed * 1000).toLocaleDateString();
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
            ${isRemote() || d.kind === "machine" ? `<span class="ra-device-name">${escapeHtml(d.name)}</span>` : renameFieldHtml(d.id, d.name, escapeHtml)}
            <span class="ra-device-date">Paired ${new Date(d.created_at * 1000).toLocaleDateString()} - last used ${lastUsedLabel(d.last_used)}</span>
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
    wireRenameFields(root, "#ra-device-list", (id, name) => api.renameRemoteDevice(id, name), "rename_remote_device");
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

  // Machine pairing is its own section; it renders (or hides itself, on the
  // phone) regardless of the switch, so existing peers stay listed while off.
  wireMachinePairForm(root);
  await renderMachinesSection(root);
  await renderDeviceList(root);

  const showQr = status.enabled;
  const qrSection = $(root, "#ra-qr-section");
  if (qrSection) qrSection.style.display = showQr ? "" : "none";

  if (showQr) {
    await refreshQr(root);

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
  }
}

export async function renderRemoteAccessView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);
  resetMachinesSection();

  try { await hydrate(root); }
  catch (e) { console.error("[remote-access] render failed", e); }

  // A pair started from the OTHER machine lands here with no click on this
  // side, so the list (and the now-consumed pairing code) refresh off the
  // daemon's event instead of waiting for the page to be reopened.
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void getTransport()
    .listen("machines-changed", () => {
      void renderMachinesSection(root);
      if (($(root, "#ra-enabled") as HTMLInputElement | null)?.checked) void refreshQr(root);
    })
    .then((u) => { if (disposed) u(); else unlisten = u; })
    .catch((e) => console.error("[remote-access] machines-changed listen failed", e));

  return () => {
    disposed = true;
    unlisten?.();
  };
}

function template() {
  return html`
    <div class="view view-settings">
      ${settingsHeader("Remote access")}
      <div class="view-body">

        <div class="kit-section">
          <p class="ra-explainer">
            Control this app from your phone, or pair another Conductor machine, peer-to-peer from anywhere.
            Off means no remote device can reach this machine.
          </p>
          <div class="kit-row">
            <span class="kit-row-label">Enable remote access</span>
            <label class="kit-toggle">
              <input type="checkbox" id="ra-enabled">
              <span class="kit-toggle-track"></span>
            </label>
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

      </div>
    </div>
  `;
}
