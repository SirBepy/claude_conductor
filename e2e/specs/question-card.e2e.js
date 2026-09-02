// Frontend-hop e2e for the AskUserQuestion card relay (ai_todo 16).
//
// Drives the REAL `question-requested` Tauri event -> installed listener -> gate
// (isForSelectedSession) -> showQuestionCard, via the dev-only __injectQuestion /
// __setSelectedSession seams. NO billed claude turn, no daemon question relay -
// this isolates the one unproven hop: does a matching question render an
// answerable card in this window, and does answering clear it.
//
// Run: npm run test:e2e -- --spec e2e/specs/question-card.e2e.js

import assert from "node:assert";

const SESS = `e2e-question-session-${Date.now()}`;
const QUESTION = "Tabs or spaces for indentation?";

/** `__setSelectedSession` only primes the modal's private `_selectedSessionId`
 *  (gating.ts:76-78), never `state.selectedId` - so `.session-composer` never
 *  mounts and `refreshPaneEmptyState()` wipes the injected host on the next
 *  daemon tick. Select through the real sidebar flow instead. */
async function seedAndSelect(sessionId) {
  const seeded = await browser.executeAsync((id, cwd, done) => {
    window.__TAURI__.core
      .invoke("register_historical_session", { sessionId: id, cwd, accountId: "e2e-seeded-account" })
      .then(() => done("ok"))
      .catch((e) => done("ERR:" + String(e)));
  }, sessionId, process.cwd());
  if (String(seeded).startsWith("ERR")) throw new Error(`register_historical_session failed: ${seeded}`);

  await (await $(`#sessions-list li[data-session-id="${sessionId}"]`)).waitForExist({ timeout: 15000 });
  // Re-query and retry: the sidebar re-renders on every daemon tick.
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

async function installConsoleHook() {
  await browser.execute(() => {
    if (window.__qHook) return;
    window.__qHook = true;
    window.__qLogs = [];
    for (const lvl of ["info", "warn", "error"]) {
      const orig = console[lvl].bind(console);
      console[lvl] = (...a) => {
        try { window.__qLogs.push(`${lvl}: ${a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")}`); } catch {}
        orig(...a);
      };
    }
  });
}
async function drainLogs() {
  return browser.execute(() => { const o = window.__qLogs || []; window.__qLogs = []; return o; });
}

describe("AskUserQuestion card relay (frontend hop)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.showView === "function"),
      { timeout: 30000, interval: 500, timeoutMsg: "app never finished loading (window.showView)" }
    );
    await browser.execute(() => window.showView("sessions"));
    await (await $("#sessions-list")).waitForExist({ timeout: 15000 });
    await seedAndSelect(SESS);
    await installConsoleHook();
  });

  after(async () => {
    await clearSession(SESS);
  });

  it("renders an answerable card for a matching selected session", async () => {
    await browser.execute((sess, q) => window.__injectQuestion({
      id: "e2e-q1",
      session_id: sess,
      questions: [{
        question: q, header: "Style", multiSelect: false,
        options: [{ label: "Tabs", description: "tab chars" }, { label: "Spaces", description: "space chars" }],
      }],
    }), SESS, QUESTION);

    await browser.pause(1500);
    const diag = await browser.execute(() => ({
      seams: { inject: typeof window.__injectQuestion, select: typeof window.__setSelectedSession },
      cards: document.querySelectorAll(".prompt-card").length,
      hostHtml: (document.getElementById("prompt-card-host")?.outerHTML || "<none>").slice(0, 800),
      questionText: document.querySelector(".prompt-q__text")?.textContent || "<none>",
    }));
    const logs = await drainLogs();
    // eslint-disable-next-line no-console
    console.log("\n=== DIAG ===\n" + JSON.stringify(diag, null, 2) + "\n=== CONSOLE ===\n" + logs.join("\n") + "\n=== END ===\n");
    assert.ok(diag.cards >= 1, `NO CARD. diag=${JSON.stringify(diag)}\nlogs=${logs.join("\n")}`);
    assert.ok(
      diag.questionText.includes("Tabs or spaces") || diag.hostHtml.includes("Tabs"),
      `card has no question. diag=${JSON.stringify(diag)}\nlogs=${logs.join("\n")}`
    );
  });

  it("selecting an option + submit clears the card", async () => {
    await browser.execute(() => {
      const opt = Array.from(document.querySelectorAll(".prompt-opt")).find((el) => el.textContent.includes("Tabs"));
      opt?.querySelector("input")?.click();
    });
    // A one-question card submits in a single step (ai_todo 821); only two or
    // more questions get a review panel.
    await browser.execute(() => document.querySelector('.prompt-card [data-act="primary"]')?.click());
    const card = await $(".prompt-card");
    await card.waitForExist({ reverse: true, timeout: 8000 }).catch(() => {});
    assert.ok(!(await card.isExisting()), "card did not clear after submit");
  });

  // The bug lived in the chats window, a separate module realm with its own
  // listeners and `state.selectedId`. The debug binary opens it at startup
  // (bootstrap.rs:29-31), so drive the REAL one by its own handle.
  it("renders a card in chats-window mode too", async () => {
    const mainHandle = await browser.getWindowHandle();
    let chatsHandle = null;
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      const isChats = await browser
        .execute(() => location.search.includes("chatswindow"))
        .catch(() => false);
      if (isChats) { chatsHandle = handle; break; }
    }
    assert.ok(chatsHandle, "no chats window handle found");

    await browser.waitUntil(
      async () => browser.execute(() => document.body.classList.contains("chats-window-mode") && typeof window.__injectQuestion === "function"),
      { timeout: 15000, timeoutMsg: "chats window never finished loading" }
    );
    await installConsoleHook();
    // Same real-selection flow; this window has its own selection state.
    await browser.waitUntil(
      async () => {
        await (await $(`#sessions-list li[data-session-id="${SESS}"]`)).click().catch(() => {});
        return browser.execute(() => !!document.querySelector(".session-composer"));
      },
      { timeout: 20000, interval: 1000, timeoutMsg: "chats window never mounted the seeded session" }
    );

    await browser.execute((s) => window.__injectQuestion({
      id: "cq1", session_id: s,
      questions: [{ question: "Chats window card?", header: "H", multiSelect: false,
        options: [{ label: "Yes", description: "y" }, { label: "No", description: "n" }] }],
    }), SESS);
    await browser.pause(1500);

    const diag = await browser.execute(() => ({
      chatsMode: document.body.classList.contains("chats-window-mode"),
      seams: typeof window.__injectQuestion,
      cards: document.querySelectorAll(".prompt-card").length,
      q: document.querySelector(".prompt-q__text")?.textContent || "<none>",
    }));
    const logs = await drainLogs();
    // eslint-disable-next-line no-console
    console.log("\n=== CHATS DIAG ===\n" + JSON.stringify(diag, null, 2) + "\n=== CHATS CONSOLE ===\n" + logs.join("\n") + "\n=== END ===\n");
    await browser.switchToWindow(mainHandle);
    assert.ok(diag.cards >= 1, `NO CARD in chats-window mode. diag=${JSON.stringify(diag)}\nlogs=${logs.join("\n")}`);
  });
});
