// FREE end-to-end check of the chat dashboard, the view a chat window opens in by default
// (Settings > Chat defaults > Chat view). A fake claude (CC_CLAUDE_BIN) hosts the chat and answers a
// message containing DASH_ANSWER with a send_message answer card, so no billed turn runs.
// scripts/wdio-sweep.ps1 sets CC_CLAUDE_BIN for this spec.
//
// The daily flow: send a question, see it under the title, read the answer in the Answers card,
// check it off with Got it (All caught up), and find it again in History. The transcript keeps
// rendering underneath, hidden, which is what the other chat specs count rows in.
//
// Run: scripts\wdio-sweep.ps1 -Spec chat-dashboard

import path from "node:path";
import { selectProjectRow } from "../helpers/select-project.js";
import { openNewChatPicker, turnSubchatsOff } from "../helpers/new-chat.js";

const PROJECT_NAME = path.basename(process.cwd());
const QUESTION = "DASH_ANSWER does the dashboard show this answer?";

// 2+ accounts with no default/binding: the first send is refused and the account picker
// opens. Pick the first chip and resend (same as reload-dup).
async function pickAccountIfAsked() {
  const modalChip = await $(".cam-modal-card [data-acc-id]");
  if (await modalChip.waitForExist({ timeout: 2000 }).then(() => true, () => false)) {
    await modalChip.click();
    await (await $(".session-composer .composer-send")).click();
  }
}

const text = (sel) => browser.execute((s) => document.querySelector(s)?.textContent ?? null, sel);

describe("Chat dashboard (default view)", () => {
  it("shows Joe's question, the answer card, Got it and History for a fresh chat", async () => {
    await browser.execute(() => window.showView("sessions"));

    await openNewChatPicker();
    await selectProjectRow(PROJECT_NAME);

    const ta = await $(".session-composer .composer-textarea");
    await ta.waitForExist({ timeout: 20000 });
    // A subchats chat spawns with the long main-chat system prompt, which the fake's claude.cmd
    // shim cannot take (cmd.exe's 8191-character line limit: the spawn fails and the chat
    // never starts). The dashboard draws the same either way.
    await turnSubchatsOff();
    await ta.setValue(QUESTION);
    await (await $(".session-composer .composer-send")).click();
    await pickAccountIfAsked();

    // The dashboard is what a chat opens in, with no setting touched.
    await browser.waitUntil(async () => (await $(".session-pane[data-chat-view='dashboard'] .cdash")).isExisting(), {
      timeout: 30000,
      timeoutMsg: "the chat did not open as a dashboard",
    });
    // Joe's message sits under the title.
    await browser.waitUntil(async () => ((await text(".cdash-strip-msg")) ?? "").includes("does the dashboard show this answer"), {
      timeout: 30000,
      timeoutMsg: "Joe's message never reached the dashboard's strip",
    });
    // The answer lands in the Answers card, unread.
    await browser.waitUntil(async () => (await text(".cdash-answers .ax-face .mc-verdict")) === "Dashboard answer verdict", {
      timeout: 60000,
      interval: 500,
      timeoutMsg: "the answer card never showed in the Answers card",
    });
    // The transcript still builds underneath, hidden, so row counts elsewhere hold.
    const hidden = await browser.execute(() => {
      const el = document.querySelector(".session-pane[data-chat-view='dashboard'] .session-messages");
      return el ? getComputedStyle(el).display : null;
    });
    if (hidden !== "none") throw new Error(`the transcript should be hidden under the dashboard, display was ${hidden}`);

    // Got it walks to All caught up and the card stays reachable through History.
    await (await $(".cdash-answers [data-ax='gotit']")).click();
    await browser.waitUntil(async () => (await $(".cdash-answers .ax-cc")).isExisting(), {
      timeout: 10000,
      timeoutMsg: "Got it never led to All caught up",
    });
    await (await $(".cdash-answers [data-ax='history']")).click();
    await browser.waitUntil(async () => (await $$(".cp-row")).length > 0, {
      timeout: 10000,
      timeoutMsg: "History listed no answer",
    });
    await browser.keys(["Escape"]);
  });
});
