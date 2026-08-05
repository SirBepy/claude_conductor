(() => {
  const STORAGE_KEY = "conductor_server_url";
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

  async function checkHealth(baseUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(baseUrl + "/api/health", {
        signal: controller.signal,
        cache: "no-store",
      });
      return res.ok;
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

  // Scans the same pairing QR the desktop's Settings > Remote access tab
  // shows (https://host/?pair=CODE) - connect() carries the full URL through
  // so the SPA auto-exchanges the code instead of the user re-pairing by hand.
  if (!window.__TAURI__?.barcodeScanner) {
    scanQrBtn.hidden = true;
  } else {
    scanQrBtn.addEventListener("click", () => {
      void (async () => {
        const { barcodeScanner } = window.__TAURI__;
        scanQrBtn.disabled = true;
        try {
          let state = await barcodeScanner.checkPermissions();
          if (state !== "granted") state = await barcodeScanner.requestPermissions();
          if (state !== "granted") {
            setupError.textContent = "Camera permission denied - enable it in app settings.";
            setupError.hidden = false;
            return;
          }
          const result = await barcodeScanner.scan({ windowed: true, formats: [barcodeScanner.Format.QRCode] });
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
