import { test, expect, type Page } from "@playwright/test";
import { mountView, invokeCalls, SESSIONS_BASE_INVOKE } from "./harness";

// Drives the real discard button through __launchDraftForTest, since the full
// pickProject + model-modal chain is not worth simulating for this behavior.

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [],
  get_active_sessions: [],
  schedule_delete: null,
};

function scheduledNewChat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sched-1",
    kind: {
      type: "new_chat", cwd: "C:/Projects/alpha", model: "sonnet", effort: "high",
      account_id: null, placeholder_id: "unset", character_id: null, auto_accept: true,
    },
    prompt: "hello",
    fire_at: "2026-08-06T10:00:00Z",
    recurrence: null,
    status: { type: "pending" },
    created_at: "2026-08-05T10:00:00Z",
    last_fired_at: null,
    last_result: null,
    last_session_id: null,
    ...over,
  };
}

/** Creates a draft via the test seam and returns its real (randomly
 *  generated) placeholderId, read back off the rendered sidebar row. */
async function createDraft(page: Page): Promise<string> {
  await mountView(page, { view: "sessions", invoke: BASE_INVOKE });
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string }) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "high" });
  });
  await page.locator(".discard-btn").waitFor();
  const id = await page.locator("#sessions-list li[data-placeholder-id]").getAttribute("data-placeholder-id");
  if (!id) throw new Error("draft row never rendered a placeholder id");
  return id;
}

/** Overrides schedule_list's response to the given items (dynamic - the real
 *  placeholderId isn't known until after mount) while every other command
 *  keeps going through the harness's real mock (so __ccInvokeCalls still
 *  records schedule_delete calls). */
async function seedScheduleList(page: Page, items: unknown[]): Promise<void> {
  await page.evaluate((seeded) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      __ccInvokeCalls: unknown[];
    };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "schedule_list") {
        w.__ccInvokeCalls.push({ cmd, args });
        return Promise.resolve(seeded);
      }
      return orig(cmd, args);
    };
  }, items);
}

test.describe("view-harness / discarding a draft cancels its owned schedule", () => {
  test("its own scheduled NewChat is deleted and the user is toasted", async ({ page }) => {
    const placeholderId = await createDraft(page);
    await seedScheduleList(page, [scheduledNewChat({ id: "owned-1", kind: { ...(scheduledNewChat().kind as object), placeholder_id: placeholderId } })]);

    await page.locator(".discard-btn").click();

    await expect(page.locator(".toast")).toContainText("scheduled from this draft");
    const calls = await invokeCalls(page);
    const deletes = calls.filter((c) => c.cmd === "schedule_delete");
    expect(deletes).toEqual([{ cmd: "schedule_delete", args: { id: "owned-1" } }]);
  });

  test("an unrelated draft's scheduled NewChat survives", async ({ page }) => {
    const placeholderId = await createDraft(page);
    void placeholderId; // ownership is by id match, not by this draft's identity
    await seedScheduleList(page, [scheduledNewChat({ id: "other-1", kind: { ...(scheduledNewChat().kind as object), placeholder_id: "some-other-placeholder" } })]);

    await page.locator(".discard-btn").click();
    await page.waitForTimeout(200); // let the fire-and-forget cancel settle

    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "schedule_delete")).toBe(false);
    await expect(page.locator(".toast")).toHaveCount(0);
  });

  test("a recurring schedule sourced from the draft is not cancelled", async ({ page }) => {
    const placeholderId = await createDraft(page);
    await seedScheduleList(page, [scheduledNewChat({
      id: "recurring-1",
      kind: { ...(scheduledNewChat().kind as object), placeholder_id: placeholderId },
      recurrence: { time: "09:00", rule: { type: "daily" } },
    })]);

    await page.locator(".discard-btn").click();
    await page.waitForTimeout(200);

    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "schedule_delete")).toBe(false);
  });
});
