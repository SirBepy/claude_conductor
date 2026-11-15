import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A markdown quote is a quote of a person, drawn as one reply bubble on every
// surface: primary bar, faint primary tint, the speaker on its own line above
// the words. The transcript no longer turns a quote into a copy card.
// asserts: src/shared/chat/markdown-quote.ts, src/shared/chat/chat-messages-markdown.css, src/shared/chat/chat-dom-renderer.ts

const QUOTE = "Airion approved the desktop version today.\n\n> **Airion:**\n> this is DOPE AF!\n>\n> ok bro this is all you";
const SEND = "mcp__cc_conductor__send_message";
// Only send_message renders in a chat (plain assistant text is hidden), so the
// transcript quote rides a send_message card, the way Claude sends one.
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "what did Airion say?" }], timestamp: 0 },
  { type: "tool_use", tool_name: SEND, id: "t1", timestamp: 0, parent_tool_use_id: null, input: { kind: "answer", verdict: "He approved it", text: QUOTE } },
  { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];

/** The parts of a quote's look that must match on every surface. */
async function lookOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((bq) => {
    const s = getComputedStyle(bq);
    const who = bq.querySelector(":scope > .md-quote-who") as HTMLElement | null;
    const colon = bq.querySelector(".md-quote-colon") as HTMLElement | null;
    const probe = document.createElement("span");
    probe.style.color = "var(--color-primary)";
    document.body.appendChild(probe);
    const primary = getComputedStyle(probe).color;
    probe.remove();
    return {
      bar: `${s.borderLeftWidth} ${s.borderLeftStyle} ${s.borderLeftColor}`,
      barIsPrimary: s.borderLeftColor === primary,
      tinted: s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent",
      background: s.backgroundColor,
      padding: s.padding,
      italic: s.fontStyle,
      who: who?.innerText ?? null,
      whoIsPrimary: who ? getComputedStyle(who).color === primary : null,
      colonShown: colon ? getComputedStyle(colon).display !== "none" : null,
      inCopyCard: !!bq.closest(".copyable-block"),
    };
  });
}

test("a quote in the transcript is a reply bubble with its speaker, not a copy card", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  const quote = page.locator("#session-pane .msg blockquote.md-quote");
  await quote.first().waitFor();
  const look = await lookOf(page, "#session-pane .msg blockquote.md-quote");
  expect(look).toMatchObject({
    barIsPrimary: true,
    tinted: true,
    italic: "normal",
    who: "Airion",
    whoIsPrimary: true,
    colonShown: false,
    inCopyCard: false,
  });
  expect(look.bar.startsWith("3px solid")).toBe(true);
  await expect(page.locator("#session-pane .card-block")).toHaveCount(0);
  await capture(page, "quote-reply-transcript", { fullPage: false });
});

test("the question card, an Answers bubble and the draft editor draw the same quote", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async (quote) => {
    const ui = await import("/views/sessions/permission-modal/question-ui.ts");
    ui.renderQuestionUI({
      questions: [{ question: `${quote}\n\nShould Claude ship it?`, header: "Ship", domain: "arch", options: [{ label: "Yes" }, { label: "No" }] }],
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
    const { renderMarkdown } = await import("/shared/chat/chat-transforms.ts");
    const host = document.createElement("div");
    host.innerHTML =
      `<div class="msg assistant ax-t-bub" id="ax">${renderMarkdown(quote)}</div>` +
      `<div class="dr-body" id="dr" contenteditable="true">${renderMarkdown(quote)}<blockquote id="toolbar-made"><p>typed quote</p></blockquote></div>`;
    document.body.appendChild(host);
  }, QUOTE);

  const card = await lookOf(page, ".prompt-card .prompt-q__context blockquote");
  const answers = await lookOf(page, "#ax blockquote");
  const draft = await lookOf(page, "#dr blockquote.md-quote");
  expect(card).toMatchObject({ barIsPrimary: true, tinted: true, who: "Airion", whoIsPrimary: true, colonShown: false });
  expect(answers).toEqual(card);
  expect(draft).toEqual(card);

  // A quote the draft toolbar makes carries no .md-quote class; it still gets the bubble.
  const typed = await lookOf(page, "#toolbar-made");
  expect({ bar: typed.bar, background: typed.background, padding: typed.padding }).toEqual({ bar: card.bar, background: card.background, padding: card.padding });
  await capture(page, "quote-reply-question-card", { fullPage: false });
});
// pc-1377, the 2026-10-26 case: two statements on different tickets that a card
// flattened into bold-name prose read as one conversation. Each quote now says
// who it was addressed to and where it lives.
const THREADS = [
  "Airion wrote the rule in one story, Stevan objected on another:",
  "",
  "> **Airion -> team (sc-56277 description, Oct 8):**",
  "> Only the PM role edits the rule.",
  "",
  "> **Stevan -> Joe (sc-56481 comment, Oct 26):**",
  "> I do not think the PM should own this. You asked me what I thought, not Airion.",
].join("\n");

test("a quote names who it was addressed to and where it lives, so two threads read apart", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const history = [
    { type: "user_message", content: [{ type: "text", text: "who said what?" }], timestamp: 0 },
    { type: "tool_use", tool_name: SEND, id: "t1", timestamp: 0, parent_tool_use_id: null, input: { kind: "answer", verdict: "Two threads", text: THREADS } },
    { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
  ];
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  // The message draws once in the card and once in its detail copy, so pick each quote by its words.
  const all = page.locator("#session-pane .msg blockquote.md-quote");
  await expect(all.filter({ hasText: "Only the PM role" }).first()).toBeVisible();
  const quotes = {
    nth: (i: number) => (i === 0 ? all.filter({ hasText: "Only the PM role" }) : all.filter({ hasText: "You asked me what I thought" })).first(),
  };
  await expect(quotes.nth(0).locator(".md-quote-who")).toHaveText("Airion -> team (sc-56277 description, Oct 8)", { useInnerText: true });
  await expect(quotes.nth(1).locator(".md-quote-who")).toHaveText("Stevan -> Joe (sc-56481 comment, Oct 26)", { useInnerText: true });
  // The source reads quieter than the name, and the colon stays hidden.
  const [name, src] = await quotes.nth(1).evaluate((bq) => {
    const strong = bq.querySelector(".md-quote-who strong") as HTMLElement;
    const note = bq.querySelector(".md-quote-src") as HTMLElement;
    return [getComputedStyle(strong).color, getComputedStyle(note).color];
  });
  expect(src).not.toBe(name);
  await expect(quotes.nth(1).locator(".md-quote-colon")).toBeHidden();
  await capture(page.locator("#session-pane"), "pc-1377-quote-attribution");
});
