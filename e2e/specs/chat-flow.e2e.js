// BILLED end-to-end chat-flow exercise. Drives the exact things Joe does by
// hand: full multi-message conversations on haiku, switching chat A <-> B,
// closing a chat, reopening, and sending again after all the churn. Every step
// asserts the message-count invariant AND scrapes the browser console for
// errors/warnings so silent breakage surfaces.
//
// Spawns real `claude` turns (haiku, subscription-billed, kept tiny). Run:
//   npm run test:e2e:flow
//
// Findings get written to e2e/chat-flow-findings.json for the agent to triage.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINDINGS = path.resolve(__dirname, "chat-flow-findings.json");

const findings = [];
function note(kind, detail, extra) {
  const entry = { kind, detail, ...(extra || {}) };
  findings.push(entry);
  // eslint-disable-next-line no-console
  console.log(`[finding:${kind}] ${detail}`);
}

// ── Console capture ──────────────────────────────────────────────────────────
// edgedriver's getLogs is unreliable under tauri-driver, so we install our own
// console hook in the page and drain it between steps.
async function installConsoleHook() {
  await browser.execute(() => {
    if (window.__consoleHookInstalled) return;
    window.__consoleHookInstalled = true;
    window.__consoleErrors = [];
    const wrap = (level) => {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        try {
          window.__consoleErrors.push({
            level,
            text: args.map((a) => {
              if (a instanceof Error) return a.stack || a.message;
              if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
              return String(a);
            }).join(" "),
          });
        } catch { /* ignore */ }
        orig(...args);
      };
    };
    wrap("error");
    wrap("warn");
    window.addEventListener("error", (e) => {
      window.__consoleErrors.push({ level: "uncaught", text: String(e.message || e.error) });
    });
    window.addEventListener("unhandledrejection", (e) => {
      window.__consoleErrors.push({ level: "unhandledrejection", text: String(e.reason) });
    });
  });
}

async function drainConsole(label) {
  const logs = await browser.execute(() => {
    const out = window.__consoleErrors || [];
    window.__consoleErrors = [];
    return out;
  });
  for (const l of logs) {
    // Known-noisy lines we don't care about can be filtered here.
    note("console", `[${label}] ${l.level}: ${l.text}`, { step: label, level: l.level });
  }
  return logs;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
async function msgCounts() {
  return browser.execute(() => ({
    user: document.querySelectorAll(".msg.user").length,
    assistant: document.querySelectorAll(".msg.assistant").length,
    assistantFinal: document.querySelectorAll(".msg.assistant:not(.streaming)").length,
  }));
}

async function sidebarSessionIds() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("#sessions-list li[data-session-id]"))
      .map((li) => li.getAttribute("data-session-id"))
  );
}

async function activeSessionId() {
  return browser.execute(() =>
    document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id") ?? null
  );
}

// Start a new chat picking the first project, forcing model=haiku effort=normal.
async function startHaikuChat() {
  // New chat now lives in the view-header "more options" overflow menu.
  const moreBtn = await $("#viewMoreBtn");
  await moreBtn.waitForClickable({ timeout: 15000 });
  await moreBtn.click();
  const newBtn = await $("#newSessionBtn");
  await newBtn.waitForClickable({ timeout: 15000 });
  await newBtn.click();

  const row = await $(".project-picker-row");
  await row.waitForExist({ timeout: 10000 });
  await row.click();

  // Model/effort modal: sliders are clickable stop-label buttons now, not
  // native <input type=range> (model-effort-modal.ts, impeccable session
  // 2026-08-23). Model to haiku (0); Effort lives behind "More options".
  const modelHaiku = await $('.slider-stop-label[data-kind="model"][data-idx="0"]');
  await modelHaiku.waitForExist({ timeout: 10000 });
  await modelHaiku.click();

  await (await $(".me-more-btn")).click();
  const effortMedium = await $('.slider-stop-label[data-kind="effort"][data-idx="1"]');
  await effortMedium.waitForExist({ timeout: 10000 });
  await effortMedium.click(); // "normal"
  const confirm = await $(".me-confirm");
  await confirm.waitForClickable({ timeout: 10000 });
  await confirm.click();

  await (await $(".session-composer .composer-textarea")).waitForExist({ timeout: 20000 });
}

async function sendMessage(text) {
  const ta = await $(".session-composer .composer-textarea");
  await ta.waitForExist({ timeout: 10000 });
  await ta.setValue(text);
  await (await $(".session-composer .composer-send")).click();
}

// Wait until the assistant-final count reaches `target`.
async function waitForAssistantFinal(target, timeout = 120000) {
  await browser.waitUntil(
    async () => (await msgCounts()).assistantFinal >= target,
    { timeout, interval: 1000, timeoutMsg: `assistant-final never reached ${target}` }
  );
}

