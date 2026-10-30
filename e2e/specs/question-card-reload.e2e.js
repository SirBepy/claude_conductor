// FREE end-to-end regression for the question-card bugs that kept coming back (commits
// a1d387fe..9c3d7ad4): a card must survive a webview reload AND a daemon restart, keep its
// chat reading "input needed" while open, and never pop again once answered.
//
// Raises a REAL card the way the MCP `ask_user_question` tool does: POST
// /questions/request on the isolated test daemon's hooks server (port in
// hooks_port-wdio.txt). A fake claude (CC_CLAUDE_BIN) hosts the chat, so no billed turn.
// scripts/wdio-sweep.ps1 sets CC_CLAUDE_BIN for this spec.
//
// Each assertion names the commit whose behaviour it needs:
//  - card reopens expanded after a reload while the daemon still lists it: 9c3d7ad4
//    (answered-gate.ts / resurface.ts only drop what the transcript or the daemon says is gone)
//  - card comes back after a daemon restart: 9c3d7ad4 (state/pending_questions.rs)
//  - row reads "input needed" (registry awaiting=question) with a card open: 9c3d7ad4
//    (state/prompts.rs settled_awaiting_for overrides a turn-end "done")
//  - an answered card never re-appears after a reload, a chat switch-back, or the daemon
//    listing it again (answered elsewhere, never settled): 9c3d7ad4 (answered-gate.ts
//    transcript check, which also settles it on the daemon)
//  - the chat stops reading "input needed" once the card is answered or settled: 9c3d7ad4
//
// Run: scripts\wdio-sweep.ps1 -Spec question-card-reload

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { selectProjectRow } from "../helpers/select-project.js";

const PROJECT_NAME = path.basename(process.cwd());
const DATA_DIR = path.join(os.homedir(), "AppData", "Roaming", "claude-conductor");
const HOOKS_PORT_FILE = path.join(DATA_DIR, "hooks_port-wdio.txt");
const PENDING_FILE = path.join(DATA_DIR, "pending-questions-wdio.json");
const CARD_ID = `e2e-reload-q-${Date.now()}`;
const QUESTION = "Pick a reload-test colour?";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raises the card the way the MCP `ask_user_question` tool does. Resolves with the daemon's
 *  reply once a client confirms the render (or the 8s timeout says nobody did). */
async function postQuestion(sessionId) {
  const port = readHooksPort();
  assert.ok(port, `no hooks port file at ${HOOKS_PORT_FILE}`);
  const res = await fetch(`http://127.0.0.1:${port}/questions/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: CARD_ID,
      session_id: sessionId,
      questions: [{
        question: QUESTION, header: "Colour", multiSelect: false,
        options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }],
      }],
    }),
  });
  return res.json();
}

function readHooksPort() {
  try {
    const n = Number(fs.readFileSync(HOOKS_PORT_FILE, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function hooksHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function pendingOnDisk() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return [];
  }
}

// Same account-picker dance as reload-dup.e2e.js: 2+ accounts and no default refuses the
// first send and opens the picker.
async function pickAccountIfAsked() {
  const modalChip = await $(".cam-modal-card [data-acc-id]");
  if (await modalChip.waitForExist({ timeout: 2000 }).then(() => true, () => false)) {
    await modalChip.click();
    await (await $(".session-composer .composer-send")).click();
  }
}

async function startNewChat() {
  // The overflow menu is the user's route (reload-dup.e2e.js drives it), but after a reload the
  // menu closed again before its New chat entry became clickable, in three runs out of three. The
  // entry's own handler is bound at mount, so clicking the node directly starts the same draft.
  await browser.waitUntil(
    async () => browser.execute(() => {
      const b = document.getElementById("newSessionBtn");
      return !!b && !b.disabled;
    }),
    { timeout: 30000, interval: 500, timeoutMsg: "#newSessionBtn never got enabled" }
  );
  await browser.execute(() => document.getElementById("newSessionBtn").click());
  await selectProjectRow(PROJECT_NAME);
  await (await $(".session-composer .composer-textarea")).waitForExist({ timeout: 20000 });
}

/** The sidebar re-renders on every daemon tick, so re-query on each attempt. */
async function selectRow(sessionId) {
  await browser.waitUntil(
    async () => {
      try {
        const row = await $(`#sessions-list li[data-session-id="${sessionId}"]`);
        if (!(await row.isClickable())) return false;
        await row.click();
        return browser.execute(() => !!document.querySelector(".session-composer"));
      } catch {
        return false;
      }
    },
    { timeout: 20000, interval: 500, timeoutMsg: `row for ${sessionId} never became selectable` }
  );
}

