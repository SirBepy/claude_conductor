// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads-model.ts, src/views/sessions/chat-heads.css, src/views/sessions/sidebar.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The red number on a chat head is "cards waiting on Joe", and it must read the same whether the
// chat is open or not. It used to count only the parked card slots: opening a chat takes its slot
// (the card goes on screen) and leaving parks it again, so the number vanished on open and came
// back on blur, for every chat whose card the registry's `awaiting` did not also name (a card the
// daemon kept across a restart, a sub's card shown in its main chat). One number per head, and a
// hidden chat draws none.

const DESKTOP = { width: 1280, height: 800 };
const CWD = "C:/Projects/cv-site";

const SESSIONS = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CWD }),
  sessionInstance({ session_id: "sub-a", name: "Footer", pid: 102, cwd: CWD, subchat_of: "main", busy: true, awaiting: null }),
  sessionInstance({ session_id: "plain", name: "Plain chat", pid: 105, cwd: CWD, awaiting: null }),
  sessionInstance({ session_id: "calm", name: "Calm chat", pid: 106, cwd: CWD, awaiting: null }),
  sessionInstance({ session_id: "hid", name: "Hidden chat", pid: 107, cwd: CWD, awaiting: null }),
  sessionInstance({ session_id: "quiet", name: "Quiet chat", pid: 108, cwd: CWD, awaiting: null }),
];

let seq = 0;
/** A durable question card: `asker` asked it, `display` is the chat whose window shows it. */
const card = (id: string, asker: string, display: string) => ({
  id, session_id: asker, display_session_id: display, seq: ++seq,
  questions: [{ question: `Which one for ${id}?`, header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
});
/** A daemon card that asks for no attention (the restart-lost stall card): no number, open or blurred. */
const quietCard = { ...card("q-quiet", "quiet", "quiet"), quiet: true, daemon_card: true, card_kind: "subchat_checkup" };
const PENDING = [card("q-sub", "sub-a", "main"), card("q-plain", "plain", "plain"), card("q-hid", "hid", "hid"), quietCard];

async function mount(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("cc_hidden_sessions", JSON.stringify(["hid"])));
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_subchats_on: ["main"],
      list_pending_prompts: PENDING.map((p) => ({ id: p.id, event: "question-requested", durable: true, payload: p })),
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      respond_question: true,
      confirm_question_rendered: null,
      list_auto_accept: [],
      set_auto_accept: null,
    },
  });
  await page.evaluate((m) => { document.documentElement.dataset.mode = m; }, mode);
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  // The cards arrive while a calm chat is open, so each parks in the window it belongs to.
  await head(page, "calm").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await fireEvent(page, "question-requested", PENDING);
  await page.waitForTimeout(500);
}

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const count = (page: Page, id: string): Locator => head(page, id).locator(".chat-head-count");
const eye = (page: Page): Locator => page.locator("#sessions-list li[data-heads-hidden]");

/** Records, every frame, what number a head wears: "" while it wears none or the number is on its
 *  way out. A count that blinks away and back shows up as a "" between two "1". */
async function startWatch(page: Page, id: string): Promise<void> {
  await page.evaluate((hid) => {
    const w = window as unknown as { __watch: string[]; __stop?: boolean };
    w.__watch = [];
    w.__stop = false;
    const tick = () => {
      const li = document.querySelector(`#sessions-list li[data-session-id="${hid}"]`);
      const el = li?.querySelector(".chat-head-count:not(.is-leaving)");
      w.__watch.push(el ? (el.textContent ?? "") : "");
      if (!w.__stop) requestAnimationFrame(tick);
    };
    tick();
  }, id);
}

async function stopWatch(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __watch: string[]; __stop?: boolean };
    w.__stop = true;
    return w.__watch;
  });
}