describe("Full chat flow exercise (multi-message, switch, close, reopen)", () => {
  before(async () => {
    await browser.execute(() => window.showView("sessions"));
    await installConsoleHook();
  });

  after(() => {
    fs.writeFileSync(FINDINGS, JSON.stringify(findings, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n[chat-flow] ${findings.length} findings written to ${FINDINGS}`);
  });

  let aId = null;
  let bId = null;

  it("chat A: first message gets a reply", async () => {
    await startHaikuChat();
    await drainConsole("A-start");
    await sendMessage("Reply with only the word ALPHA and nothing else.");
    await waitForAssistantFinal(1);
    await drainConsole("A-msg1");

    const c = await msgCounts();
    if (c.user !== 1) note("bug", `chat A after msg1: expected 1 user msg, got ${c.user}`, { counts: c });
    if (c.assistant < 1) note("bug", `chat A after msg1: expected >=1 assistant, got ${c.assistant}`, { counts: c });

    aId = await activeSessionId();
    if (!aId) note("bug", "chat A: no active session id after first reply");
    expect(c.user).toBe(1);
  });

  it("chat A: second message in same chat (multi-turn)", async () => {
    await sendMessage("Now reply with only the word BETA and nothing else.");
    await waitForAssistantFinal(2);
    await drainConsole("A-msg2");

    const c = await msgCounts();
    if (c.user !== 2) note("bug", `chat A after msg2: expected 2 user msgs, got ${c.user}`, { counts: c });
    if (c.assistant < 2) note("bug", `chat A after msg2: expected >=2 assistant, got ${c.assistant}`, { counts: c });
    expect(c.user).toBe(2);
  });

  it("chat B: new chat, send a message", async () => {
    await startHaikuChat();
    await drainConsole("B-start");
    await sendMessage("Reply with only the word GAMMA and nothing else.");
    await waitForAssistantFinal(1);
    await drainConsole("B-msg1");

    bId = await activeSessionId();
    if (!bId) note("bug", "chat B: no active session id after first reply");
    if (bId && aId && bId === aId) note("bug", "chat B reused chat A's session id", { aId, bId });

    const c = await msgCounts();
    if (c.user !== 1) note("bug", `chat B: expected 1 user msg, got ${c.user} (leaked from A?)`, { counts: c });
    expect(c.user).toBe(1);
  });

  it("switch back to A: counts unchanged (no dup/reorder)", async () => {
    const aRow = await $(`#sessions-list li[data-session-id="${aId}"]`);
    await aRow.waitForClickable({ timeout: 15000 });
    await aRow.click();
    await browser.waitUntil(
      async () => (await msgCounts()).user === 2,
      { timeout: 20000, interval: 500, timeoutMsg: "chat A did not restore to 2 user msgs on switch-back" }
    );
    await drainConsole("switch-to-A");

    const c = await msgCounts();
    if (c.user !== 2) note("bug", `switch-back to A: expected 2 user, got ${c.user}`, { counts: c });
    if (c.assistant < 2) note("bug", `switch-back to A: expected >=2 assistant, got ${c.assistant}`, { counts: c });
    expect(c.user).toBe(2);
  });

  it("switch to B: counts intact", async () => {
    const bRow = await $(`#sessions-list li[data-session-id="${bId}"]`);
    await bRow.waitForClickable({ timeout: 15000 });
    await bRow.click();
    await browser.waitUntil(
      async () => (await msgCounts()).user === 1,
      { timeout: 20000, interval: 500, timeoutMsg: "chat B did not restore to 1 user msg" }
    );
    await drainConsole("switch-to-B");

    const c = await msgCounts();
    if (c.user !== 1) note("bug", `switch to B: expected 1 user, got ${c.user}`, { counts: c });
    expect(c.user).toBe(1);
  });

  it("close B via 3-dot menu: row disappears", async () => {
    const before = await sidebarSessionIds();
    if (!before.includes(bId)) note("bug", "B not in sidebar before close", { before, bId });

    // Open the row's 3-dot menu and click Close.
    const menuBtn = await $(`#sessions-list li[data-session-id="${bId}"] .session-row-menu-btn`);
    await menuBtn.waitForClickable({ timeout: 10000 });
    await menuBtn.click();
    // The ctx menu's last item is Close.
    const items = await $$(".session-ctx-menu .session-ctx-item");
    const closeItem = items[items.length - 1];
    if (!closeItem) {
      note("bug", "close B: no ctx-menu items rendered");
    } else {
      await closeItem.click();
    }

    await browser.waitUntil(
      async () => !(await sidebarSessionIds()).includes(bId),
      { timeout: 20000, interval: 500, timeoutMsg: "chat B row never disappeared after close" }
    ).catch(() => note("bug", "chat B row did not disappear after Close", { bId }));
    await drainConsole("close-B");

    const after = await sidebarSessionIds();
    if (after.includes(bId)) note("bug", "B still in sidebar after close", { after, bId });
  });

  it("reopen A and send a third message after all the churn", async () => {
    const aRow = await $(`#sessions-list li[data-session-id="${aId}"]`);
    await aRow.waitForClickable({ timeout: 15000 });
    await aRow.click();
    await browser.waitUntil(
      async () => (await msgCounts()).user === 2,
      { timeout: 20000, interval: 500, timeoutMsg: "chat A not restored before 3rd msg" }
    );
    await drainConsole("reopen-A");

    await sendMessage("Finally, reply with only the word DELTA and nothing else.");
    await waitForAssistantFinal(3);
    await drainConsole("A-msg3");

    const c = await msgCounts();
    if (c.user !== 3) note("bug", `chat A after msg3: expected 3 user, got ${c.user}`, { counts: c });
    if (c.assistant < 3) note("bug", `chat A after msg3: expected >=3 assistant, got ${c.assistant}`, { counts: c });
    expect(c.user).toBe(3);
  });

  it("reload the app and confirm A rehydrates without dup", async () => {
    await browser.reloadSession();
    await browser.execute(() => window.showView("sessions"));
    await installConsoleHook();
    // Last-selected restore should bring A back, or we click it.
    const aRow = await $(`#sessions-list li[data-session-id="${aId}"]`);
    await aRow.waitForExist({ timeout: 20000 });
    await aRow.click();
    await browser.waitUntil(
      async () => (await msgCounts()).assistantFinal >= 3,
      { timeout: 30000, interval: 1000, timeoutMsg: "chat A did not rehydrate to 3 replies after reload" }
    ).catch(() => note("bug", "chat A did not rehydrate to 3 replies after reload"));
    await drainConsole("reload");

    const c = await msgCounts();
    if (c.user !== 3) note("bug", `after reload: expected 3 user, got ${c.user} (dup on rehydrate?)`, { counts: c });
  });
});
