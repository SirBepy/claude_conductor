// asserts: src/views/sessions/sessions-helpers.ts, src/views/sessions/chat-heads-model.ts, src/views/sessions/chat-heads.ts, src/views/sessions/active-session.ts, src/views/sessions/active-session-composer.ts, src/shared/chat/dashboard/dashboard-model.ts
import { test, expect, type Page } from "@playwright/test";
import { invokeCalls, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// docs/chat-ram-plan.md step 3b: the daemon stops a chat that waits only on durable question
// cards (idle_frozen). Nobody may be able to tell by looking: the head, the Input Needed segment
// and the dashboard's Waiting card keep the question state, on desktop and on the phone, and
// answering the card right after opening the chat still delivers the answer.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 800 };
const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: "C:/Projects/claude_usage_in_taskbar", started_at: since((20 - pid % 100) * MIN), ...over });

const IDLE = { frozen: true, auto_frozen: true, idle_frozen: true };

const SESSIONS = [
  chat("s-live", "Live and asking", 101, { awaiting: "question" }),
  chat("s-idle-q", "Stopped and asking", 102, { awaiting: "question", ...IDLE }),
  chat("s-idle-done", "Stopped and done", 103, { awaiting: "done", ...IDLE }),
  chat("s-limit-q", "Limit frozen and asking", 104, { awaiting: "question", frozen: true, auto_frozen: true }),
];

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: {},
  list_subchats_on: [],
  get_project_icon: null,
  get_project_tech: null,
  unfreeze_session: null,
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  list_previews: [],
  list_slash_commands: [],
  get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
};

const head = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);

/** The state a head draws: status class, ring tone, whether the ring pulses, the red count. */
async function headState(page: Page, id: string) {
  const li = head(page, id);
  return {
    st: await li.getAttribute("data-st"),
    tone: await li.locator(".avatar-ring circle[data-tone]").first().getAttribute("data-tone"),
    pulse: await li.locator(".avatar-ring .is-pulse").count(),
    count: await li.locator(".chat-head-count").count(),
  };
}

async function segments(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async (list) => {
    const h = await import("/views/sessions/sessions-helpers.ts");
    const none = new Set<string>();
    const out: Record<string, number> = {};
    for (const s of list) out[s.session_id] = h.sessionSegment(s as never, none, none, h.deriveQuestionSet([s] as never), none);
    return out;
  }, SESSIONS);
}

function expectQuestionKept(live: Awaited<ReturnType<typeof headState>>, idle: Awaited<ReturnType<typeof headState>>): void {
  expect(live.tone).toBe("question");
  expect(live.pulse).toBeGreaterThan(0);
  expect(live.count).toBe(1);
  expect(idle).toEqual(live);
}

test.describe("view-harness / idle-frozen chat with an open question card", () => {
  test("desktop: the head and the Input Needed segment match a live asking chat", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { view: "sessions", invoke: INVOKE });
    await head(page, "s-live").waitFor();

    expectQuestionKept(await headState(page, "s-live"), await headState(page, "s-idle-q"));
    // A stopped chat that is done draws no question state: the freeze adds none of its own.
    expect((await headState(page, "s-idle-done")).tone).not.toBe("question");

    const seg = await segments(page);
    // sessionSegment is a helper no UI draws today (only unit tests call it): 0 = Input Needed,
    // 1 = Done, 6 = Scheduled (a usage-limit freeze keeps its own place).
    expect(seg["s-live"]).toBe(0);
    expect(seg["s-idle-q"]).toBe(0);
    expect(seg["s-idle-done"]).toBe(1);
    expect(seg["s-limit-q"]).toBe(6);
  });

  test("phone width: the same head state and the same segment", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mountViewPhone(page, { view: "sessions", invoke: INVOKE });
    await head(page, "s-live").waitFor();

    expectQuestionKept(await headState(page, "s-live"), await headState(page, "s-idle-q"));
    const seg = await segments(page);
    expect(seg["s-idle-q"]).toBe(0);
    expect(seg["s-idle-done"]).toBe(1);
  });

  test("the dashboard's Waiting card still lists the open question of a stopped chat", async ({ page }) => {
    const idle = SESSIONS[1]!;
    const events = [
      { type: "user_message", content: [{ type: "text", text: "pick a store" }], timestamp: 1793558400 },
      { type: "tool_use", tool_name: "mcp__cc_conductor__ask_user_question", input: { questions: [{ question: "Which storage?", options: [{ label: "Settings" }, { label: "Own file" }] }] }, id: "ask1", timestamp: 1793558400, parent_tool_use_id: null },
    ];
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...INVOKE,
        load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
        list_subchat_cards: [],
      },
    });
    await head(page, idle.session_id).click();
    const waiting = page.locator("#session-pane .cdash .cdash-waiting");
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText("Which storage?");
  });

  // selectSession fires unfreeze_session without awaiting it (active-session.ts). The open's wake
  // is slow here (3 s) and any later one fast, so this pins that the answer does not wait on the
  // open's wake: it is sent once, while that wake is still pending, and no toast reports a failure.
  // (The mocked row stays frozen, so sendBundle also unfreezes and awaits its own fast wake first;
  // the daemon's unfreeze is idempotent and its spawn_session wakes an idle freeze itself.)
  test("answering the card while the open's wake is still pending delivers the answer", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { view: "sessions", invoke: { ...INVOKE, respond_question: false, send_message: null } });
    await head(page, "s-idle-q").waitFor();

    await page.evaluate(() => {
      const w = window as unknown as {
        __ccOrder: string[];
        __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      };
      w.__ccOrder = [];
      let wakes = 0;
      const real = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "unfreeze_session") {
          w.__ccOrder.push("unfreeze:start");
          const open = ++wakes === 1;
          return new Promise((resolve) => setTimeout(() => { w.__ccOrder.push(open ? "open-wake:end" : "unfreeze:end"); resolve(null); }, open ? 3000 : 200));
        }
        if (cmd === "respond_question" || cmd === "send_message") w.__ccOrder.push(cmd);
        return real(cmd, args);
      };
    });

    await head(page, "s-idle-q").click();
    await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({
        id: "q-idle",
        session_id: "s-idle-q",
        questions: [{ question: "Which storage?", header: "Storage", options: [{ label: "Settings" }, { label: "Own file" }] }],
      });
    });
    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await page.waitForTimeout(400); // the card slides in; its buttons are not clickable until it settles
    await card.locator('.prompt-opt input[data-label="Settings"]').click();
    // In the real pane the footer button is hidden behind the answer bar, whose send key clicks it.
    await card.locator('[data-act="primary"]').dispatchEvent("click");

    await expect.poll(async () => page.evaluate(() => (window as unknown as { __ccOrder: string[] }).__ccOrder.includes("send_message"))).toBe(true);
    const order = await page.evaluate(() => (window as unknown as { __ccOrder: string[] }).__ccOrder);
    // The answer is sent once, and before the open's slow wake has ended: it does not depend on it.
    expect(order.filter((c) => c === "send_message")).toHaveLength(1);
    expect(order.filter((c) => c === "respond_question")).toHaveLength(1);
    expect(order).not.toContain("open-wake:end");
    expect(order.indexOf("send_message")).toBeGreaterThan(order.indexOf("unfreeze:start"));
    await expect(page.locator(".toast")).toHaveCount(0);
    const sent = (await invokeCalls(page)).filter((c) => c.cmd === "send_message");
    expect(sent).toHaveLength(1);
  });
});
