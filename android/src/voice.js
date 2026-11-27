// Bundled voice screens (home, recorder, recordings list). They run entirely
// off the native `ConductorVoice` bridge (docs/architecture/voice-notes.md), so
// recording and the list work with no PC, no tunnel and no network. app.js owns
// the connection and calls in through window.VoiceUi.
(() => {
  const bridge = () => window.ConductorVoice || null;

  const el = (id) => document.getElementById(id);
  const screen = el("voice-screen");
  const views = { home: el("v-home"), recorder: el("v-recorder"), list: el("v-list") };

  const STATE_LABEL = {
    saved: { text: "Saved on phone", icon: "device-mobile", tone: "neutral" },
    queued: { text: "Waiting for PC", icon: "hourglass-medium", tone: "warn" },
    uploading: { text: "Uploading", icon: "cloud-arrow-up", tone: "accent" },
    uploaded: { text: "Uploaded", icon: "check-circle", tone: "ok" },
    transcribed: { text: "Transcribed", icon: "text-aa", tone: "ok" },
    failed: { text: "Waiting for PC", icon: "warning", tone: "warn" },
    recording: { text: "Recording", icon: "microphone", tone: "accent" },
  };

  let view = "home";
  let touched = false; // any tap on a voice screen: the handoff must not pull Joe off it
  let pc = { status: "unpaired", retry: 0 };
  let pendingHandoff = null;
  let st = null; // last state()
  let rows = [];
  let tickTimer = null;
  let stateAt = 0; // performance.now() when `st` arrived, to interpolate the timer between polls

  function call(method, ...args) {
    const b = bridge();
    if (!b || typeof b[method] !== "function") return null;
    try {
      return JSON.parse(b[method](...args));
    } catch (err) {
      console.error("ConductorVoice." + method + " failed:", err);
      return null;
    }
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtWhen(ms) {
    const d = new Date(ms);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, now)) return `Today, ${time}`;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return `Yesterday, ${time}`;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  }

  function recording() {
    return !!st && (st.status === "recording" || st.status === "paused");
  }

  // The recorder's clock runs from the last polled elapsedMs so the digits move
  // every second without a bridge call per frame.
  function elapsedNow() {
    if (!st) return 0;
    if (st.status !== "recording") return st.elapsedMs || 0;
    return (st.elapsedMs || 0) + (performance.now() - stateAt);
  }

  function showView(name) {
    view = name;
    for (const [k, node] of Object.entries(views)) node.hidden = k !== name;
    screen.dataset.view = name;
    refresh();
  }

  function setScreenVisible(on) {
    screen.hidden = !on;
    if (on) {
      refresh();
      startTick();
    } else {
      stopTick();
    }
  }

  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, 250);
  }

  function stopTick() {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  let lastPoll = 0;
  function tick() {
    const now = performance.now();
    // state() is cheap, but list() reads the index file: poll the state at 1s
    // and let __ccVoiceChanged drive the list.
    if (now - lastPoll > 1000) {
      lastPoll = now;
      const before = st ? `${st.status}|${st.error}` : "";
      readState();
      // A missed __ccVoiceChanged (service stopped from its notification, or died)
      // must not leave the button on the wrong state.
      if (st && `${st.status}|${st.error}` !== before) refresh();
    }
    paintClock();
    paintMeter();
  }

  function readState() {
    const next = call("state");
    if (next) {
      st = next;
      stateAt = performance.now();
    }
  }

  function refresh() {
    readState();
    const list = call("list");
    if (Array.isArray(list)) rows = list;
    paint();
  }

  // ---- painting ----

  function paint() {
    paintPc();
    paintHome();
    paintRecorder();
    paintList();
    paintClock();
    if (window.phRender) window.phRender(screen);
  }

  const PC_TEXT = {
    connecting: "Reaching your PC…",
    offline: "PC offline",
    online: "PC connected",
    unpaired: "Not connected to a PC",
  };

  function pcLine() {
    if (pc.status === "offline" && pc.retry > 0) return `PC offline, retrying in ${pc.retry}s`;
    return PC_TEXT[pc.status] || PC_TEXT.unpaired;
  }

  function paintPc() {
    for (const chip of screen.querySelectorAll(".pc-chip")) {
      chip.dataset.pc = pc.status;
      chip.querySelector("span").textContent = pcLine();
    }
    el("home-open").hidden = !(pc.status === "online" && pendingHandoff);
    el("home-edit").textContent = pc.status === "unpaired" ? "Connect a PC" : "Edit connection";
    el("home-offline-note").hidden = pc.status === "online";
  }

  function paintHome() {
    const supported = !bridge() ? false : st ? st.supported !== false : true;
    el("home-unsupported").hidden = supported;
    el("home-mic").disabled = !supported;
    const rec = recording();
    el("home-mic-label").textContent = rec ? "Recording, tap to open" : "Record a voice note";
    el("home-mic").classList.toggle("is-recording", rec);
    el("home-mic").querySelector("i").dataset.ph = "microphone";

    const recent = rows.filter((r) => r.state !== "recording").slice(0, 3);
    el("home-recent").hidden = recent.length === 0;
    el("home-recent-list").replaceChildren(...recent.map(rowNode));
    el("home-all").textContent = `All recordings (${rows.filter((r) => r.state !== "recording").length})`;
    el("home-empty").hidden = rows.length > 0;
  }

  function paintRecorder() {
    const rec = recording();
    const paused = st && st.status === "paused";
    const btn = el("rec-btn");
    btn.classList.toggle("is-recording", rec);
    btn.setAttribute("aria-label", rec ? "Stop recording" : "Start recording");
    btn.querySelector("i").dataset.ph = rec ? "stop" : "microphone";
    btn.querySelector("i").replaceChildren();
    el("rec-label").textContent = rec ? (paused ? "Paused" : "Recording") : "Ready";
    screen.dataset.rec = rec ? (paused ? "paused" : "on") : "off";

    const err = st && st.error;
    const safe = el("rec-safe");
    safe.dataset.tone = err ? "error" : rec ? "ok" : "neutral";
    if (err) {
      safe.querySelector("p").textContent = String(err);
    } else if (paused) {
      safe.querySelector("p").textContent =
        "Paused for a call or alarm. It resumes by itself, and what you recorded is on this phone.";
    } else if (rec) {
      safe.querySelector("p").textContent =
        "Safe to lock the screen. It keeps recording and saves on this phone when you stop.";
    } else if (st && st.micPermission === false) {
      safe.querySelector("p").textContent = "Tap the button to allow the microphone, then it starts.";
    } else {
      safe.querySelector("p").textContent =
        "Tap to start. Every recording is saved on this phone the moment you stop, no PC needed.";
    }
    el("rec-dismiss").hidden = !err;
    el("rec-list").hidden = false;
  }

  function paintClock() {
    el("rec-timer").textContent = fmtClock(elapsedNow());
    const bar = el("home-banner");
    bar.hidden = !(recording() && view === "home");
    if (!bar.hidden) bar.querySelector("span").textContent = `Recording ${fmtClock(elapsedNow())}`;
  }

  const BARS = 24;
  const meterEl = el("rec-meter");
  for (let i = 0; i < BARS; i++) meterEl.appendChild(document.createElement("b"));
  let level = 0;
  const levelHistory = new Array(BARS).fill(0);
  let lastMeter = 0;

  // Uses the bridge's level() when a build has it; otherwise the bars show a
  // steady "recording is alive" pulse driven by the clock, never a fake level.
  function paintMeter() {
    if (view !== "recorder") return;
    const now = performance.now();
    if (now - lastMeter < 120) return;
    lastMeter = now;
    const live = st && st.status === "recording";
    let v = 0;
    if (live) {
      const r = call("level");
      if (r && typeof r.level === "number") v = Math.min(1, Math.max(0, r.level));
      else v = 0.25 + 0.2 * Math.sin(now / 420);
    }
    level = v;
    levelHistory.shift();
    levelHistory.push(level);
    const bars = meterEl.children;
    for (let i = 0; i < BARS; i++) {
      const h = live ? 8 + levelHistory[i] * 92 : 8;
      bars[i].style.height = `${h}%`;
    }
    meterEl.dataset.live = live ? "1" : "0";
  }

  function rowNode(r) {
    const info = STATE_LABEL[r.state] || STATE_LABEL.saved;
    const li = document.createElement("li");
    li.className = "rec-row";
    li.dataset.state = r.state;
    const pct =
      r.state === "uploading" && r.sizeBytes ? Math.min(100, Math.round(((Number(r.bytesUploaded) || 0) / r.sizeBytes) * 100)) : null;
    const meta = [r.durationMs ? fmtClock(r.durationMs) : null, fmtSize(r.sizeBytes)].filter(Boolean).join(" · ");
    li.innerHTML = `
      <div class="rec-row-main">
        <span class="rec-row-title"></span>
        <span class="rec-row-meta"></span>
      </div>
      <span class="state-badge" data-tone="${info.tone}"><i data-ph="${info.icon}"></i><span></span></span>
      ${pct !== null ? '<div class="rec-progress"><div></div></div>' : ""}
      ${r.error ? '<p class="rec-row-error"></p>' : ""}`;
    li.querySelector(".rec-row-title").textContent = fmtWhen(r.recordedAtMs);
    li.querySelector(".rec-row-meta").textContent = meta;
    li.querySelector(".state-badge span").textContent = pct !== null ? `${info.text} ${pct}%` : info.text;
    if (pct !== null) li.querySelector(".rec-progress div").style.width = pct + "%";
    if (r.error) li.querySelector(".rec-row-error").textContent = r.error;
    return li;
  }

  function paintList() {
    const done = rows.filter((r) => r.state !== "recording");
    el("list-empty").hidden = done.length > 0;
    el("list-items").replaceChildren(...done.map(rowNode));
  }

  // ---- actions ----

  function startRecording() {
    const r = call("start");
    refresh();
    if (r && r.result === "unsupported") {
      st = { ...(st || {}), supported: false };
      paint();
    }
  }

  function onRecButton() {
    touched = true;
    if (recording()) {
      call("stop");
    } else {
      startRecording();
    }
    refresh();
  }

  screen.addEventListener("pointerdown", () => {
    touched = true;
  });

  el("home-mic").addEventListener("click", () => {
    touched = true;
    showView("recorder");
    if (!recording()) startRecording();
  });
  el("home-all").addEventListener("click", () => showView("list"));
  el("home-banner").addEventListener("click", () => showView("recorder"));
  el("rec-btn").addEventListener("click", onRecButton);
  el("rec-back").addEventListener("click", () => showView("home"));
  el("rec-list").addEventListener("click", () => showView("list"));
  el("list-back").addEventListener("click", () => showView("home"));
  el("rec-dismiss").addEventListener("click", () => {
    call("dismissError");
    refresh();
  });
  el("home-open").addEventListener("click", () => {
    const go = pendingHandoff;
    pendingHandoff = null;
    if (go) go();
  });

  // Native side calls this on every recorder or index change.
  window.__ccVoiceChanged = () => {
    if (!screen.hidden) refresh();
  };

  window.VoiceUi = {
    show(name) {
      setScreenVisible(true);
      showView(name || "home");
    },
    hide() {
      pendingHandoff = null;
      setScreenVisible(false);
    },
    // Joe opened the voice screen on purpose: a connect finishing must not pull him off it.
    touch() {
      touched = true;
    },
    isShown: () => !screen.hidden,
    setPc(next) {
      pc = { ...pc, ...next };
      if (!screen.hidden) paintPc();
    },
    // True while Joe is on a voice screen he has used or a recording runs: the
    // shell must not navigate away; it offers the handoff on Home instead.
    holdsHandoff() {
      // Fresh state, not the cache: the tick only runs while the screen is shown,
      // and a recording keeps running behind a hidden screen.
      readState();
      return recording() || (!screen.hidden && (view !== "home" || touched));
    },
    offerHandoff(go) {
      pendingHandoff = go;
      pc = { ...pc, status: "online" };
      paintPc();
    },
    clearHandoff() {
      pendingHandoff = null;
    },
    view: () => view,
  };
})();
