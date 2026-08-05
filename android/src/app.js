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

  async function connect(baseUrl) {
    showScreen("connecting");
    const healthy = await checkHealth(baseUrl);
    if (healthy) {
      window.location.href = baseUrl;
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
