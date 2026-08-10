import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Todo 586 follow-up / commit 205b00d0: the meta-turn chips, the retracted
// placeholder and the interrupted-turn dim, rendered through the real
// chat-messages.css cascade rather than asserted as HTML strings.

const SHOTS = ".for_bepy/screenshots/31948-639219629330654291";

const ROWS = [
  { kind: "system", text: "Peer message", metaKind: "peer", metaDetail: "[repo-channel] session-b: heads up, touching pump.rs", ts: 0 },
  { kind: "system", text: "Fleet update", metaKind: "fleet", metaDetail: "[fleet] worker \"apk\" blocked on prompt 12", ts: 0 },
  { kind: "system", text: "Scheduled wake", metaKind: "wake", streakCount: 3, metaDetail: "Check the research agent.", ts: 0 },
  { kind: "message", text: "Pushed 3 commits, tests green.", ts: 0 },
  { kind: "message", text: "Committing now.", dimmed: true, ts: 0 },
  { kind: "message", text: "tests failing", retracted: true, ts: 0 },
];

async function mountChat(page) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async (rows) => {
    await import("/views/sessions/sessions.ts");
    const { renderMessage } = await import("/shared/chat/chat-transforms.ts");
    const host = document.createElement("div");
    host.id = "chip-harness";
    host.className = "chat-messages";
    host.style.cssText = "padding:16px;max-width:720px";
    host.innerHTML = rows.map((m) => renderMessage(m)).join("");
    document.body.replaceChildren(host);
  }, ROWS);
  return page.locator("#chip-harness");
}

test("meta-turn chips render as pills, one per source, payload not inline", async ({ page }) => {
  const host = await mountChat(page);

  const chips = host.locator(".meta-chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveText(/Peer message/);
  await expect(chips.nth(1)).toHaveText(/Fleet update/);
  await expect(chips.nth(2)).toHaveText(/Scheduled wake.*3/);

  // The wall-of-text this replaced: no chip may be wider than its own row.
  for (let i = 0; i < 3; i++) {
    const box = (await chips.nth(i).boundingBox())!;
    expect(box.height).toBeGreaterThan(14);
    expect(box.height).toBeLessThan(40);
    expect(box.width).toBeLessThan(320);
  }

  // Payload rides the tooltip only.
  await expect(chips.nth(0)).toHaveAttribute("title", /repo-channel/);
  await expect(chips.nth(0)).not.toHaveText(/pump\.rs/);
});

test("a retracted message collapses to a struck pill, not a bubble", async ({ page }) => {
  const host = await mountChat(page);

  const chip = host.locator(".retracted-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/Retracted/);
  await expect(chip).toHaveCSS("text-decoration-line", "line-through");

  // Must be visually smaller than the real bubble it replaced.
  const chipBox = (await chip.boundingBox())!;
  const bubbleBox = (await host.locator(".msg.assistant").first().boundingBox())!;
  expect(chipBox.width).toBeLessThan(bubbleBox.width);
});

test("an interrupted-turn bubble is dimmed but still readable", async ({ page }) => {
  const host = await mountChat(page);

  const dimmed = host.locator(".msg.assistant.dimmed");
  await expect(dimmed).toHaveCount(1);
  await expect(dimmed).toHaveText(/Committing now/);
  await expect(dimmed).toHaveCSS("opacity", "0.5");
  await expect(dimmed).toHaveCSS("font-style", "italic");

  // Still legible: dimmed, not hidden or collapsed.
  const box = (await dimmed.boundingBox())!;
  expect(box.height).toBeGreaterThan(14);

  await host.screenshot({ path: `${SHOTS}/chat-message-chips.png` });
});
