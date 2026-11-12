// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (project main chat): the sessions mount re-reads each project's main-chat pointer and repaints the open draft's slot; this spec has no pointer, so nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (phone keyboard): pending-pane.ts no longer focuses the composer on open at phone width; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash lane 3, code-check fixes): comment rewording, a transport case split and a deleted unused getter; nothing this spec asserts changed.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-05: sub-list.ts's row button now opens a new window instead of moving the sub; a promoted draft's header and count are unchanged and this spec passes.
// Reviewed 2026-11-05: subchat-view.ts lost the header "Move to sidebar" button (it is a chat-menu item now); a promoted draft's header and count are unchanged and this spec passes.
// Reviewed 2026-11-05: a main chat waiting for its subs to close stays in Main chats with an hourglass, the sub list orders Finished by finish time, a sub header wears its list initials and the all-finished card names unmerged subs; this spec asserts none of those and it passes.
// Reviewed 2026-11-05: sub-list.ts and subchat-view.ts: the row names the tier, a mirrored chat has no Move buttons, and the header line carries the tier; a promoted draft's header and count are unchanged and this spec passes.
// asserts: src/views/sessions/pending-pane.ts, src/views/sessions/subchat-view.ts, src/views/sessions/sub-list.ts, src/views/sessions/sessions-wiring.ts, src/views/sessions/session-statusbar.ts, src/views/sessions/active-session.ts
import { test, expect, type Page } from "@playwright/test";
import { fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// First real end-to-end run: a chat started from a draft never got the subchat
// header dressing. Its header was built as a draft's and promoted in place, so the
// sub count icon never appeared once the chat had a sub, the model label kept the
// draft's pick ("Sonnet") while the registry said Opus, and the count that did show
// after re-selecting the chat went stale ("1" with four subs). Drives a real draft
// through its first send, at desktop and phone width.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };

const REAL = "real-main";
const CWD = "C:/Projects/alpha";
type Over = Parameters<typeof sessionInstance>[0];

/** The chat the daemon started, on Opus high (the registry's pick for a mode-on
 *  chat), and `n` hidden subs behind it. */
function rowsWith(n: number): unknown[] {
  const main = sessionInstance({ session_id: REAL, name: "CV redesign", cwd: CWD, pid: 200, model: "opus", effort: "high", busy: false, awaiting: "done" });
  const subs = Array.from({ length: n }, (_, i) =>
    sessionInstance({
      session_id: `sub-${i + 1}`, name: `Sub ${i + 1}`, cwd: CWD, pid: 300 + i, subchat_of: REAL, busy: true, awaiting: null,
      model: "sonnet", effort: "high",
    } as Over));
  return [main, ...subs];
}

async function startFromDraft(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [],
      get_active_sessions: [],
      list_subchats_on: [REAL],
      start_session: REAL,
      set_auto_accept: null,
      set_composer_draft: { updated_at: "2026-11-05T00:00:00.000Z" },
      clear_composer_draft: { updated_at: "2026-11-05T00:00:00.000Z" },
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      context_status: null,
      list_slash_commands: [],
      send_message: null,
      list_auto_accept: [],
    },
  });
  // A stand-in daemon: the listings answer from a mutable list, and starting the
  // session is what makes the real chat exist, so the promotion finds its row.
  await page.evaluate(({ real, rows }) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } };
      __rows: unknown[];
      __ccInvokeCalls: Array<{ cmd: string; args?: unknown }>;
    };
    w.__rows = [];
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === "list_instances" || cmd === "get_active_sessions") return Promise.resolve(w.__rows);
      if (cmd === "start_session") {
        w.__ccInvokeCalls.push({ cmd, args });
        w.__rows = rows;
        return Promise.resolve(real);
      }
      return orig(cmd, args);
    };
  }, { real: REAL, rows: rowsWith(0) });
  await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
  await page.evaluate(() => {
    (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: { model: string; effort: string; accountId: string }) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "high", accountId: "acc1" });
  });
  const box = page.locator("#session-pane .session-composer .composer-textarea");
  await box.waitFor();
  // The draft shows the pick it was made with.
  await expect(page.locator("#session-pane .session-header .meta-cfg-model-text")).toHaveText(/Sonnet/);
  await box.fill("build the CV site");
  await page.locator("#session-pane .session-composer .composer-send").click();
  await page.waitForFunction(() => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls.some((c) => c.cmd === "start_session"));
  await expect(page.locator("#session-pane .session-header .title")).toHaveText("CV redesign");
}

async function setRows(page: Page, rows: unknown[]): Promise<void> {
  await page.evaluate((r) => { (window as unknown as { __rows: unknown[] }).__rows = r; }, rows);
  await fireEvent(page, "instances-changed", [null]);
}

const header = (page: Page) => page.locator("#session-pane .session-header");
const countBtn = (page: Page) => header(page).locator(".sub-count-btn");

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / a chat started from a draft is a full subchats chat (${label})`, () => {
    test("its header is dressed on promotion, so the count icon shows once it has a sub", async ({ page }) => {
      await startFromDraft(page, size);
      // Dressed: the marker the live sync compares, empty for a chat that is not a sub.
      await expect(header(page)).toHaveAttribute("data-sub-of", "");
      await expect(countBtn(page)).toHaveCount(0);
      await setRows(page, rowsWith(1));
      await expect(countBtn(page)).toHaveText("1");
    });

    test("the count follows the same updates as the sidebar row, from one sub to four", async ({ page }) => {
      await startFromDraft(page, size);
      await setRows(page, rowsWith(1));
      await expect(countBtn(page)).toHaveText("1");
      await setRows(page, rowsWith(4));
      await expect(countBtn(page)).toHaveText("4");
      await expect(countBtn(page)).toHaveAttribute("title", "4 subchats");
      await setRows(page, rowsWith(2));
      await expect(countBtn(page)).toHaveText("2");
    });

    test("the model label follows the registry instead of keeping the draft's pick", async ({ page }) => {
      await startFromDraft(page, size);
      // The registry says Opus high for the started chat.
      await setRows(page, rowsWith(0));
      await expect(header(page).locator(".meta-cfg-model-text")).toHaveText(/Opus/);
      await expect(header(page).locator(".meta-cfg-model-text")).not.toHaveText(/Sonnet/);
    });

    test("turning the mode on later moves the label with the registry, with no reselect", async ({ page }) => {
      await startFromDraft(page, size);
      await setRows(page, rowsWith(0));
      await expect(header(page).locator(".meta-cfg-model-text")).toHaveText(/Opus/);
      // Another pick lands in the registry (a menu flip, the phone): the label follows.
      const rows = rowsWith(0) as Array<{ model: string; effort: string }>;
      rows[0]!.model = "sonnet";
      rows[0]!.effort = "medium";
      await setRows(page, rows);
      await expect(header(page).locator(".meta-cfg-model-text")).toHaveText(/Sonnet/);
      await expect(header(page).locator(".meta-cfg-effort")).toContainText("medium");
    });
  });
}