async function activeSessionId() {
  return browser.execute(() => document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id"));
}

async function cardState() {
  return browser.execute(() => ({
    expanded: document.querySelectorAll(".prompt-card").length,
    collapsed: document.querySelectorAll(".prompt-collapsed").length,
    text: (document.querySelector(".prompt-q__text") || document.querySelector(".prompt-collapsed__q"))?.textContent || "",
  }));
}

/** waitUntil's timeoutMsg is a fixed string, so the live state goes into the thrown error. */
async function waitWithDiag(cond, diag, msg, timeout = 30000) {
  try {
    await browser.waitUntil(cond, { timeout, interval: 500 });
  } catch {
    throw new Error(`${msg}. state=${JSON.stringify(await diag())}`);
  }
}

async function waitForExpandedCard(msg, timeout = 30000) {
  await waitWithDiag(
    async () => {
      const s = await cardState();
      return s.expanded >= 1 && s.text.includes("reload-test colour");
    },
    cardState,
    msg,
    timeout
  );
}

/** The daemon's own view of the chat: registry `awaiting`. */
async function daemonAwaiting(sessionId) {
  const res = await browser.executeAsync((id, done) => {
    window.__TAURI__.core
      .invoke("list_instances")
      .then((list) => done((list || []).find((i) => i.session_id === id)?.awaiting ?? null))
      .catch((e) => done("ERR:" + String(e)));
  }, sessionId);
  return res;
}

/** The sidebar's own view: the row's status dot. `st-question` is the "input needed" dot. */
async function rowDot(sessionId) {
  return browser.execute((id) => {
    const dot = document.querySelector(`#sessions-list li[data-session-id="${id}"] .avatar-status-dot`);
    return dot ? dot.className : null;
  }, sessionId);
}

async function daemonPromptIds() {
  return browser.executeAsync((done) => {
    window.__TAURI__.core
      .invoke("list_pending_prompts")
      .then((list) => done((list || []).map((p) => p.id)))
      .catch((e) => done(["ERR:" + String(e)]));
  });
}

async function waitForInputNeeded(sessionId, msg) {
  await waitWithDiag(
    async () => (await daemonAwaiting(sessionId)) === "question" && /st-question/.test((await rowDot(sessionId)) || ""),
    async () => ({ awaiting: await daemonAwaiting(sessionId), dot: await rowDot(sessionId) }),
    msg
  );
}

async function waitForNotInputNeeded(sessionId, msg) {
  await waitWithDiag(
    async () => (await daemonAwaiting(sessionId)) !== "question" && !/st-question/.test((await rowDot(sessionId)) || ""),
    async () => ({ awaiting: await daemonAwaiting(sessionId), dot: await rowDot(sessionId) }),
    msg
  );
}

async function reloadWebview() {
  await browser.refresh();
  await browser.waitUntil(
    async () => browser.execute(() => typeof window.showView === "function" && !!window.__TAURI__?.core?.invoke).catch(() => false),
    { timeout: 30000, interval: 500, timeoutMsg: "app never finished loading after reload" }
  );
  await browser.execute(() => window.showView("sessions"));
  await (await $("#sessions-list")).waitForExist({ timeout: 15000 });
}

/** Kills the test daemon by PID and waits for the app's reconnect loop to bring up a fresh
 *  one (new ephemeral hooks port, healthy). By PID, never by name: the dev's own daemon runs
 *  the same exe. */
async function restartTestDaemon() {
  const pid = process.env.CC_WDIO_DAEMON_PID;
  assert.ok(pid, "CC_WDIO_DAEMON_PID missing: wdio.conf.js onPrepare did not export the test daemon pid");
  const oldPort = readHooksPort();
  assert.ok(oldPort, `no hooks port file at ${HOOKS_PORT_FILE}`);
  execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore" });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(800);
    const port = readHooksPort();
    if (port && port !== oldPort && (await hooksHealthy(port))) return port;
  }
  throw new Error(`test daemon did not come back with a new healthy hooks port within 60s (old port ${oldPort})`);
}

