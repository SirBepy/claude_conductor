// Reviewed 2026-11-27 (features-card.css and features-html.ts gained the +N chip and its list; the Done line trail is untouched), and it passes.
// asserts: src/views/sessions/chat-dashboard/done-lines.css, src/views/sessions/chat-dashboard/done-lines-html.ts, src/views/sessions/chat-dashboard/features-card.css, src/views/sessions/chat-dashboard/features-html.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// A long finished-job title must never push the kind icon and the age label out past the Done card's
// right edge: the title truncates with an ellipsis (its full text in the tooltip), the icon and the age
// stay inside the card's padding, at a wide, a narrow and a phone-sized card.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
const NOW = Date.parse("2026-11-23T14:00:00");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const finished = (id: string, name: string, pid: number, finishedMin: number, over: Over = {}) =>
  sessionInstance({
    session_id: id, name, pid, cwd: CWD,
    subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false,
    started_at: ago((finishedMin + 30) * MIN), progress: { plan: null, state_since: ago(finishedMin * MIN) }, ...over,
  });

const LONG = "Fix e2e specs owed by header battery and accounts page";
const MAIN = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CWD });
const FINISHED = [
  finished("f1", LONG, 111, 17),
  finished("f2", "Fix ctrl n new chat weird overlay and popups", 112, 47),
  finished("f3", "Build token efficiency endpoint trim steps 1 5", 113, 55),
];
const SESSIONS = [MAIN, ...FINISHED];
const finish = (subId: string, ts: number) => ({
  id: `f-${subId}`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
  verdict: "Done", tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
});
const CARDS = FINISHED.map((f, i) => finish(f.session_id, NOW - [17, 47, 55][i]! * MIN));
const HISTORY = [userMsg("go")];

async function open(page: Page, width: number): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      list_subchat_cards: CARDS,
      list_session_images: { images: [] },
      get_sub_brief: { brief: null },
      list_previews: [],
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      set_sub_pinned: null, freeze_session: null, unfreeze_session: null, cancel_turn: null, send_message: null, detach_window: null,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

for (const [label, width, cardWidth] of [["wide", 1280, null], ["narrow card", 1280, 300], ["phone", 390, null]] as const) {
  test(`Done card keeps a long title's icon and age inside the card (${label})`, async ({ page }) => {
    await open(page, width);
    const card = page.locator("#session-pane .cdash .cdash-done");
    await expect(card.locator(".pf-row")).toHaveCount(3);
    // A fixed card width stands in for a narrow column; the rows must fit whatever the card is.
    if (cardWidth !== null) await card.evaluate((e, w) => { (e as HTMLElement).style.width = `${w}px`; (e as HTMLElement).style.flex = "none"; }, cardWidth);
    await expect(card.locator(".pf-ago").first()).not.toBeEmpty();
    // Shot first so a red run still leaves the picture (SHOT_TAG=before names a pre-fix run).
    await capture(page.locator("#session-pane .cdash"), `done-lines-long-title-${label.replace(/ /g, "-")}-${process.env.SHOT_TAG ?? "after"}`);
    const c = (await card.boundingBox())!;
    const rows = card.locator(".pf-row");
    for (let i = 0; i < 3; i++) {
      const row = rows.nth(i);
      const parts = {
        row: await row.boundingBox(),
        icon: await row.locator(".pf-ti").last().boundingBox(),
        age: await row.locator(".pf-ago").boundingBox(),
        title: await row.locator(".pf-title").boundingBox(),
      };
      for (const [name, b] of Object.entries(parts)) {
        expect(b, `row ${i} ${name}`).not.toBeNull();
        expect(b!.x, `row ${i} ${name} left`).toBeGreaterThanOrEqual(c.x - 0.5);
        expect(b!.x + b!.width, `row ${i} ${name} right edge inside the card (${c.x + c.width})`).toBeLessThanOrEqual(c.x + c.width + 0.5);
      }
      // The title gives way to the icon and the age, never the other way round.
      expect(parts.title!.x + parts.title!.width, `row ${i} title ends before the icon`).toBeLessThanOrEqual(parts.icon!.x + 0.5);
    }
    // The long title is cut with an ellipsis and keeps its full text for the tooltip.
    const t = rows.first().locator(".pf-title");
    await expect(t).toHaveText(LONG);
    await expect(t).toHaveAttribute("title", LONG);
    await expect(t).toHaveCSS("text-overflow", "ellipsis");
  });
}
