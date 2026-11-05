// Reviewed 2026-11-05: chat-message-cards.css gained the .passed-row rule only; no card rule changed - this spec's contract is unchanged and it passes.
// asserts: src/shared/chat/subchat-cards.ts, src/shared/chat/chat-subchat-card.ts, src/shared/chat/chat-message-cards.css, src/views/sessions/permission-modal/question-submit.ts, src/views/sessions/permission-modal/question-ui-answer-bar.ts, src/views/sessions/permission-modal/question-ui-templates.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A sub's card in its main chat, through the real renderer and the real chat CSS:
// tagged with the sub's name, fact chips that open to words, unknown shown as
// unknown, cards kept in time order across a reload and an older page, old ones
// shrunk by their own rule, one "all finished" card, the final-stamp question
// card, and a daemon card that has no free-text box and posts nothing to the chat
// it shows in. Desktop width and phone width (390px).

const SESSION = sessionInstance({ name: "Main" });
const SID = SESSION.session_id;
const CHANNEL = `chat:${SID}`;
const SEND = "mcp__cc_conductor__send_message";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

const say = (id: string, ts: number, text: string) => ({
  type: "tool_use", tool_name: SEND, input: { kind: "report", verdict: "Done", text, done: ["x"] }, id, timestamp: ts, parent_tool_use_id: null,
});
const user = (text: string, ts: number) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: ts });

const facts = (over: Record<string, unknown> = {}) => ({
  since: "spawn", commits: 2, files_changed: 3, insertions: 10, deletions: 1, scoped: true,
  uncommitted: 0, uncommitted_files: [], pushed: false,
  test: { state: "passed", command: "cargo test --lib", summary: "test result: ok. 4 passed", stale: false },
  reviewer: { state: "ran", text: "Found 1 problem, fixed." }, head: "abc", ...over,
});
const card = (id: string, ts: number, over: Record<string, unknown> = {}) => ({
  id, ts, parent_id: SID, kind: "finish", sub_id: "sub-header", sub_name: "Header", round: 1,
  verdict: "Built, not pushed", tone: null, text: `Report ${id}`, points: [], done: ["Header built"], not_done: [], waiting_on: [], your_move: [],
  facts: facts(), sum: null, set_key: null, ...over,
});
const sum = { subs: 3, commits: 5, files_changed: 12, uncommitted: 0, unpushed: 1, tests_passed: 2, tests_failed: 0, tests_unknown: 1, reviewed: 1, unreviewed: 2, unknown_subs: 0 };
const allFinished = (id: string, ts: number) => ({
  id, ts, parent_id: SID, kind: "all_finished", sub_id: null, sub_name: null, round: null, verdict: "All 3 subs finished", tone: null,
  text: "5 commits, 12 files changed, tests 2 passed, 1 unknown, 1 not pushed", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum, set_key: "k",
});

const page1 = [user("redesign the CV", T0), say("m1", T0 + MIN, "Started 3 subs"), user("how is it going", T0 + 40 * MIN), say("m2", T0 + 41 * MIN, "Waiting on the footer")];

