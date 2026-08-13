(() => {
  const STORAGE_KEY = "conductor_server_url";
  const IROH_STORAGE_KEY = "conductor_iroh_id";
  const HEALTH_TIMEOUT_MS = 5000;
  const UNREACHABLE_MESSAGE =
    "Can’t reach your PC. Make sure Claude Conductor is running there and the tunnel is up.";
  const RETRY_BASE_MS = 2000;
  const RETRY_MAX_MS = 30000;

  const setupForm = document.getElementById("setup-form");
  const scanQrBtn = document.getElementById("scan-qr-btn");
  const scanQrSpinner = document.getElementById("scan-qr-spinner");
  const scanQrLabel = document.getElementById("scan-qr-label");
  const serverUrlInput = document.getElementById("server-url");
  const urlSubmitBtn = document.getElementById("url-submit-btn");
  const urlSubmitCheck = document.getElementById("url-submit-check");
  const urlSubmitSpinner = document.getElementById("url-submit-spinner");
  const idleError = document.getElementById("idle-error");
  const scanCancelBtn = document.getElementById("scan-cancel-btn");
  const connectingScreen = document.getElementById("connecting-screen");
  const connectingStatus = document.getElementById("connecting-status");
  const connectingRetry = document.getElementById("connecting-retry");
  const connectingCancelBtn = document.getElementById("connecting-cancel-btn");

  // Which control most recently kicked off connect(): "manual" (form submit)
  // or "scan" (QR), driving which slot (primary button vs inline checkmark)
  // shows the connecting spinner. Boot's auto-reconnect uses its own
  // full-screen state below, not this button-level one.
  let activeSource = null;
  let scanBtnLabel = "Scan QR code";
  // Defense in depth: even with the scan button disabled for the whole
  // connectViaIroh await, guard the one-time pairing code against any other
  // caller (manual submit, init()'s auto-reconnect) racing a second attempt.
  let irohConnectInFlight = false;

  // Boot-time auto-reconnect state only (stored URL/iroh id). Manual submit
  // and QR scan stay single-shot with immediate feedback - the user just
  // acted, so silently retrying for 30s instead of showing the error would
  // be worse UX, not better.
  let retryToken = null; // { cancelled } for the in-flight auto-retry loop
  let navigating = false; // set the instant window.location.href is assigned;
  // every loop checks it before proceeding, so nothing fires after nav starts
  let activeAbortController = null; // lets Cancel abort a health check in flight
  let countdownTimerId = null;
  let countdownResolve = null; // lets Cancel resolve the backoff wait instantly

  function showIdleError(message) {
    idleError.textContent = message;
    idleError.hidden = false;
  }

  function clearIdleError() {
    idleError.hidden = true;
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

  // The field always shows whatever was last attempted (typed or scanned),
  // so a failure just needs the message - select the value for retry.
  function enterFailedState(message) {
    scanBtnLabel = "Scan again";
    scanQrLabel.textContent = scanBtnLabel;
    showIdleError(message);
    serverUrlInput.focus();
    serverUrlInput.select();
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
    if (irohConnectInFlight) return;
    irohConnectInFlight = true;
    setConnecting(true);
    try {
      localStorage.setItem(IROH_STORAGE_KEY, endpointId);
    } catch {
      // Ignore: worst case re-scanning the QR mints a fresh tunnel next time.
    }
    try {
      const port = await tunnelInvoke("start_iroh_tunnel", { endpointId });
      const target = new URL(`http://127.0.0.1:${port}/`);
      if (pairCode) target.searchParams.set("pair", pairCode);
      navigating = true;
      window.location.href = target.toString();
    } catch (err) {
      console.error("iroh tunnel failed:", err);
      const errMsg = (err && err.message) ? err.message : String(err);
      setConnecting(false);
      enterFailedState(`Tunnel error: ${errMsg}`);
    } finally {
      irohConnectInFlight = false;
    }
  }

  // no-cors: cross-origin from the shell's own http://tauri.localhost to the
  // daemon (no CORS headers), so a normal fetch's response is unreadable.
  // An opaque response still REJECTS on a real network failure - enough for a liveness check.
  async function checkHealth(baseUrl, controller = new AbortController()) {
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
    setConnecting(true);
    const healthy = await checkHealth(baseUrl);
    if (healthy) {
      navigating = true;
      window.location.href = navigateTo ?? baseUrl;
      return;
    }
    setConnecting(false);
    enterFailedState(UNREACHABLE_MESSAGE);
  }

  function setConnectingStatus(text) {
    connectingStatus.textContent = text;
  }

  function setConnectingRetryText(seconds) {
    connectingRetry.hidden = false;
    connectingRetry.textContent = `Retrying in ${seconds}s…`;
  }

  function showConnectingScreen() {
    connectingScreen.hidden = false;
    connectingRetry.hidden = true;
  }

  // Reveals the setup form underneath (never hidden itself, just covered) -
  // the field already holds the stored value from init(), ready to edit.
  function showSetupScreen() {
    connectingScreen.hidden = true;
  }

  function clearRetryTimers() {
    if (countdownTimerId) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
    countdownResolve = null;
  }

  // One-second ticking wait, resolvable instantly by cancelAutoRetry via the
  // stored countdownResolve rather than waiting for the next tick.
  function countdown(seconds) {
    return new Promise((resolve) => {
      let remaining = seconds;
      countdownResolve = resolve;
      setConnectingRetryText(remaining);
      countdownTimerId = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearRetryTimers();
          resolve();
          return;
        }
        setConnectingRetryText(remaining);
      }, 1000);
    });
  }

  // The manual escape hatch: aborts any in-flight check, resolves any
  // pending backoff wait immediately, and hands control back to the form.
  function cancelAutoRetry() {
    if (retryToken) retryToken.cancelled = true;
    if (activeAbortController) activeAbortController.abort();
    if (countdownResolve) {
      const resolve = countdownResolve;
      clearRetryTimers();
      resolve();
    }
    showSetupScreen();
  }

  // Shared driver for both boot-time paths (URL health check, iroh tunnel
  // start). attemptOnce resolves true once it has kicked off navigation
  // itself, false to keep retrying. Exponential backoff 2s/4s/8s/16s/30s,
  // capped at 30s, retries forever - cancelAutoRetry is the only way out.
  async function runAutoRetryLoop(attemptOnce) {
    const token = { cancelled: false };
    retryToken = token;
    navigating = false;
    showConnectingScreen();
    let attempt = 0;
    while (!token.cancelled) {
      setConnectingStatus(attempt === 0 ? "Reaching your PC…" : "Retrying…");
      connectingRetry.hidden = true;
      const ok = await attemptOnce(token);
      if (token.cancelled || navigating) return;
      if (ok) return;
      setConnectingStatus("Can’t reach your PC.");
      attempt++;
      const delaySec = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS) / 1000;
      await countdown(delaySec);
      if (token.cancelled) return;
    }
  }

  async function attemptUrlConnect(baseUrl, navigateTo, token) {
    const controller = new AbortController();
    activeAbortController = controller;
    const healthy = await checkHealth(baseUrl, controller);
    activeAbortController = null;
    if (token.cancelled) return false;
    if (healthy) {
      navigating = true;
      window.location.href = navigateTo ?? baseUrl;
      return true;
    }
    return false;
  }

  function connectWithRetry(baseUrl, navigateTo) {
    return runAutoRetryLoop((token) => attemptUrlConnect(baseUrl, navigateTo, token));
  }

  async function attemptIrohConnect(endpointId, pairCode, token) {
    try {
      const port = await tunnelInvoke("start_iroh_tunnel", { endpointId });
      if (token.cancelled) return false;
      const target = new URL(`http://127.0.0.1:${port}/`);
      if (pairCode) target.searchParams.set("pair", pairCode);
      navigating = true;
      window.location.href = target.toString();
      return true;
    } catch (err) {
      console.error("iroh tunnel failed:", err);
      return false;
    }
  }

  // Held for the whole retry loop, not per-attempt, so a manual scan can't
  // race a second start_iroh_tunnel while boot is still retrying.
  async function connectViaIrohWithRetry(endpointId, pairCode) {
    if (irohConnectInFlight) return;
    irohConnectInFlight = true;
    try {
      await runAutoRetryLoop((token) => attemptIrohConnect(endpointId, pairCode, token));
    } finally {
      irohConnectInFlight = false;
    }
  }

  connectingCancelBtn.addEventListener("click", cancelAutoRetry);

  setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const iroh = extractIrohParams(serverUrlInput.value);
    if (iroh) {
      clearIdleError();
      activeSource = "manual";
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
          // Always fill the field with what was scanned, same as typing it in -
          // so a failure just leaves it there to see and retry, no separate state.
          serverUrlInput.value = result.content;
          const iroh = extractIrohParams(result.content);
          if (iroh) {
            clearIdleError();
            activeSource = "scan";
            await connectViaIroh(iroh.iroh, iroh.pair);
            return;
          }
          normalized = normalizeUrl(result.content);
          if (!normalized) {
            showIdleError("That QR code isn't a valid https:// server URL.");
            return;
          }
          scannedContent = result.content;
        } catch (err) {
          // scan() also rejects on user cancel ("cancelled") - not worth surfacing.
          const message = (err && err.message) ? err.message : String(err);
          if (message !== "cancelled") {
            console.error("QR scan failed:", err);
            showIdleError(`Scan error: ${message}`);
          }
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

  function getStoredIroh() {
    try {
      return localStorage.getItem(IROH_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function init() {
    const stored = getStoredUrl();
    if (stored) {
      serverUrlInput.value = stored;
      connectWithRetry(stored);
      return;
    }
    const storedIroh = getStoredIroh();
    if (storedIroh) {
      connectViaIrohWithRetry(storedIroh, null);
    }
  }

  init();
})();
