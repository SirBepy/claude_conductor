/**
 * Token gate for the browser (phone) remote client.
 *
 * When the SPA is served from the daemon's remote-access server and the user
 * has not yet paired their device, every /api call 401s. This module
 * intercepts that situation at boot:
 *
 *  - If the URL carries ?pair=<code>  : calls /api/pair to exchange the one-time
 *    code for a device token, stores it, strips the URL param, proceeds.
 *  - If the URL carries ?token=<TOKEN>: legacy path - stores directly.
 *  - If a token is already stored     : proceeds immediately.
 *  - Otherwise                        : renders a minimal full-screen form with
 *    both a manual-paste path and a camera-scan button.
 *
 * This is a complete NO-OP inside the Tauri webview (window.__TAURI__ present).
 */

import { REMOTE_TOKEN_KEY, REMOTE_TOKEN_EXPIRED_KEY } from "./http-transport";
import { captureShellVersion } from "./shell-version";
import { stripUrlParam } from "./url-params";

/** True when the previous token was rejected (401) and cleared by the transport. */
function consumeExpiredFlag(): boolean {
  try {
    const expired = sessionStorage.getItem(REMOTE_TOKEN_EXPIRED_KEY) === "1";
    if (expired) sessionStorage.removeItem(REMOTE_TOKEN_EXPIRED_KEY);
    return expired;
  } catch {
    return false;
  }
}

function daemonOrigin(): string {
  try { return new URL(location.href).origin; }
  catch { return location.origin; }
}

