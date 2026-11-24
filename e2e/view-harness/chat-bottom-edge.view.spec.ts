// Reviewed 2026-11-24 (running line of a main chat styled above the message box, dead pf-host rule gone, icon-only variant above the box): nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-24 (main chat Plan card trimmed to the header and the lines, merged card always drawn, Done card always open): nothing this spec asserts changed, and it passes in the run of every dependent spec.
// Reviewed 2026-11-24: a chat open surfaces a parked question after the transcript mounts on the desktop and before it on the phone; nothing this spec asserts changed, and it passes (run of every dependent spec).
// asserts: src/views/sessions/next-chips.css, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/sessions.css, src/views/sessions/active-session.ts
import { expect, test, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The bottom edge of a chat pane: (1) the quick-reply chips above the message box are
// whole however tall the transcript or dashboard above them is (the slot scrolls
// sideways, so it was a flex item that could shrink to nothing), and (2) the
// dashboard body ends in a soft fade into the message box instead of a hard cut
// through whichever card runs past its bottom edge.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`) => [
  { type: "tool_use", tool_name, input, id, timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0, remote_echo: false, is_meta: false });
const LONG = "A long paragraph so the message wraps over several lines and the transcript grows well past one screen. ".repeat(6);

// Many tall messages (transcript overflow) and a plan with files and links (a tall right column).
const HISTORY: unknown[] = [];
for (let i = 0; i < 14; i++) HISTORY.push(user(`step ${i}`), ...tool(SEND, { kind: "report", verdict: `Step ${i} done`, text: LONG }));
HISTORY.push(
  ...tool("mcp__cc_conductor__write_plan", { steps: [
    { text: "Fix the board id", status: "done" },
    { text: "Open the PR", status: "active" },
    { text: "Release", status: "pending" },
  ] }),
  ...tool(SEND, {
    kind: "artifact",
    text: "PR https://github.com/acme/app/pull/42 and CI https://github.com/acme/app/actions/runs/9001. Files: C:\\proj\\docs\\a.md C:\\proj\\docs\\b.md C:\\proj\\docs\\c.md C:\\proj\\docs\\d.md C:\\proj\\docs\\e.md C:\\proj\\docs\\f.md C:\\proj\\docs\\g.md",
    next_actions: ["Push main", "Refresh the House challenges draft now", "Talk regional plush and kid tests"],
  }),
);
const LAST = HISTORY.length;

async function open(page: Page, size: { width: number; height: number }, view: "messages" | "dashboard", theme = "void"): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    chatView: view,
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme, chatView: view },
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: LAST, has_more: false },
      answers_state: { read: {}, threads: {}, questions: [] },
      ask_list_threads: [],
      list_previews: [],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
    },
  });
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
  await page.locator("#session-pane .session-composer").first().waitFor();
  await expect(page.locator("#session-pane .next-chip")).toHaveCount(3);
  await page.waitForTimeout(300);
}

/** Every chip sits whole inside its slot, the slot shows all of its own content, and
 *  the row ends above the message box. */
async function expectChipsWhole(page: Page): Promise<void> {
  const slot = page.locator("#session-pane .next-chip-slot");
  const m = await slot.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
    top: el.getBoundingClientRect().top,
    bottom: el.getBoundingClientRect().bottom,
    chips: [...el.querySelectorAll(".next-chip")].map((c) => {
      const r = c.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    }),
    shellTop: document.querySelector("#session-pane .composer-shell")!.getBoundingClientRect().top,
    vh: window.innerHeight,
  }));
  expect(m.client).toBeGreaterThanOrEqual(m.scroll);
  for (const c of m.chips) {
    expect(c.top).toBeGreaterThanOrEqual(m.top - 0.5);
    expect(c.bottom).toBeLessThanOrEqual(m.bottom + 0.5);
    expect(c.height).toBeGreaterThan(18);
  }
  expect(m.bottom).toBeLessThanOrEqual(m.shellTop + 0.5);
  expect(m.shellTop).toBeLessThanOrEqual(m.vh);
}

const WIDTHS = [
  { label: "1280", width: 1280, height: 620 },
  { label: "900", width: 900, height: 620 },
  { label: "phone-390", width: 390, height: 700 },
];

