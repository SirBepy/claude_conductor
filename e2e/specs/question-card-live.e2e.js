// BILLED e2e proof (ai_todo 16, 681), two real haiku turns each on a fresh
// session: 1) builtin AskUserQuestion -> PreToolUse hook fallback card.
// 2) our pre-trusted MCP tool (c306a4b4) -> the real fire-and-forget path
// CLAUDE.md calls "the one ask channel". npm run test:e2e -- --spec e2e/specs/question-card-live.e2e.js

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
  // Sliders are clickable stop-label buttons now, not native <input
  // type=range> (model-effort-modal.ts, impeccable session 2026-08-23).
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

// Selects the option matching `optionPattern`, then submits. supportsExtras
// on both card flows (c306a4b4) makes even a lone question a two-step
// Next -> review-panel Submit. Asserts the review button's label
// ("Answer" vs "Submit"), the button-text half of the gate distinction.
async function answerSingleQuestion(optionPattern, expectedLabel) {
  await browser.execute((p) => {
    const re = new RegExp(p, "i");
    const opt = Array.from(document.querySelectorAll(".prompt-opt")).find((el) => re.test(el.textContent));
    opt?.querySelector("input")?.click();
  }, optionPattern);
  const nextLabel = await browser.execute(() => {
    document.querySelector('.prompt-card [data-act="primary"]')?.click();
    return document.querySelector('.prompt-card [data-act="primary"]')?.textContent?.trim();
  });
  assert.strictEqual(nextLabel, expectedLabel, `primary button after Next should read "${expectedLabel}", got "${nextLabel}"`);
  await browser.execute(() => document.querySelector('.prompt-card [data-act="primary"]')?.click());
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

    await answerSingleQuestion("tabs", "Answer");

    await card.waitForExist({ reverse: true, timeout: 15000, timeoutMsg: "card did not clear after answering" });
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll(".msg.assistant:not(.streaming)").length >= 1),
      { timeout: 60000, interval: 1000, timeoutMsg: "turn never resolved after answering (still hung?)" }
    );
  });

  // Closes todo 681: the only other real-process spec exercises the builtin
  // fallback, never the pre-trusted MCP tool this app actually ships.
  it("real claude turn calls the MCP ask_user_question tool directly, resolves via question-requested (not the permission gate) (todo 681)", async () => {
    // Fresh session = fresh `claude -p` process, so this IS the first-ever
    // call to our MCP tool in it - the exact path pre-trust must get right.
    await startHaikuChat();
    await installConsoleHook();
    // A no-op past its first call (module-global window.__qHook) - drain so
    // the OTHER test's leftover logs don't corrupt this test's absence check.
    await drainLogs();
    const activeBefore = await browser.execute(() => document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id"));
    await sendMessage("Call the mcp__cc_conductor__ask_user_question tool (not the built-in AskUserQuestion) to ask me whether I prefer tabs or spaces. Do nothing else but call that tool.");

    const card = await $(".prompt-card");
    let logs;
    try {
      await card.waitForExist({ timeout: 60000 });
    } catch (e) {
      logs = await drainLogs();
      const diag = await browser.execute(() => ({
        active: document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id"),
        cards: document.querySelectorAll(".prompt-card").length,
      }));
      const relevant = logs.filter((l) => /perm-relay|perm-gate/.test(l));
      throw new Error(`CARD NEVER APPEARED.\nactiveBefore=${activeBefore}\ndiag=${JSON.stringify(diag)}\nperm logs:\n${relevant.join("\n") || "<none>"}\nall logs tail:\n${logs.slice(-15).join("\n")}`);
    }

    const cardText = await card.getText();
    assert.ok(/tabs/i.test(cardText) && /spaces/i.test(cardText), `card missing options: ${cardText}`);

    // Gate-vs-fire-and-forget: handleQuestionRequested logs "...question-
    // requested"; handlePermissionRequested logs "...permission-requested".
    // A pre-trust failure trips the second assertion below and fails loudly.
    logs = await browser.execute(() => window.__qLogs || []);
    assert.ok(
      logs.some((l) => /frontend received question-requested/.test(l)),
      `expected a question-requested (fire-and-forget) log; got:\n${logs.join("\n")}`
    );
    assert.ok(
      !logs.some((l) => /frontend received permission-requested/.test(l) && /mcp__cc_conductor__ask_user_question/.test(l)),
      `card came through the permission GATE, not the fire-and-forget path:\n${logs.join("\n")}`
    );

    await answerSingleQuestion("spaces", "Submit");

    await card.waitForExist({ reverse: true, timeout: 15000, timeoutMsg: "card did not clear after answering" });

    // Real tool result: the answer lands as an <auq-answer/>-sentinel message
    // that flips the transcript's inline question-card from "pending" to
    // "answered". The gate path's deny+message never sends that sentinel, so
    // a gate-routed card times out here instead of passing.
    await browser.waitUntil(
      async () => browser.execute(() => {
        const nodes = document.querySelectorAll(".msg.question-card details.question-card-collapsible");
        return nodes[nodes.length - 1]?.getAttribute("data-resolution") === "answered";
      }),
      { timeout: 60000, interval: 1000, timeoutMsg: "inline transcript question-card never resolved to answered (stuck pending, or resolved skipped/timed-out)" }
    );
    const resolved = await browser.execute(() => {
      const nodes = document.querySelectorAll(".msg.question-card details.question-card-collapsible");
      const details = nodes[nodes.length - 1];
      return {
        resolution: details?.getAttribute("data-resolution"),
        answerText: details?.querySelector(".tool-qa-a")?.textContent?.trim(),
      };
    });
    assert.strictEqual(resolved.resolution, "answered");
    assert.ok(/spaces/i.test(resolved.answerText || ""), `resolved answer text missing "Spaces": ${resolved.answerText}`);
    assert.notStrictEqual(resolved.answerText, "User skipped the question.");
  });
});
