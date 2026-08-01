// BILLED end-to-end proof for the AskUserQuestion card relay (ai_todo 16).
// Starts a real haiku chat, sends a prompt that makes claude call the builtin
// AskUserQuestion tool, and asserts the FULL real path: claude -> PreToolUse
// curl hook -> daemon /hooks/ask-question -> question_request -> the chat card
// renders -> answering -> respond_question -> deny reason -> claude continues.
//
// Subscription-billed (one tiny haiku turn). Run:
//   npm run test:e2e -- --spec e2e/specs/question-card-live.e2e.js

import assert from "node:assert";

async function installConsoleHook() {
  await browser.execute(() => {
    if (window.__qHook) return;
    window.__qHook = true; window.__qLogs = [];
    for (const lvl of ["info", "warn", "error"]) {
      const orig = console[lvl].bind(console);
      console[lvl] = (...a) => { try { window.__qLogs.push(`${lvl}: ${a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")}`); } catch {} orig(...a); };
    }
  });
}
async function drainLogs() {
  return browser.execute(() => { const o = window.__qLogs || []; window.__qLogs = []; return o; });
}
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
  await (await $(".me-model-slider")).waitForExist({ timeout: 10000 });
  await browser.execute(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); } };
    set(".me-model-slider", 0); set(".me-effort-slider", 1);
  });
  const confirm = await $(".me-confirm");
  await confirm.waitForClickable({ timeout: 10000 });
  await confirm.click();
  await (await $(".composer-textarea")).waitForExist({ timeout: 20000 });
}
async function sendMessage(text) {
  const ta = await $(".composer-textarea");
  await ta.waitForExist({ timeout: 10000 });
  await ta.setValue(text);
  await (await $(".composer-send")).click();
}

describe("AskUserQuestion full real-path (BILLED)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.showView === "function"),
      { timeout: 30000, interval: 500, timeoutMsg: "app never finished loading (window.showView)" }
    );
    await browser.execute(() => window.showView("sessions"));
  });

  it("real claude turn surfaces an answerable card and resolves on answer", async () => {
    await startHaikuChat();
    await installConsoleHook();
    const activeBefore = await browser.execute(() => document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id"));
    await sendMessage("Use the AskUserQuestion tool to ask me whether I prefer tabs or spaces. Do nothing else but call that tool.");

    const card = await $(".prompt-card");
    try {
      await card.waitForExist({ timeout: 60000 });
    } catch (e) {
      const logs = await drainLogs();
      const diag = await browser.execute(() => ({
        active: document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id"),
        cards: document.querySelectorAll(".prompt-card").length,
      }));
      const relevant = logs.filter((l) => /perm-relay|perm-gate/.test(l));
      throw new Error(`CARD NEVER APPEARED.\nactiveBefore=${activeBefore}\ndiag=${JSON.stringify(diag)}\nperm logs:\n${relevant.join("\n") || "<none>"}\nall logs tail:\n${logs.slice(-15).join("\n")}`);
    }

    const cardText = await card.getText();
    assert.ok(/tabs/i.test(cardText) && /spaces/i.test(cardText), `card missing options: ${cardText}`);

    await browser.execute(() => {
      const opt = Array.from(document.querySelectorAll(".prompt-opt")).find((el) => /tabs/i.test(el.textContent));
      opt?.querySelector("input")?.click();
    });
    // This built-in-tool flow (showPermissionCard) never sets supportsExtras, and
    // it's a single question, so there's no review panel - the footer's one
    // primary button is Submit directly on this question.
    await browser.execute(() => document.querySelector('.prompt-card [data-act="primary"]')?.click());

    await card.waitForExist({ reverse: true, timeout: 15000, timeoutMsg: "card did not clear after answering" });
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll(".msg.assistant:not(.streaming)").length >= 1),
      { timeout: 60000, interval: 1000, timeoutMsg: "turn never resolved after answering (still hung?)" }
    );
  });
});
