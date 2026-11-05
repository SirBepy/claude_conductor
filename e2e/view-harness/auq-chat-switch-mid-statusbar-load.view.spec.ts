// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/active-session.ts, src/views/sessions/active-session-mount.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Regression: the statusbar's settings read is the first await of a chat open,
// before the transcript renderer is armed. Clicking another chat while it is
// still in flight must not let the abandoned open carry on into the pane that
// now belongs to the second chat.

const SESSIONS = [sessionInstance(), sessionInstance({ session_id: "s2", cwd: "C:/Projects/beta", project_id: "p2", name: "Beta chat" })];
const PROMPT_ID = "799df8a4-9d30-4294-bbb1-36b05a4b6949";

const PENDING = [
  {
    id: PROMPT_ID,
    event: "question-requested",
    durable: true,
    payload: {
      id: PROMPT_ID,
      session_id: "s1",
      seq: 3,
      questions: [{ question: "Should Claude build it?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
  },
];

function history(text: string, withQuestion = false): unknown {
  const events: unknown[] = [{ type: "user_message", content: [{ type: "text", text }], timestamp: 0, remote_echo: false }];
  // The still-open question card the daemon is waiting on, as the transcript shows it.
  if (withQuestion) {
    events.push({
      type: "tool_use",
      tool_name: "mcp__cc_conductor__ask_user_question",
      input: { questions: [{ question: "Should Claude build it?", options: [{ label: "Yes" }, { label: "No" }] }] },
      id: "toolu_s1_question",
      timestamp: 0,
      parent_tool_use_id: null,
    });
  }
  return {
    events,
    oldest_seq: 0,
    newest_seq: 0,
    has_more: false,
  };
}

async function mountSessions(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_pending_prompts: PENDING,
      get_session_drafts: {},
      respond_question: false,
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  // Each chat's transcript carries a marker only that chat may ever show.
  await page.evaluate(([a, b]) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: { sessionId?: string }) => Promise<unknown> } };
    };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd !== "load_history_page") return orig(cmd, args);
      return Promise.resolve(args?.sessionId === "s1" ? JSON.parse(a!) : JSON.parse(b!));
    };
  }, [JSON.stringify(history("ALPHA-ONLY", true)), JSON.stringify(history("BETA-ONLY"))]);
}

/** Hold the next two settings reads (the statusbar's rows + hide-zero pair). */
async function armSettingsGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
      __releaseSettings?: () => void;
      __held?: number;
    };
    const orig = w.__TAURI__.core.invoke;
    let remaining = 2;
    w.__held = 0;
    const gate = new Promise<void>((resolve) => { w.__releaseSettings = resolve; });
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "get_settings" && remaining > 0) {
        remaining -= 1;
        w.__held = (w.__held ?? 0) + 1;
        return gate.then(() => orig(cmd, args));
      }
      return orig(cmd, args);
    };
  });
}

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.locator(`#sessions-list li[data-session-id="${sessionId}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
}

async function paneText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector("#session-pane .session-messages")?.textContent ?? "");
}

test.describe("view-harness / switching chats while the first chat's statusbar settings read is in flight", () => {
  test("control: opening the first chat then the second leaves only the second chat's transcript", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");
    await openChat(page, "s2");
    await expect.poll(() => paneText(page)).toContain("BETA-ONLY");
    expect(await paneText(page)).not.toContain("ALPHA-ONLY");
    await expect(page.locator("#session-pane [data-question-id]")).toHaveCount(0);
  });

  for (const warm of [false, true]) {
    test(`${warm ? "a previously opened" : "a cold"} first chat does not take over the second chat's pane`, async ({ page }) => {
      await mountSessions(page);
      if (warm) {
        await openChat(page, "s1");
        await expect(page.locator(".prompt-card")).toHaveCount(1);
        await openChat(page, "s2");
        await expect.poll(() => paneText(page)).toContain("BETA-ONLY");
      }

      await armSettingsGate(page);
      await page.locator('#sessions-list li[data-session-id="s1"]').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __held: number }).__held)).toBe(2);
      await openChat(page, "s2");
      await page.evaluate(() => (window as unknown as { __releaseSettings: () => void }).__releaseSettings());
      await page.waitForTimeout(800);

      await expect.poll(() => paneText(page)).toContain("BETA-ONLY");
      expect(await paneText(page)).not.toContain("ALPHA-ONLY");
      await expect(page.locator("#session-pane [data-question-id]")).toHaveCount(0);
      await expect(page.locator(".prompt-card")).toHaveCount(0);
      await expect(page.locator(".prompt-collapsed")).toHaveCount(0);

      // The question is still s1's: it opens there when the user returns.
      await openChat(page, "s1");
      await expect(page.locator(".prompt-card")).toHaveCount(1);
    });
  }
});