for (const mode of ["dark", "light"] as const) {
  test.describe(`view-harness / chat head red count is the same open or blurred (${mode})`, () => {
    test("a plain chat's card keeps its number through open and away", async ({ page }) => {
      await mount(page, mode);
      await expect(count(page, "plain")).toHaveText("1");
      await capture(page, `head-badge-plain-blurred-${mode}`);

      await startWatch(page, "plain");
      await head(page, "plain").click();
      await expect(page.locator(".prompt-card")).toBeVisible();
      await page.waitForTimeout(1800);
      const open = await stopWatch(page);
      expect(open.length).toBeGreaterThan(20);
      expect(new Set(open), "the number never blinks off while the chat opens").toEqual(new Set(["1"]));
      await capture(page, `head-badge-plain-open-${mode}`);

      await startWatch(page, "plain");
      await head(page, "calm").click();
      await page.waitForTimeout(1200);
      const away = await stopWatch(page);
      expect(new Set(away), "and it is the same number after clicking away").toEqual(new Set(["1"]));
      await expect(count(page, "plain")).toHaveText("1");
      await expect(count(page, "calm")).toHaveCount(0);
    });

    test("a main chat counts its sub's card the same open and blurred", async ({ page }) => {
      await mount(page, mode);
      await expect(count(page, "main")).toHaveText("1");

      await startWatch(page, "main");
      await head(page, "main").click();
      await expect(page.locator(".prompt-card")).toBeVisible();
      await page.waitForTimeout(1800);
      const open = await stopWatch(page);
      expect(new Set(open), "the number never blinks off while the chat opens").toEqual(new Set(["1"]));
      await capture(page, `head-badge-main-open-${mode}`);

      await startWatch(page, "main");
      await head(page, "calm").click();
      await page.waitForTimeout(1200);
      expect(new Set(await stopWatch(page))).toEqual(new Set(["1"]));
      await expect(count(page, "main")).toHaveText("1");
    });

    test("a quiet card draws no number on the head, open or blurred", async ({ page }) => {
      await mount(page, mode);
      await expect(count(page, "quiet")).toHaveCount(0);
      await head(page, "quiet").click();
      await expect(page.locator(".prompt-card")).toBeVisible();
      await page.waitForTimeout(1800);
      await expect(count(page, "quiet")).toHaveCount(0);
      await head(page, "calm").click();
      await page.waitForTimeout(600);
      await expect(count(page, "quiet")).toHaveCount(0);
    });

    test("the card on screen keeps the number after its parked slot is gone, for as long as it is up", async ({ page }) => {
      await mount(page, mode);
      await head(page, "plain").click();
      await expect(page.locator(".prompt-card")).toBeVisible();
      // Opening a chat takes its slot; the harness parks the card again, so take it the way the real replay does.
      await page.evaluate(async () => {
        const gating = await import("/views/sessions/permission-modal/gating.ts");
        gating.takePendingPrompt("plain");
        window.dispatchEvent(new CustomEvent("cc-active-question-changed"));
      });
      // Well past the hold of a card about to mount: only the card on screen can keep it now.
      await page.waitForTimeout(2200);
      await expect(page.locator(".prompt-card")).toBeVisible();
      await expect(count(page, "plain")).toHaveText("1");
      await capture(page, `head-badge-plain-card-up-slot-gone-${mode}`);
    });

    test("the card resolving takes the number away for good", async ({ page }) => {
      await mount(page, mode);
      await head(page, "plain").click();
      await expect(page.locator(".prompt-card")).toBeVisible();
      await page.evaluate(() => {
        const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
        const orig = w.__TAURI__.core.invoke;
        w.__TAURI__.core.invoke = (cmd, args) => (cmd === "list_pending_prompts" ? Promise.resolve([]) : orig(cmd, args));
      });
      await fireEvent(page, "prompt-resolved", [{ id: "q-plain", durable: true }]);
      await expect(count(page, "plain")).toHaveCount(0, { timeout: 5000 });
      await head(page, "calm").click();
      await page.waitForTimeout(800);
      await expect(count(page, "plain")).toHaveCount(0);
    });

    test("a hidden chat draws no number, and the eye carries one: how many chats are hidden", async ({ page }) => {
      await mount(page, mode);
      await expect(eye(page)).toHaveCount(1);
      await expect(eye(page).locator(".chat-head-count")).toHaveText("1");
      await expect(eye(page).locator(".chat-head-tag")).toHaveCount(0);
      await eye(page).click();
      await expect(head(page, "hid")).toHaveCount(1);
      await expect(head(page, "hid").locator(".chat-head-count, .ht-n")).toHaveCount(0);
      await capture(page, `head-badge-hidden-view-${mode}`);
    });
  });
}
