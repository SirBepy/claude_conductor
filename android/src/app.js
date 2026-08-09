(() => {
  const STORAGE_KEY = "conductor_server_url";
  const IROH_STORAGE_KEY = "conductor_iroh_id";
  const HEALTH_TIMEOUT_MS = 5000;
  const UNREACHABLE_MESSAGE =
    "Can’t reach your PC. Make sure Claude Conductor is running there and the tunnel is up.";

  const scanQrBtn = document.getElementById("scan-qr-btn");
  const scanQrSpinner = document.getElementById("scan-qr-spinner");
  const scanQrLabel = document.getElementById("scan-qr-label");
  const manualToggleBtn = document.getElementById("manual-toggle-btn");
  const setupForm = document.getElementById("setup-form");
  const serverUrlInput = document.getElementById("server-url");
  const urlSubmitBtn = document.getElementById("url-submit-btn");
  const urlSubmitCheck = document.getElementById("url-submit-check");
  const urlSubmitSpinner = document.getElementById("url-submit-spinner");
  const idleError = document.getElementById("idle-error");
  const errorUrlEl = document.getElementById("error-url");
  const scanCancelBtn = document.getElementById("scan-cancel-btn");

  // Which control most recently kicked off connect(): drives which slot
  // (primary button vs inline checkmark) shows the connecting spinner, and
  // whether a failure re-opens the manual form. "auto" = init()'s silent
  // reconnect from a stored URL - visually it uses the primary button (the
  // only slot guaranteed visible before the user has touched anything) but
  // behaves like "manual" on failure since there's a known URL to retry.
  let activeSource = null;
  let scanBtnLabel = "Scan QR code";

  function openManualForm() {
    manualToggleBtn.hidden = true;
    setupForm.hidden = false;
  }

  function collapseManualForm() {
    setupForm.hidden = true;
    manualToggleBtn.hidden = false;
  }

  function showIdleError(message, url) {
    idleError.textContent = message;
    idleError.hidden = false;
    if (url) {
      errorUrlEl.textContent = url;
      errorUrlEl.hidden = false;
    } else {
      errorUrlEl.hidden = true;
    }
  }

  function clearIdleError() {
    idleError.hidden = true;
    errorUrlEl.hidden = true;
  }

  function setConnecting(active) {
    scanQrBtn.disabled = active;
    urlSubmitBtn.disabled = active;
    serverUrlInput.disabled = active;
    if (activeSource === "manual") {
      urlSubmitCheck.hidden = active;
      urlSubmitSpinner.hidden = !active;
    } else {
      scanQrSpinner.hidden = !active;
      scanQrLabel.textContent = active ? "Connecting…" : scanBtnLabel;
    }
  }

  function enterFailedState(baseUrl, message, source) {
    scanBtnLabel = "Scan again";
    scanQrLabel.textContent = scanBtnLabel;
    const keepManualOpen = source === "manual" || source === "auto";
    // The URL chip only adds information when the form is closed (a scan
    // failure) - when it's open, the input already shows the same URL.
    showIdleError(message, keepManualOpen ? null : baseUrl);
    if (keepManualOpen) {
      if (setupForm.hidden) {
        openManualForm();
      }
      // Pre-fill is still the failed URL - select it so the next keystroke
      // replaces it outright, no separate "change server" control needed.
      serverUrlInput.focus();
      serverUrlInput.select();
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
    const source = activeSource;
    setConnecting(true);
    const healthy = await checkHealth(baseUrl);
    if (healthy) {
      window.location.href = navigateTo ?? baseUrl;
      return;
    }
    setConnecting(false);
    enterFailedState(baseUrl, UNREACHABLE_MESSAGE, source);
  }

  manualToggleBtn.addEventListener("click", () => {
    clearIdleError();
    openManualForm();
    serverUrlInput.focus();
  });

  setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const iroh = extractIrohParams(serverUrlInput.value);
    if (iroh) {
      clearIdleError();
      connectViaIroh(iroh.iroh, iroh.pair);
      return;
    }
    const normalized = normalizeUrl(serverUrlInput.value);
    if (!normalized) {
      showIdleError("Enter a valid https:// URL, e.g. https://your-pc.ts.net");
      return;
    }
    clearIdleError();
    storeUrl(normalized);
    activeSource = "manual";
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
        clearIdleError();
        // A scan is a fresh, independent attempt - drop any manual-retry
        // form left open from a prior failed manual attempt.
        collapseManualForm();
        // windowed mode makes the native WebView transparent so the camera
        // shows through - our own painted background has to clear out too.
        document.body.classList.add("scanning");
        scanCancelBtn.hidden = false;
        let normalized = null;
        let scannedContent = null;
        try {
          let { camera: state } = await scannerInvoke("check_permissions");
          if (state !== "granted") ({ camera: state } = await scannerInvoke("request_permissions"));
          if (state !== "granted") {
            showIdleError("Camera permission denied - enable it in app settings.");
            return;
          }
          const result = await scannerInvoke("scan", { windowed: true, formats: ["QR_CODE"] });
          const iroh = extractIrohParams(result.content);
          if (iroh) {
            clearIdleError();
            connectViaIroh(iroh.iroh, iroh.pair);
            return;
          }
          normalized = normalizeUrl(result.content);
          if (!normalized) {
            showIdleError("That QR code isn't a valid https:// server URL.");
            return;
          }
          scannedContent = result.content;
        } catch {
          // scan() also rejects on user cancel - not worth surfacing as an error.
        } finally {
          // Drop the camera overlay as soon as the scan itself is done, before
          // connect()'s health check runs - it needs the .shell visible again
          // to show its own connecting spinner.
          document.body.classList.remove("scanning");
          scanCancelBtn.hidden = true;
          scanQrBtn.disabled = false;
        }
        if (normalized) {
          storeUrl(normalized);
          activeSource = "scan";
          await connect(normalized, scannedContent);
        }
      })();
    });

    scanCancelBtn.addEventListener("click", () => {
      void scannerInvoke("cancel");
    });
  }

  function init() {
    const stored = getStoredUrl();
    if (stored) {
      serverUrlInput.value = stored;
      activeSource = "auto";
      connect(stored);
    }
  }

  init();
})();