async function exchangePairingCode(code: string): Promise<string> {
  const res = await fetch(`${daemonOrigin()}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_code: code, device_name: "Phone" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`Pairing failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { device_token?: string };
  if (!data.device_token) throw new Error("Daemon did not return a token");
  return data.device_token;
}

async function capturePairingFromUrl(): Promise<boolean> {
  if (typeof window === "undefined" || typeof location === "undefined") return false;

  let params: URLSearchParams;
  try { params = new URL(location.href).searchParams; }
  catch { return false; }

  const pairCode = params.get("pair")?.trim();
  const legacyToken = params.get("token")?.trim();

  if (pairCode) {
    stripUrlParam("pair");
    try {
      const token = await exchangePairingCode(pairCode);
      localStorage.setItem(REMOTE_TOKEN_KEY, token);
      return true;
    } catch (e) {
      console.error("[remote-gate] pairing failed", e);
      renderPairingError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  if (legacyToken) {
    stripUrlParam("token");
    try { localStorage.setItem(REMOTE_TOKEN_KEY, legacyToken); return true; }
    catch { return false; }
  }

  return false;
}

/**
 * Ensure a remote bearer token is present when running in a plain browser
 * (phone). Returns true when auth is ready; false when the gate was rendered
 * (boot should halt - the gate's submit or scan handler reloads the page).
 */
export async function ensureRemoteToken(): Promise<boolean> {
  if (typeof window !== "undefined" && window.__TAURI__) return true;

  captureShellVersion();
  if (await capturePairingFromUrl()) return true;

  let token = "";
  try { token = localStorage.getItem(REMOTE_TOKEN_KEY) ?? ""; }
  catch { return true; }
  if (token.trim()) return true;

  renderTokenGate();
  return false;
}

function renderPairingError(msg: string): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0f1117;z-index:9999;font-family:system-ui,sans-serif";
  const card = document.createElement("div");
  card.style.cssText = "background:#1a1d27;border:1px solid #2e3148;border-radius:12px;padding:32px 28px;width:min(420px,90vw);box-shadow:0 8px 32px rgba(0,0,0,.6);color:#e0e1f0";
  card.innerHTML = `<h2 style="margin:0 0 12px;font-size:1.1rem;color:#f87171">Pairing failed</h2><p style="margin:0 0 20px;font-size:.85rem;line-height:1.5;color:#8b8fa8">${msg}</p>`;
  const btn = document.createElement("button");
  btn.textContent = "Try again";
  btn.style.cssText = "width:100%;padding:10px;background:#5865f2;color:#fff;border:none;border-radius:7px;font-size:.95rem;font-weight:600;cursor:pointer";
  btn.onclick = () => window.location.reload();
  card.appendChild(btn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function renderTokenGate(): void {
  const overlay = document.createElement("div");
  overlay.id = "rc-token-gate";
  overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0f1117;z-index:9999;font-family:system-ui,sans-serif";

  const card = document.createElement("div");
  card.style.cssText = "background:#1a1d27;border:1px solid #2e3148;border-radius:12px;padding:32px 28px;width:min(420px,90vw);box-shadow:0 8px 32px rgba(0,0,0,.6);color:#e0e1f0;display:flex;flex-direction:column;gap:12px";

  const expired = consumeExpiredFlag();

  const heading = document.createElement("h2");
  heading.textContent = expired ? "Session expired" : "Pair this device";
  heading.style.cssText = "margin:0;font-size:1.15rem;font-weight:600;color:#fff";

  const hint = document.createElement("p");
  hint.textContent = expired
    ? "Your access token was rejected. Re-scan the QR in Settings > Remote access on the desktop."
    : "Scan the QR code shown in Settings > Remote access on the desktop, or paste your bearer token or the full pairing URL below.";
  hint.style.cssText = "margin:0;font-size:.85rem;line-height:1.5;color:#8b8fa8";

  const scanBtn = document.createElement("button");
  scanBtn.textContent = "Scan QR code with camera";
  scanBtn.type = "button";
  scanBtn.style.cssText = "padding:10px;background:#5865f2;color:#fff;border:none;border-radius:7px;font-size:.95rem;font-weight:600;cursor:pointer";

  const scanStatus = document.createElement("p");
  scanStatus.style.cssText = "margin:0;font-size:.82rem;color:#f87171;display:none";

  scanBtn.onclick = () => {
    void (async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = "Opening camera…";
      scanStatus.style.display = "none";
      try {
        const { scanQrCode } = await import("./qr-scanner");
        const url = await scanQrCode();
        const pairCode = new URL(url).searchParams.get("pair")?.trim();
        if (!pairCode) throw new Error("QR did not contain a pairing code");
        const token = await exchangePairingCode(pairCode);
        localStorage.setItem(REMOTE_TOKEN_KEY, token);
        window.location.reload();
      } catch (e) {
        if (e instanceof Error && e.message === "cancelled") {
          scanBtn.disabled = false;
          scanBtn.textContent = "Scan QR code with camera";
          return;
        }
        scanStatus.textContent = e instanceof Error ? e.message : "Scan failed";
        scanStatus.style.display = "block";
        scanBtn.disabled = false;
        scanBtn.textContent = "Scan QR code with camera";
      }
    })();
  };

  const divider = document.createElement("p");
  divider.textContent = "— or paste token or URL manually —";
  divider.style.cssText = "margin:0;font-size:.78rem;text-align:center;color:#555770";

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Paste token or full URL here";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText = "padding:10px 12px;background:#0f1117;border:1px solid #2e3148;border-radius:7px;color:#e0e1f0;font-size:.95rem;outline:none;width:100%;box-sizing:border-box";

  const error = document.createElement("p");
  error.style.cssText = "margin:0;font-size:.82rem;color:#f87171;display:none";
  error.textContent = "Token cannot be empty.";

  const connectBtn = document.createElement("button");
  connectBtn.textContent = "Connect";
  connectBtn.type = "button";
  connectBtn.style.cssText = "padding:10px;background:#3d4166;color:#fff;border:none;border-radius:7px;font-size:.95rem;font-weight:600;cursor:pointer";

  connectBtn.addEventListener("click", () => {
    const val = input.value.trim();
    if (!val) { error.style.display = "block"; return; }
    error.style.display = "none";

    // If the pasted value looks like a URL, try to extract pair/token params first.
    let parsed: URL | null = null;
    try { parsed = new URL(val); } catch { /* not a URL, treat as raw token */ }

    if (parsed) {
      const pairCode = parsed.searchParams.get("pair")?.trim();
      const legacyToken = parsed.searchParams.get("token")?.trim();
      if (pairCode) {
        connectBtn.disabled = true;
        connectBtn.textContent = "Connecting…";
        void exchangePairingCode(pairCode).then(token => {
          try { localStorage.setItem(REMOTE_TOKEN_KEY, token); } catch { /* ignore */ }
          window.location.reload();
        }).catch(e => {
          error.textContent = e instanceof Error ? e.message : "Pairing failed";
          error.style.display = "block";
          connectBtn.disabled = false;
          connectBtn.textContent = "Connect";
        });
        return;
      }
      if (legacyToken) {
        try { localStorage.setItem(REMOTE_TOKEN_KEY, legacyToken); } catch { /* ignore */ }
        window.location.reload();
        return;
      }
      // URL but no recognised params - fall through and treat as raw token.
    }

    try { localStorage.setItem(REMOTE_TOKEN_KEY, val); } catch { /* ignore */ }
    window.location.reload();
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") connectBtn.click();
  });

  card.append(heading, hint, scanBtn, scanStatus, divider, input, error, connectBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);
}
