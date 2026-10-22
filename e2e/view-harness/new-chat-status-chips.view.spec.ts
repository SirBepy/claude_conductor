import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, fireEvent, capture } from "./harness";

// a31640e6 repro: a brand-new pending pane had no accountId at all (the
// account chip always returned "") and showed a loading skeleton instead of
// 0%. Drives the REAL new-chat pane (pending-flow.ts's launchNewSession,
// bypassing only the project-picker/modal dialogs todo 241's spec covers).

const ACCOUNTS = [
  { id: "acc1", label: "work", icon: "briefcase", colour: "#8b5cf6" },
  { id: "acc2", label: "personal", icon: "user-circle", colour: "#22c55e" },
];

// Pin the row to just the two chips under test, on both profiles, so this
// spec doesn't depend on DEFAULT_ROWS/DEFAULT_MOBILE_ROWS staying in sync.
const ROWS = [["account", "context_pct"]];

async function mountNewChat(page: Page, accountId: string): Promise<string> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_accounts: ACCOUNTS,
      list_instances: [],
      get_active_sessions: [],
      get_settings: { theme: "void", statuslineRows: ROWS, statuslineRowsMobile: ROWS },
    },
  });
  await page.locator("#session-pane").waitFor();

  const placeholderId = await page.evaluate(async (opts) => {
    const flow = await import("/views/sessions/pending-flow.ts");
    const { state } = await import("/views/sessions/state.ts");
    const pane = document.querySelector<HTMLElement>("#session-pane")!;
    await flow.launchNewSession(
      pane,
      { path: "C:/Projects/alpha", name: "Alpha" },
      { model: "claude-opus-5", effort: "high", accountId: opts.accountId, characterId: null, autoAccept: true },
    );
    return state.pendingNewSession?.placeholderId ?? null;
  }, { accountId });

  expect(placeholderId).toBeTruthy();
  const id = placeholderId as string;
  // ensureListener registers `chat:<id>` asynchronously; this is the real
  // readiness signal (mirrors chat-streaming-to-finalized.view.spec.ts).
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, `chat:${id}`);
  return id;
}

test.describe("view-harness / new-chat status chips", () => {
  test("account chip shows the picked account and context reads a literal 0% before any send", async ({ page }) => {
    await mountNewChat(page, "acc2");

    const accountChip = page.locator("#session-pane .sb-account");
    await expect(accountChip).toBeVisible();
    await expect(accountChip).toContainText("Personal");
    await expect(accountChip).not.toContainText("Work"); // not defaulting to the first account

    const contextChip = page.locator("#session-pane .sb-context");
    await expect(contextChip).toHaveText("0%");
    await expect(contextChip).not.toHaveClass(/sb-skeleton/);

    await capture(page.locator("#session-pane .sb-row").first(), "new-chat-chips-pre-send");
  });

  test("context chip goes 0% -> real percentage with the chip never vanishing", async ({ page }) => {
    const placeholderId = await mountNewChat(page, "acc1");
    const channel = `chat:${placeholderId}`;

    await expect(page.locator("#session-pane .sb-context")).toHaveText("0%");

    // Point the real "context_status" command at a payload for THIS session
    // before the turn lands - mirrors the daemon computing occupancy off the
    // same turn whose usage is about to arrive.
    await page.evaluate((sid) => {
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } };
      };
      const orig = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "context_status" && (args as { sessionId?: string } | undefined)?.sessionId === sid) {
          return Promise.resolve({
            pct_used: 12, occupancy: 2400, window: 20000, confidence: "proven", model: "claude-opus-5",
          });
        }
        return orig(cmd, args);
      };
    }, placeholderId);

    await fireEvent(page, channel, [
      {
        type: "turn_usage",
        input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        total_cost_usd: 0.01, duration_ms: 900, has_thinking: false, model: "claude-opus-5",
        awaiting: null, autopilot_changed: null,
      },
    ]);

    // Measured, not screenshotted: sample every frame from the event landing
    // to settle and require the chip element to exist on every single one -
    // a skeleton frame is fine (still a chip), an absent node is the bug.
    const samples: boolean[] = await page.evaluate(async () => {
      const out: boolean[] = [];
      for (let i = 0; i < 60; i++) {
        out.push(!!document.querySelector("#session-pane .sb-context"));
        await new Promise((r) => requestAnimationFrame(r));
      }
      return out;
    });
    expect(samples.every(Boolean), "context chip vanished on at least one frame").toBe(true);

    const contextChip = page.locator("#session-pane .sb-context");
    await expect(contextChip).toHaveText("12%");
    await expect(contextChip).not.toHaveClass(/sb-skeleton/);

    await capture(page.locator("#session-pane .sb-row").first(), "new-chat-chips-post-turn");
  });
});