async function mountChat(page: Page, width: number, events: unknown[], cards: unknown[], olderPage?: unknown[]): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events, oldest_seq: 10, newest_seq: events.length, has_more: olderPage !== undefined },
      list_subchat_cards: cards,
    },
  });
  if (olderPage) {
    // Installed before the chat opens: with an older page left, the top sentinel
    // fetches it as soon as the chat is on screen.
    await page.evaluate((older) => {
      const core = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: { beforeSeq?: number }) => Promise<unknown> } } }).__TAURI__.core;
      const orig = core.invoke;
      core.invoke = (cmd, args) => (cmd === "load_history_page" && args?.beforeSeq !== undefined
        ? Promise.resolve({ events: older, oldest_seq: 1, newest_seq: 5, has_more: false })
        : orig(cmd, args));
    }, olderPage);
  }
  await page.locator(`#sessions-list li[data-session-id="${SID}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const chat = (page: Page) => page.locator("#session-pane .session-messages");
const heads = (page: Page) =>
  chat(page).locator(".msg.mc-root").evaluateAll((els) => els.map((e) => (e.querySelector(".mc-full .mc-head, .mc-full .mc-verdict") as HTMLElement | null)?.textContent?.trim() ?? ""));

async function expectNoOverflow(page: Page): Promise<void> {
  const over = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>("#session-pane .session-messages")!;
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    if (host.scrollWidth > host.clientWidth + 1) bad.push(`host ${host.scrollWidth}>${host.clientWidth}`);
    for (const el of host.querySelectorAll<HTMLElement>(".mc-root, .mc-root *")) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) bad.push(`${el.className || el.tagName} right ${Math.round(r.right)}>${vw}`);
    }
    return bad;
  });
  expect(over).toEqual([]);
}

for (const vp of [{ name: "desktop", width: 900 }, { name: "phone", width: 390 }]) {
  test.describe(`sub cards at ${vp.name} width`, () => {
    test("a sub's card shows tagged with its name, and its chips open to words", async ({ page }) => {
      await mountChat(page, vp.width, page1, [card("c1", T0 + 50 * MIN)]);
      const sub = chat(page).locator('.mc-root[data-sub-card="1"]');
      await expect(sub).toHaveCount(1);
      await expect(sub.locator(".mc-full .mc-sub-name")).toHaveText("Header");
      await expect(sub.locator(".mc-full .mc-verdict")).toHaveText("Built, not pushed");
      const summary = sub.locator(".mc-full .mc-facts > summary");
      expect((await summary.innerText()).replace(/\s+/g, " ").trim()).toBe("2 3 0 passed ran not pushed");
      await expect(sub.locator(".mc-full .mc-facts-list")).toBeHidden();
      await capture(chat(page), `subcards-closed-${vp.name}`);

      await summary.click();
      const words = sub.locator(".mc-full .mc-facts-list");
      await expect(words).toBeVisible();
      await expect(words).toContainText("2 commits since it started");
      await expect(words).toContainText("cargo test --lib");
      await expect(words).toContainText("Not pushed");
      await expectNoOverflow(page);
      await capture(chat(page), `subcards-open-${vp.name}`);
    });

    test("anything the daemon could not read shows as unknown", async ({ page }) => {
      const unknown = card("c2", T0 + 20 * MIN, { facts: facts({
        commits: null, files_changed: null, uncommitted: null, pushed: null, test: { state: "unknown" }, reviewer: { state: "none", note: "no reviewer ran" },
      }) });
      await mountChat(page, vp.width, page1, [{ ...unknown, ts: T0 + 50 * MIN }]);
      const summary = chat(page).locator(".mc-root[data-sub-card] .mc-full .mc-facts > summary");
      expect((await summary.innerText()).replace(/\s+/g, " ").trim()).toBe("? ? ? unknown none");
      await summary.click();
      await expect(chat(page).locator(".mc-root[data-sub-card] .mc-full .mc-facts-list")).toContainText("Last test run: unknown");
      await capture(chat(page), `subcards-unknown-${vp.name}`);
    });

    test("cards stay in time order with the main chat's messages after a reload", async ({ page }) => {
      const cards = [card("c1", T0 + 20 * MIN, { text: "Between" }), card("c2", T0 + 50 * MIN, { text: "After everything" })];
      await mountChat(page, vp.width, page1, cards);
      expect((await heads(page)).filter(Boolean)).toHaveLength(4);
      const order = await chat(page).locator(".msg.mc-root").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subCard ? "sub" : "main"));
      expect(order).toEqual(["main", "sub", "main", "sub"]);
      await page.reload();
      await mountChat(page, vp.width, page1, cards);
      const again = await chat(page).locator(".msg.mc-root").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subCard ? "sub" : "main"));
      expect(again).toEqual(["main", "sub", "main", "sub"]);
    });

    test("an older page puts its sub card in its own place", async ({ page }) => {
      const older = [user("first ask", T0 - 60 * MIN), say("m0", T0 - 59 * MIN, "Earlier answer")];
      const cards = [card("c-old", T0 - 30 * MIN, { text: "Old job" }), card("c-new", T0 + 20 * MIN, { text: "New job" })];
      await mountChat(page, vp.width, page1, cards, older);
      await expect(chat(page).locator('.mc-root[data-sub-card="1"]')).toHaveCount(2);
      const order = await chat(page).locator(".msg.mc-root").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subCard ? "sub" : "main"));
      expect(order).toEqual(["main", "sub", "main", "sub", "main"]);
      // Both are old by now (a later turn spoke), so the one-line form carries the text.
      const names = await chat(page).locator(".mc-root[data-sub-card] .mc-mini-head").allTextContents();
      expect(names).toEqual(["Old job", "New job"]);
    });

    test("an old sub card shrinks by its own rule, and the live frame adds a new one", async ({ page }) => {
      const cards = [card("c1", T0 + 20 * MIN)];
      await mountChat(page, vp.width, [user("go", T0), say("m1", T0 + MIN, "Started")], cards);
      const sub = chat(page).locator('.mc-root[data-sub-card="1"]');
      await expect(sub).not.toHaveClass(/is-old/);
      // The same sub reports again: its first card is old, the new one is not.
      await fireEvent(page, "subchat-card", [{ session_id: SID, card: card("c1b", T0 + 30 * MIN, { round: 2, verdict: "Fixed too", text: "Round two" }) }]);
      await expect(sub).toHaveCount(2);
      await expect(sub.nth(0)).toHaveClass(/is-old/);
      await expect(sub.nth(1)).not.toHaveClass(/is-old/);
      await expect(sub.nth(0).locator(".mc-mini-lead")).toContainText("Header");
      await expectNoOverflow(page);
      await capture(chat(page), `subcards-old-${vp.name}`);
    });

    test("the all-finished card shows once, with its count", async ({ page }) => {
      await mountChat(page, vp.width, page1, [card("c1", T0 + 50 * MIN), allFinished("all1", T0 + 55 * MIN)]);
      await fireEvent(page, "subchat-card", [{ session_id: SID, card: allFinished("all1", T0 + 55 * MIN) }]);
      const all = chat(page).locator('.mc-root[data-card-kind="report"]', { hasText: "All 3 subs finished" });
      await expect(all).toHaveCount(1);
      await expect(all.locator(".mc-full .mc-sub-name")).toHaveCount(0);
      await expect(all.locator(".mc-full .mc-verdict .mc-t-good")).toHaveCount(0);
      const summary = all.locator(".mc-full .mc-facts > summary");
      await expect(summary).toBeVisible();
      await summary.click();
      await expect(all.locator(".mc-full .mc-facts-list")).toContainText("5 commits and 12 files changed across 3 subs");
      await capture(chat(page), `subcards-all-finished-${vp.name}`);
    });
  });
}

// The final-stamp question card and the daemon card, driven through the real card UI.
const PICTURE = `<div class="probe" style="padding:18px;background:var(--color-surface);color:var(--color-text)">New header</div>`;

async function openCard(page: Page, opts: Record<string, unknown>, question: Record<string, unknown>): Promise<void> {
  await mountView(page);
  await page.evaluate(async ({ o, q }) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    (window as unknown as { __res: unknown }).__res = {};
    mod.renderQuestionUI({
      questions: [q],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers: unknown) => { (window as unknown as { __res: { submitted?: unknown } }).__res.submitted = answers; },
      onCancel: () => { (window as unknown as { __res: { cancelled?: boolean } }).__res.cancelled = true; },
      ...o,
    } as never);
  }, { o: opts, q: question });
  await page.locator(".prompt-card").waitFor();
}

for (const [name, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`final stamp and daemon card at ${name} width`, () => {
    test.use({ viewport: size });

    test("a final-stamp question shows the picture and the fact chips from the daemon", async ({ page }) => {
      await openCard(page, { finalStamp: { facts: facts() }, from: { name: "Header", task: "Redesign the CV header" } }, {
        question: "Here is the new header.\n\nIs this good, or do you want to change something?",
        header: "Final stamp", domain: "ux", preview: PICTURE,
        options: [{ label: "Good", description: "Finish it" }, { label: "Change something", description: "Say what" }],
      });
      const active = ".prompt-panel.is-active";
      await expect(page.locator(`${active} .prompt-qpic`)).toHaveCount(1);
      const stamp = page.locator(`${active} .prompt-stamp-facts`);
      await expect(stamp).toHaveCount(1);
      const summary = stamp.locator("summary");
      expect((await summary.innerText()).replace(/\s+/g, " ").trim()).toBe("2 3 0 passed ran not pushed");
      await summary.click();
      await expect(stamp.locator(".mc-facts-list")).toContainText("cargo test --lib");
      await capture(page.locator(".prompt-card"), `subcards-final-stamp-${name}`);
    });

    test("a question with no stamp draws no chips", async ({ page }) => {
      await openCard(page, {}, { question: "Pick one?", options: [{ label: "A" }, { label: "B" }] });
      await expect(page.locator(".prompt-stamp-facts")).toHaveCount(0);
    });

    test("a daemon card has no free-text box and its options are the answer", async ({ page }) => {
      await openCard(page, { daemonCard: true, supportsExtras: false }, {
        question: "The Header sub has gone quiet. What now?", header: "Stalled",
        options: [{ label: "Open it", description: "Read it" }, { label: "Nudge again", description: "Remind it" }, { label: "End it", description: "Stop it" }],
      });
      await expect(page.locator(".prompt-card textarea")).toHaveCount(0);
      await expect(page.locator(".prompt-card .prompt-q__other-input")).toHaveCount(0);
      await expect(page.locator(".prompt-card .prompt-extra-input")).toHaveCount(0);
      await page.locator('.prompt-opt input[data-label="Open it"]').click();
      await page.locator('.prompt-card__footer [data-act="primary"]').click();
      await expect.poll(() => page.evaluate(() => JSON.stringify((window as unknown as { __res: { submitted?: unknown } }).__res.submitted ?? null))).toContain("Open it");
    });

    test("a model's own question still has the text box", async ({ page }) => {
      await openCard(page, { supportsExtras: true }, { question: "Pick one?", options: [{ label: "A" }, { label: "B" }] });
      await expect(page.locator(".prompt-card textarea")).toHaveCount(1);
    });
  });
}
