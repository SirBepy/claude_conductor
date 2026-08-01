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

const SESS = "e2e-question-session";
const QUESTION = "Tabs or spaces for indentation?";

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
    await installConsoleHook();
  });

  it("renders an answerable card for a matching selected session", async () => {
    await browser.execute((sess) => window.__setSelectedSession(sess), SESS);
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

  it("selecting an option + Next + submit clears the card", async () => {
    await browser.execute(() => {
      const opt = Array.from(document.querySelectorAll(".prompt-opt")).find((el) => el.textContent.includes("Tabs"));
      opt?.querySelector("input")?.click();
    });
    // showQuestionCard always sets supportsExtras, so even a single question
    // gets a review panel - the footer button is Next here, Submit only on review.
    await browser.execute(() => document.querySelector('.prompt-card [data-act="primary"]')?.click());
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelector(".prompt-panel.is-active .prompt-summary") !== null),
      { timeout: 5000, timeoutMsg: "never reached the review panel" }
    );
    await browser.execute(() => document.querySelector('.prompt-card [data-act="primary"]')?.click());
    const card = await $(".prompt-card");
    await card.waitForExist({ reverse: true, timeout: 8000 }).catch(() => {});
    assert.ok(!(await card.isExisting()), "card did not clear after submit");
  });

  // Joe's bug was in the chats window (chatswindow=1 branch of main.ts). Rather
  // than open a 2nd OS window (tauri-driver can't drive a 2nd Tauri webview),
  // reload THIS window into chats-window mode so the same code path runs here.
  it("renders a card in chats-window mode too", async () => {
    await browser.execute(() => { window.location.href = window.location.origin + "/index.html?chatswindow=1#sessions"; });
    await browser.waitUntil(
      async () => browser.execute(() => document.body.classList.contains("chats-window-mode") && typeof window.__injectQuestion === "function"),
      { timeout: 15000, timeoutMsg: "chats-window-mode never initialized after navigate" }
    );
    await installConsoleHook();

    await browser.execute((s) => window.__setSelectedSession(s), "chats-sess");
    await browser.execute((s) => window.__injectQuestion({
      id: "cq1", session_id: s,
      questions: [{ question: "Chats window card?", header: "H", multiSelect: false,
        options: [{ label: "Yes", description: "y" }, { label: "No", description: "n" }] }],
    }), "chats-sess");
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
    assert.ok(diag.cards >= 1, `NO CARD in chats-window mode. diag=${JSON.stringify(diag)}\nlogs=${logs.join("\n")}`);
  });
});
