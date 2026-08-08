(() => {
  const STORAGE_KEY = "conductor_server_url";
  const IROH_STORAGE_KEY = "conductor_iroh_id";
  const HEALTH_TIMEOUT_MS = 5000;

  const screens = {
    connecting: document.getElementById("screen-connecting"),
    setup: document.getElementById("screen-setup"),
    error: document.getElementById("screen-error"),
  };

  const setupForm = document.getElementById("setup-form");
  const serverUrlInput = document.getElementById("server-url");
  const setupError = document.getElementById("setup-error");
  const errorUrlEl = document.getElementById("error-url");
  const retryBtn = document.getElementById("retry-btn");
  const changeServerBtn = document.getElementById("change-server-btn");
  const scanQrBtn = document.getElementById("scan-qr-btn");

  function showScreen(name) {
    for (const key of Object.keys(screens)) {
      screens[key].hidden = key !== name;
    }
  }

  // https-only: the native shell's navigation guard (src-tauri/src/lib.rs)
  // only permits https:// navigation, so accepting http here would silently
  // strand the user after a successful health check.
  function normalizeUrl(raw) {
    const trimmed = raw.trim().replace(/\/+$/, "");
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  function getStoredUrl() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function storeUrl(url) {
    try {
      localStorage.setItem(STORAGE_KEY, url);
    } catch {
      // Ignore: worst case the user re-enters it next launch.
    }
  }

  // Both pairing QR shapes carry `iroh=<endpoint-id>`: the Tailscale-DNS
  // https URL and, when Tailscale is down, `conductor://pair?iroh=...`.
  // A plain URL parse reads searchParams from either scheme the same way.
  function extractIrohParams(raw) {
    try {
      const url = new URL(raw.trim());
      const iroh = url.searchParams.get("iroh");
      if (!iroh) return null;
      return { iroh, pair: url.searchParams.get("pair") };
    } catch {
      return null;
    }
  }

  // Plain app command, not a plugin - no "plugin:name|" prefix needed.
  function tunnelInvoke(cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }

  // The port is fixed (src-tauri LOOPBACK_PORT) so the SPA's rc_token, which
  // lives in this origin's localStorage, survives across launches.
  async function connectViaIroh(endpointId, pairCode) {
    showScreen("connecting");
    try {
      localStorage.setItem(IROH_STORAGE_KEY, endpointId);
    } catch {
      // Ignore: worst case re-scanning the QR mints a fresh tunnel next time.
    }
    try {
      const port = await tunnelInvoke("start_iroh_tunnel", { endpointId });
      const target = new URL(`http://127.0.0.1:${port}/`);
      if (pairCode) target.searchParams.set("pair", pairCode);
      window.location.href = target.toString();
    } catch (err) {
      console.error("iroh tunnel failed:", err);
      const errMsg = (err && err.message) ? err.message : String(err);
      errorUrlEl.textContent = `http://127.0.0.1 - Error: ${errMsg}`;
      showScreen("error");
    }
  }

  // no-cors: cross-origin from the shell's own http://tauri.localhost to the
  // daemon (no CORS headers), so a normal fetch's response is unreadable.
  // An opaque response still REJECTS on a real network failure - enough for a liveness check.
  async function checkHealth(baseUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      await fetch(baseUrl + "/api/health", {
        signal: controller.signal,
        cache: "no-store",
        mode: "no-cors",
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // `navigateTo`, when given, is the full scanned URL (e.g. the desktop's
  // pairing QR: https://host/?pair=CODE) - navigate to that instead of the
  // bare origin so the SPA's ?pair= gate (remote-gate.ts) can consume the
  // code. Manual entry has no code to carry, so it just uses baseUrl.
  async function connect(baseUrl, navigateTo) {
    showScreen("connecting");
    const healthy = await checkHealth(baseUrl);
    if (healthy) {
      window.location.href = navigateTo ?? baseUrl;
      return;
    }
    errorUrlEl.textContent = baseUrl;
    showScreen("error");
  }

  setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const iroh = extractIrohParams(serverUrlInput.value);
    if (iroh) {
      setupError.hidden = true;
      connectViaIroh(iroh.iroh, iroh.pair);
      return;
    }
    const normalized = normalizeUrl(serverUrlInput.value);
    if (!normalized) {
      setupError.textContent = "Enter a valid https:// URL, e.g. https://your-pc.ts.net";
      setupError.hidden = false;
      return;
    }
    setupError.hidden = true;
    storeUrl(normalized);
    connect(normalized);
  });

  // Low-level IPC bridge instead of window.__TAURI__.barcodeScanner (needs
  // withGlobalTauri:true) - that global also leaks into the SPA once we
  // navigate there, making it think it's the native app, not a remote client.
  function scannerInvoke(cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(`plugin:barcode-scanner|${cmd}`, args);
  }

  // Scans the same pairing QR the desktop's Settings > Remote access tab
  // shows (https://host/?pair=CODE) - connect() carries the full URL through
  // so the SPA auto-exchanges the code instead of the user re-pairing by hand.
  if (!window.__TAURI_INTERNALS__?.invoke) {
    scanQrBtn.hidden = true;
  } else {
    scanQrBtn.addEventListener("click", () => {
      void (async () => {
        scanQrBtn.disabled = true;
        try {
          let { camera: state } = await scannerInvoke("check_permissions");
          if (state !== "granted") ({ camera: state } = await scannerInvoke("request_permissions"));
          if (state !== "granted") {
            setupError.textContent = "Camera permission denied - enable it in app settings.";
            setupError.hidden = false;
            return;
          }
          const result = await scannerInvoke("scan", { windowed: true, formats: ["QR_CODE"] });
          const iroh = extractIrohParams(result.content);
          if (iroh) {
            setupError.hidden = true;
            connectViaIroh(iroh.iroh, iroh.pair);
            return;
          }
          const normalized = normalizeUrl(result.content);
          if (!normalized) {
            setupError.textContent = "That QR code isn't a valid https:// server URL.";
            setupError.hidden = false;
            return;
          }
          setupError.hidden = true;
          storeUrl(normalized);
          connect(normalized, result.content);
        } catch {
          // scan() also rejects on user cancel - not worth surfacing as an error.
        } finally {
          scanQrBtn.disabled = false;
        }
      })();
    });
  }

  retryBtn.addEventListener("click", () => {
    const stored = getStoredUrl();
    if (stored) connect(stored);
  });

  changeServerBtn.addEventListener("click", () => {
    const stored = getStoredUrl();
    if (stored) serverUrlInput.value = stored;
    showScreen("setup");
  });

  function init() {
    const stored = getStoredUrl();
    if (stored) {
      connect(stored);
    } else {
      showScreen("setup");
    }
  }

  init();
})();
