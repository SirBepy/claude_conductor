// ZERO-COST client-side held-messages exercise (ai_todo 90, narrowed
// 2026-09-01: option (c), no billed runs). Seeds a historical session (no
// live daemon process) and intercepts send_message/cancel_turn so the
// assembled payload is asserted without ever reaching the daemon.

const SESS = `e2e-held-session-${Date.now()}`;

async function msgCounts() {
  return browser.execute(() => ({
    user: document.querySelectorAll(".msg.user").length,
  }));
}

async function seedAndSelect(sessionId) {
  const seeded = await browser.executeAsync((id, cwd, done) => {
    window.__TAURI__.core
      .invoke("register_historical_session", { sessionId: id, cwd, accountId: "e2e-seeded-account" })
      .then(() => done("ok"))
      .catch((e) => done("ERR:" + String(e)));
  }, sessionId, process.cwd());
  if (String(seeded).startsWith("ERR")) throw new Error(`register_historical_session failed: ${seeded}`);

  await (await $(`#sessions-list li[data-session-id="${sessionId}"]`)).waitForExist({ timeout: 15000 });
  await browser.waitUntil(
    async () => {
      await (await $(`#sessions-list li[data-session-id="${sessionId}"]`)).click().catch(() => {});
      return browser.execute(() => !!document.querySelector(".session-composer"));
    },
    { timeout: 20000, interval: 1000, timeoutMsg: "seeded session never mounted its composer" }
  );
}

async function clearSession(sessionId) {
  await browser.execute(async (id) => {
    try { await window.__TAURI__.core.invoke("clear_session", { sessionId: id }); } catch { /* best effort */ }
  }, sessionId);
}

// Wraps invoke so "send_message"/"cancel_turn" never reach the daemon: their
// args are recorded on window.__heldCalls and the call resolves immediately
// with no real send. Everything else passes through unchanged.
async function installInvokeIntercept() {
  await browser.execute(() => {
    if (window.__heldCalls) return;
    window.__heldCalls = [];
    const real = window.__TAURI__.core.invoke;
    // Replace `core` with a fresh object rather than mutating `invoke` in
    // place: Tauri defines it non-writable, so `core.invoke = wrapped` fails
    // silently and every call keeps reaching the real backend.
    window.__TAURI__.core = {
      ...window.__TAURI__.core,
      invoke: (cmd, args) => {
        if (cmd === "send_message" || cmd === "cancel_turn") {
          window.__heldCalls.push({ cmd, args });
          return Promise.resolve();
        }
        return real(cmd, args);
      },
    };
  });
}

async function drainCalls() {
  return browser.execute(() => { const c = window.__heldCalls || []; window.__heldCalls = []; return c; });
}

async function drainCallsPeek() {
  return browser.execute(() => (window.__heldCalls || []).length);
}

async function stage(text) {
  const ta = await $(".session-composer .composer-textarea");
  await ta.waitForExist({ timeout: 10000 });
  await ta.setValue(text);
  await (await $(".session-composer .composer-send")).click();
}

async function setBusy(sessionId, busy) {
  await browser.execute((sid, b) => window.__setBusy?.(sid, b), sessionId, busy);
}

describe("Held messages while busy (ai_todo 90, client-side only, no billed send)", () => {
  before(async () => {
    await browser.execute(() => window.showView("sessions"));
    await (await $("#sessions-list")).waitForExist({ timeout: 15000 });
    await seedAndSelect(SESS);
    await installInvokeIntercept();
    const setBusyType = await browser.execute(() => typeof window.__setBusy);
    expect(setBusyType).not.toBe("undefined");
  });

  after(async () => {
    await clearSession(SESS);
  });

  it("synthetic busy: typed message stages instead of sending, chip shows 1 waiting", async () => {
    const before = await msgCounts();
    await setBusy(SESS, true);
    await stage("first held message");
    // Give a real send a beat to prove it did NOT fire.
    await browser.pause(500);
    const after = await msgCounts();
    expect(after.user).toBe(before.user);
    expect((await drainCalls()).length).toBe(0);

    const countEl = await $(".held-chip-slot .held-chip .held-count");
    await countEl.waitForExist({ timeout: 5000 });
    expect(await countEl.getText()).toBe("1");
    expect(await (await $(".held-chip-slot .held-chip")).getText()).toContain("message waiting");
  });

  it("dropdown shows the staged row; a second stage bumps the count; clearing a row drops it", async () => {
    await (await $(".held-chip-slot .held-chip")).click();
    const rows1 = await $$(".held-dropdown .held-row");
    expect(rows1.length).toBe(1);

    // A periodic instances-refresh can overwrite the synthetic busy flag with
    // the daemon's real (idle) state between UI interactions - reassert it
    // right before staging so this doesn't flush early via flushHeldWithDraft.
    await setBusy(SESS, true);
    await stage("second held message");
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

  it("Send now assembles the remaining held item into ONE payload without sending it", async () => {
    const before = await msgCounts();
    await (await $(".held-chip-slot .held-send-now")).click();

    await browser.waitUntil(async () => (await drainCallsPeek()) > 0,
      { timeout: 5000, timeoutMsg: "Send now never reached the intercepted invoke" });
    const calls = await drainCalls();
    const sendCall = calls.find((c) => c.cmd === "send_message");
    expect(sendCall).toBeTruthy();
    expect(sendCall.args.sessionId).toBe(SESS);
    expect(sendCall.args.blocks).toEqual([{ type: "text", text: "second held message" }]);

    // sendBundle renders its optimistic .msg.user bubble client-side BEFORE
    // the (intercepted) invoke - that's the real DOM wiring this test guards.
    // The interceptor only stops the network hop the bubble would trigger.
    const after = await msgCounts();
    expect(after.user).toBe(before.user + 1);

    const chipSlot = await $(".held-chip-slot");
    expect((await chipSlot.getText()).trim()).toBe("");
  });

  it("auto-flush: staged item assembles its payload on its own once busy flips back to false", async () => {
    await setBusy(SESS, true);
    await stage("auto flush message");
    const countEl = await $(".held-chip-slot .held-chip .held-count");
    await countEl.waitForExist({ timeout: 5000 });
    expect(await countEl.getText()).toBe("1");

    await drainCalls();
    const before = await msgCounts();
    await setBusy(SESS, false);

    await browser.waitUntil(async () => (await drainCallsPeek()) > 0,
      { timeout: 5000, timeoutMsg: "auto-flush on busy->false never reached the intercepted invoke" });
    const calls = await drainCalls();
    const sendCall = calls.find((c) => c.cmd === "send_message");
    expect(sendCall).toBeTruthy();
    expect(sendCall.args.blocks).toEqual([{ type: "text", text: "auto flush message" }]);

    // Same optimistic-bubble-then-intercepted-invoke shape as Send now.
    const after = await msgCounts();
    expect(after.user).toBe(before.user + 1);

    const chipSlot = await $(".held-chip-slot");
    expect((await chipSlot.getText()).trim()).toBe("");
  });
});
