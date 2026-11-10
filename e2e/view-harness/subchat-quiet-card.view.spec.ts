// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-05: a main chat waiting for its subs to close stays in Main chats with an hourglass, the sub list orders Finished by finish time, a sub header wears its list initials and the all-finished card names unmerged subs; this spec asserts none of those and it passes.
// Reviewed 2026-11-05: main-chat.ts gained a tier and a closing flag per sub, and sidebar-entries.ts builds the summary from "has subs"; a quiet card still draws no dot and this spec passes.
// asserts: src/views/sessions/permission-modal/index.ts, src/views/sessions/permission-modal/gating.ts, src/views/sessions/permission-modal/prompt-queue.ts, src/views/sessions/permission-modal/resurface.ts, src/views/sessions/main-chat.ts, src/views/sessions/sidebar-entries.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// First real run: a decisions checkup with nit-level findings raised a red dot on
// the main chat, and sat in front of a "stopped before it finished" card raised the
// same second, so the card that mattered only showed after the checkup was dismissed.
// A checkup is a quiet card now: no dot, no ring, and behind every other card of its
// chat whatever arrived first. Drives the real sidebar, gate and card at desktop and
// phone width.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };
const CWD = "C:/Projects/cv-site";

const SESSIONS = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CWD }),
  sessionInstance({ session_id: "sub-a", name: "Footer", pid: 102, cwd: CWD, subchat_of: "main", busy: true, awaiting: null }),
  sessionInstance({ session_id: "plain", name: "Plain chat", pid: 105, cwd: CWD }),
];

let seq = 0;
/** A daemon-raised card shown in the main chat's window (`cards::raise_card`). */
function daemonCard(id: string, kind: string, header: string, question: string, over: Record<string, unknown> = {}) {
  return {
    id, session_id: "main", display_session_id: "main", sub_id: "sub-a", card_kind: kind, daemon_card: true, seq: ++seq,
    questions: [{ question, header, multiSelect: false, options: [{ label: "Got it", description: "" }, { label: "Open it", description: "" }] }],
    ...over,
  };
}
const checkup = () => daemonCard("ck-1", "subchat_checkup", "Decisions checkup", "A checkup of the log found a missing decision.", { quiet: true });
const stall = () => daemonCard("stall-1", "subchat_unfinished", "Sub stopped", "Footer stopped before it finished.");

async function mount(page: Page, size: { width: number; height: number }, pending: unknown[] = []): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_subchats_on: ["main"],
      list_pending_prompts: pending.map((p) => ({ id: (p as { id: string }).id, event: "question-requested", durable: true, payload: p })),
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      respond_question: true,
      send_message: null,
      confirm_question_rendered: null,
      list_auto_accept: [],
      set_auto_accept: null,
    },
  });
  // The daemon's pending list can change after boot: a card is only shown while the daemon still lists it.
  await page.evaluate((list) => {
    const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } }; __pending: unknown[] };
    w.__pending = list;
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => (cmd === "list_pending_prompts" ? Promise.resolve(w.__pending) : orig(cmd, args));
  }, pending.map((p) => ({ id: (p as { id: string }).id, event: "question-requested", durable: true, payload: p })));
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.waitForTimeout(250);
}

/** The daemon now lists exactly these cards. */
async function daemonLists(page: Page, cards: unknown[]): Promise<void> {
  await page.evaluate((list) => { (window as unknown as { __pending: unknown[] }).__pending = list; },
    cards.map((p) => ({ id: (p as { id: string }).id, event: "question-requested", durable: true, payload: p })));
}

async function openChat(page: Page, id: string): Promise<void> {
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await page.locator(`#sessions-list li[data-session-id="${id}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const dots = (page: Page) => row(page, "main").locator(".ask-dot");
const card = (page: Page) => page.locator(".prompt-card");
const askText = (page: Page) => card(page).locator(".prompt-q__text");

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / a quiet card yields (${label})`, () => {
    test("a checkup alone puts no dot, ring or attention on the main chat, and is there when he opens the chat", async ({ page }) => {
      await mount(page, size, [checkup()]);
      await openChat(page, "plain");
      await fireEvent(page, "question-requested", [checkup()]);
      await expect(dots(page)).toHaveCount(0);
      await expect(row(page, "main")).not.toHaveAttribute("data-st", "st-attention");
      await expect(row(page, "main")).not.toHaveAttribute("data-st", "st-question");
      // Findable: opening the chat brings the card up, behind nothing.
      await openChat(page, "main");
      await expect(card(page)).toHaveCount(1);
      await expect(askText(page)).toContainText("missing decision");
      await capture(page, `quiet-checkup-alone-${label}`);
    });

    test("a real daemon card beside it gets the dot, and the checkup does not add one", async ({ page }) => {
      await mount(page, size, [checkup(), stall()]);
      await openChat(page, "plain");
      await fireEvent(page, "question-requested", [checkup()]);
      await expect(dots(page)).toHaveCount(0);
      await fireEvent(page, "question-requested", [stall()]);
      await expect(dots(page)).toHaveCount(1);
      await expect(row(page, "main")).toHaveAttribute("data-st", "st-attention");
    });

    test("a card raised after a parked checkup comes first, and the checkup is next", async ({ page }) => {
      await mount(page, size, [checkup(), stall()]);
      await openChat(page, "plain");
      // The checkup got there first.
      await fireEvent(page, "question-requested", [checkup(), stall()]);
      await openChat(page, "main");
      await expect(card(page)).toHaveCount(1);
      await expect(askText(page)).toContainText("stopped before it finished");
      await capture(page, `quiet-real-card-first-${label}`);
      // Answering the real one brings the checkup up on its own.
      await card(page).locator('.prompt-opt input[data-label="Open it"]').click();
      await daemonLists(page, [checkup()]);
      await fireEvent(page, "prompt-resolved", [{ id: "stall-1", durable: true }]);
      await expect(askText(page)).toContainText("missing decision");
    });

    test("a checkup already on screen steps back when a real card arrives for the same chat", async ({ page }) => {
      await mount(page, size, [checkup()]);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [checkup()]);
      await expect(askText(page)).toContainText("missing decision");
      await daemonLists(page, [checkup(), stall()]);
      await fireEvent(page, "question-requested", [stall()]);
      await expect(askText(page)).toContainText("stopped before it finished");
      await expect(card(page)).toHaveCount(1);
    });

    test("after a reload the daemon's list gives the same order", async ({ page }) => {
      // The checkup is the older card in the daemon's list; the stall is newer.
      await mount(page, size, [checkup(), stall()]);
      await openChat(page, "main");
      await expect(askText(page)).toContainText("stopped before it finished");
    });
  });
}
