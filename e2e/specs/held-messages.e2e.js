// BILLED end-to-end held-messages exercise (ai_todo 90). Uses the synthetic
// `window.__setBusy` seam (main.ts, DEV-only) so the held-while-busy DOM is
// exercised without racing a real turn - Send-now and auto-flush still send
// for real. Run: npm run test:e2e:held

async function msgCounts() {
  return browser.execute(() => ({
    user: document.querySelectorAll(".msg.user").length,
    assistantFinal: document.querySelectorAll(".msg.assistant:not(.streaming)").length,
  }));
}

async function activeSessionId() {
  return browser.execute(() =>
    document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id") ?? null
  );
}

// Start a new chat picking the first project, forcing model=haiku effort=normal.
// Mirrors chat-flow.e2e.js's helper of the same name.
async function startHaikuChat() {
  const moreBtn = await $("#viewMoreBtn");
  await moreBtn.waitForClickable({ timeout: 15000 });
  await moreBtn.click();
  const newBtn = await $("#newSessionBtn");
  await newBtn.waitForClickable({ timeout: 15000 });
  await newBtn.click();

  const row = await $(".project-picker-row");
  await row.waitForExist({ timeout: 10000 });
  await row.click();

  const modelHaiku = await $('.slider-stop-label[data-kind="model"][data-idx="0"]');
  await modelHaiku.waitForExist({ timeout: 10000 });
  await modelHaiku.click();

  await (await $(".me-more-btn")).click();
  const effortMedium = await $('.slider-stop-label[data-kind="effort"][data-idx="1"]');
  await effortMedium.waitForExist({ timeout: 10000 });
  await effortMedium.click();
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

async function waitForAssistantFinal(target, timeout = 120000) {
  await browser.waitUntil(
    async () => (await msgCounts()).assistantFinal >= target,
    { timeout, interval: 1000, timeoutMsg: `assistant-final never reached ${target}` }
  );
}

async function setBusy(sessionId, busy) {
  await browser.execute((sid, b) => window.__setBusy?.(sid, b), sessionId, busy);
}

describe("Held messages while busy (ai_todo 90, synthetic busy seam)", () => {
  let sid = null;

  before(async () => {
    await browser.execute(() => window.showView("sessions"));
    await (await $("#sessions-list")).waitForExist({ timeout: 15000 });
  });

  it("start a chat and get a real reply, establishing a live session to hold against", async () => {
    await startHaikuChat();
    await sendMessage("Reply with only the word ONE and nothing else.");
    await waitForAssistantFinal(1);
    sid = await activeSessionId();
    expect(sid).toBeTruthy();
    expect(typeof window.__setBusy).not.toBe("undefined");
  });

  it("synthetic busy: typed message stages instead of sending, chip shows 1 waiting", async () => {
    const before = await msgCounts();
    await setBusy(sid, true);
    await sendMessage("first held message");
    // Give a real send a beat to prove it did NOT fire.
    await browser.pause(500);
    const after = await msgCounts();
    expect(after.user).toBe(before.user);

    const countEl = await $(".held-chip-slot .held-chip .held-count");
    await countEl.waitForExist({ timeout: 5000 });
    expect(await countEl.getText()).toBe("1");
    expect(await (await $(".held-chip-slot .held-chip")).getText()).toContain("message waiting");
  });

  it("dropdown shows the staged row; a second stage bumps the count; clearing a row drops it", async () => {
    await (await $(".held-chip-slot .held-chip")).click();
    const rows1 = await $$(".held-dropdown .held-row");
    expect(rows1.length).toBe(1);

    await sendMessage("second held message");
    const countEl = await $(".held-chip-slot .held-chip .held-count");
    await browser.waitUntil(async () => (await countEl.getText()) === "2",
      { timeout: 5000, timeoutMsg: "chip never reached 2 after second stage" });

    // Staging re-renders the dropdown (ids changed), so re-query fresh rows.
    const rows2 = await $$(".held-dropdown .held-row");
    expect(rows2.length).toBe(2);

    // Clear the first row's text: blur on an empty row removes that item.
    await browser.execute((el) => {
      el.focus();
      el.textContent = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.blur();
    }, rows2[0]);

    await browser.waitUntil(async () => (await countEl.getText()) === "1",
      { timeout: 5000, timeoutMsg: "chip never dropped to 1 after clearing a row" });
  });

  it("Send now bundles the remaining held item into ONE real message", async () => {
    const before = await msgCounts();
    await (await $(".held-chip-slot .held-send-now")).click();
    await browser.waitUntil(async () => (await msgCounts()).user === before.user + 1,
      { timeout: 10000, timeoutMsg: "Send now did not bundle into exactly one new user message" });
    await waitForAssistantFinal(before.assistantFinal + 1);

    const chipSlot = await $(".held-chip-slot");
    expect((await chipSlot.getText()).trim()).toBe("");
  });

  it("auto-flush: staged item sends on its own once busy flips back to false", async () => {
    await setBusy(sid, true);
    await sendMessage("auto flush message");
    const countEl = await $(".held-chip-slot .held-chip .held-count");
    await countEl.waitForExist({ timeout: 5000 });
    expect(await countEl.getText()).toBe("1");

    const before = await msgCounts();
    await setBusy(sid, false);
    await browser.waitUntil(async () => (await msgCounts()).user === before.user + 1,
      { timeout: 10000, timeoutMsg: "auto-flush on busy->false never sent" });
    await waitForAssistantFinal(before.assistantFinal + 1);

    const chipSlot = await $(".held-chip-slot");
    expect((await chipSlot.getText()).trim()).toBe("");
  });
});