test.describe("the next-action chips are whole above the message box", () => {
  // A guard: `.session-messages` has a zero flex basis, so a transcript never squeezed the slot; the dashboard cases below are the ones that fail without `flex: none` (checked by injecting the old CSS).
  for (const s of WIDTHS) {
    test(`messages view, scrolled to the bottom, ${s.label}`, async ({ page }) => {
      await open(page, s, "messages");
      await page.evaluate(() => { const m = document.querySelector("#session-pane .session-messages")!; m.scrollTop = m.scrollHeight; });
      const sc = await page.locator("#session-pane .session-messages").evaluate((el) => ({ over: el.scrollHeight > el.clientHeight }));
      expect(sc.over).toBe(true);
      await expectChipsWhole(page);
      await capture(page, `chat-bottom-edge-chips-messages-${s.label}`);
    });
  }

  for (const s of WIDTHS.filter((w) => w.width > 720)) {
    test(`dashboard, scrolled to the bottom, ${s.label}`, async ({ page }) => {
      await open(page, s, "dashboard");
      await page.evaluate(() => { const m = document.querySelector("#session-pane .cdash-body")!; m.scrollTop = m.scrollHeight; });
      const over = await page.locator("#session-pane .cdash-body").evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(over).toBe(true);
      await expectChipsWhole(page);
      await capture(page, `chat-bottom-edge-chips-dashboard-${s.label}`);
    });
  }
});

/** Mean RGB of a one-pixel-high strip at `y` across [x0, x1) of the page screenshot. */
async function rowColour(page: Page, y: number, x0: number, x1: number): Promise<number[]> {
  const buf = await page.screenshot({ clip: { x: x0, y, width: x1 - x0, height: 1 } });
  return page.evaluate(async (b64) => {
    // atob, not fetch(data:): the page's CSP refuses a data: connect.
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (d[i + c] ?? 0); }
    const px = d.length / 4;
    return sum.map((v) => v / px);
  }, buf.toString("base64"));
}
const dist = (a: number[], b: number[]): number => Math.hypot(...a.map((v, i) => v - b[i]!));

test.describe("the dashboard fades into the message box instead of a hard cut", () => {
  for (const theme of ["void", "void-light"]) {
    test(`the card that runs past the bottom edge fades out (${theme})`, async ({ page }) => {
      await open(page, { width: 1280, height: 520 }, "dashboard", theme);
      const g = await page.evaluate(() => {
        const body = document.querySelector("#session-pane .cdash-body") as HTMLElement;
        body.scrollTop = 0;
        const br = body.getBoundingClientRect();
        const right = document.querySelector("#session-pane .cdash-right")!.getBoundingClientRect();
        const card = document.querySelector("#session-pane .cdash-right")!.lastElementChild!.getBoundingClientRect();
        return {
          bodyBottom: br.bottom, rightBottom: right.bottom, rightLeft: right.left, rightRight: right.right, cardTop: card.top, cardLeft: card.left, cardRight: card.right,
          bg: getComputedStyle(document.querySelector("#session-pane")!).backgroundColor,
        };
      });
      expect(await page.evaluate(() => document.documentElement.getAttribute("data-mode"))).toBe(theme === "void-light" ? "light" : "dark");
      await capture(page, `chat-bottom-edge-fade-${theme}`);
      // Precondition: the right column really runs past the body's bottom edge, so something would be cut.
      expect(g.rightBottom).toBeGreaterThan(g.bodyBottom);
      // ...and its last card starts well inside the body, so the sampled rows are on screen.
      expect(g.cardTop).toBeLessThan(g.bodyBottom - 28);
      const x0 = Math.round(g.cardLeft + 20), x1 = Math.round(g.cardRight - 20);
      const edge = await rowColour(page, Math.floor(g.bodyBottom) - 1, x0, x1);
      const aboveY = Math.max(Math.ceil(g.cardTop) + 4, Math.floor(g.bodyBottom) - 24);
      const above = await rowColour(page, aboveY, x0, x1);
      const gap = await rowColour(page, Math.floor(g.bodyBottom) - 1, Math.round(g.rightLeft) - 14, Math.round(g.rightLeft) - 6);
      // The last row is the pane colour (what the gap between the columns shows there), and the row where the fade starts (or the card's top) is still the card.
      expect(dist(edge, gap)).toBeLessThan(8);
      expect(dist(above, gap)).toBeGreaterThan(dist(edge, gap) + 4);
    });
  }

  test("at the end of the scroll the last card is not faded and keeps its 24px of room", async ({ page }) => {
    await open(page, { width: 1280, height: 520 }, "dashboard");
    const m = await page.evaluate(() => {
      const body = document.querySelector("#session-pane .cdash-body") as HTMLElement;
      body.scrollTop = body.scrollHeight;
      const grid = document.querySelector("#session-pane .cdash-grid")!.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      return { gridBottom: grid.bottom, bodyBottom: br.bottom };
    });
    expect(m.bodyBottom - m.gridBottom).toBeGreaterThanOrEqual(23.5);
  });

  test("the fade never takes a click", async ({ page }) => {
    await open(page, { width: 1280, height: 520 }, "dashboard");
    const pe = await page.locator("#session-pane .cdash-body").evaluate((el) => getComputedStyle(el, "::after").pointerEvents);
    expect(pe).toBe("none");
  });
});