describe("Question card across reload, daemon restart and answer", () => {
  let sessionId;

  before(async () => {
    assert.ok(
      process.env.CC_CLAUDE_BIN,
      "CC_CLAUDE_BIN is not set: this spec needs the fake claude (scripts/wdio-sweep.ps1 sets it). Without it the chat would spawn a real, billed claude."
    );
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.showView === "function"),
      { timeout: 30000, interval: 500, timeoutMsg: "app never finished loading (window.showView)" }
    );
    await browser.execute(() => window.showView("sessions"));
    await (await $("#sessions-list")).waitForExist({ timeout: 15000 });
  });

  it("an open question renders expanded and the chat reads input needed", async () => {
    await startNewChat();
    await (await $(".session-composer .composer-textarea")).setValue("hello fake claude");
    await (await $(".session-composer .composer-send")).click();
    await pickAccountIfAsked();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelectorAll(".msg.assistant:not(.streaming)").length)) >= 1,
      { timeout: 60000, interval: 500, timeoutMsg: "fake claude's reply never finalized" }
    );
    sessionId = await activeSessionId();
    assert.ok(sessionId, "no active session row after the first turn");

    // The endpoint holds the response until a client confirms the render (up to 8s), so don't
    // await it before looking at the screen.
    const posted = postQuestion(sessionId);

    await waitForExpandedCard("card never rendered expanded after /questions/request");
    const ack = await posted;
    assert.strictEqual(ack.acknowledged, true, `daemon did not get a render confirmation: ${JSON.stringify(ack)}`);
    await waitForInputNeeded(sessionId, "chat does not read input needed with an open card");
    assert.ok(
      pendingOnDisk().some((p) => p.id === CARD_ID),
      `card ${CARD_ID} was not persisted to ${PENDING_FILE}`
    );
  });

  it("a reload brings the card back open and expanded", async () => {
    await reloadWebview();
    await selectRow(sessionId);
    await waitForExpandedCard("card did not reopen expanded after a webview reload");
    await waitForInputNeeded(sessionId, "chat stopped reading input needed after a reload");
  });

  it("a daemon restart keeps the card and the input needed status", async () => {
    await restartTestDaemon();
    // The hooks port is healthy a moment before the pipe the app talks over is serving and
    // the app has redialled it, so the first list_pending_prompts can land on the outage.
    await browser.waitUntil(
      async () => (await daemonPromptIds()).includes(CARD_ID),
      {
        timeout: 30000,
        interval: 500,
        timeoutMsg: "restarted daemon does not list the persisted card (pending-questions-wdio.json not restored)",
      }
    );
    // The app reconnects on its own; a reload covers the window whose poll missed the outage.
    await reloadWebview();
    await selectRow(sessionId);
    await waitForExpandedCard("card did not come back after the daemon restart");
    await waitForInputNeeded(sessionId, "chat does not read input needed after the daemon restart");
  });

  it("answering through the UI shows the answer and closes the card", async () => {
    await browser.execute(() => {
      const opt = Array.from(document.querySelectorAll(".prompt-opt")).find((el) => el.textContent.includes("Blue"));
      opt?.querySelector("input")?.click();
    });
    // A one-question card submits in a single step (question-card.e2e.js).
    await browser.execute(() => document.querySelector('.prompt-card [data-act="primary"]')?.click());
    const card = await $(".prompt-card");
    await card.waitForExist({ reverse: true, timeout: 10000, timeoutMsg: "card did not close after Submit" });
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector(".msg.user .auq-answer-chip")),
      { timeout: 30000, interval: 500, timeoutMsg: "the answer never showed in the transcript" }
    );
    await waitForNotInputNeeded(sessionId, "chat still reads input needed after the answer");
    await browser.waitUntil(
      async () => !(await daemonPromptIds()).includes(CARD_ID),
      { timeout: 15000, interval: 500, timeoutMsg: "daemon still lists the answered card" }
    );
  });

  it("an answered card never re-appears after a reload, a stale re-listing or a chat switch", async () => {
    await reloadWebview();
    await selectRow(sessionId);
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector(".msg.user .auq-answer-chip")),
      { timeout: 30000, interval: 500, timeoutMsg: "the answer never reloaded into the transcript" }
    );
    // The in-memory settled set died with the reload, so only the transcript still proves this
    // card was answered. Re-list the same card on the daemon, as if it had been answered from
    // another window or the phone and never settled there: the app must not show it again, and
    // must settle it. The post is not awaited: nobody confirms a render, so it waits out its 8s.
    const stale = postQuestion(sessionId).catch(() => null);
    await sleep(4000);
    let s = await cardState();
    assert.strictEqual(s.expanded + s.collapsed, 0, `answered card re-appeared after a stale re-listing: ${JSON.stringify(s)}`);
    await waitWithDiag(
      async () => !(await daemonPromptIds()).includes(CARD_ID),
      async () => ({ prompts: await daemonPromptIds() }),
      "the app never settled the already-answered card on the daemon",
      15000
    );
    await waitForNotInputNeeded(sessionId, "chat reads input needed after the stale re-listing");
    await stale;

    await reloadWebview();
    await selectRow(sessionId);
    await sleep(2000);
    s = await cardState();
    assert.strictEqual(s.expanded + s.collapsed, 0, `answered card re-appeared after reload: ${JSON.stringify(s)}`);

    await startNewChat();
    await selectRow(sessionId);
    await sleep(3000);
    s = await cardState();
    assert.strictEqual(s.expanded + s.collapsed, 0, `answered card re-appeared on switch-back: ${JSON.stringify(s)}`);
    await waitForNotInputNeeded(sessionId, "chat reads input needed again after switch-back");
  });
});
