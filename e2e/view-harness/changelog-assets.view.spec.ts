// asserts: src/changelog/entries.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Regenerates the pictures the in-app "What's new" panel shows
// (src/changelog/img/<version>/). They are shots of the REAL UI mounted through
// the view harness, never mockups. Capture-only, gated like the other shot specs:
//   $env:CC_CHANGELOG_SHOTS=1; pnpm exec playwright test changelog-assets --workers=1
// then `git add src/changelog/img`. Each shot is cropped to 16:10, the ratio of
// `.wn-shot`, so the card shows all of it. docs/architecture/release-shape.md (What's new section).
const IMG = path.join(process.cwd(), "src", "changelog", "img");
const RATIO = 1.6;

/** Crops to a 16:10 window centred on `target`, padded, never past the page. */
async function shoot(page: Page, target: Locator, version: string, name: string, pad = 28): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  const vp = page.viewportSize()!;
  let w = box.width + pad * 2;
  let h = box.height + pad * 2;
  if (w / h < RATIO) w = h * RATIO; else h = w / RATIO;
  w = Math.min(w, vp.width);
  h = w / RATIO;
  const x = Math.max(0, Math.min(vp.width - w, box.x + box.width / 2 - w / 2));
  const y = Math.max(0, Math.min(vp.height - h, box.y + box.height / 2 - h / 2));
  await page.screenshot({ path: path.join(IMG, version, `${name}.png`), clip: { x, y, width: w, height: h } });
}

const acc = (id: string, label: string, colour: string, icon: string, kind: "subscription" | "api_credit") => ({
  id, label, colour, icon, config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: kind === "api_credit" ? "" : "claude_max",
  created_at: "2026-01-01T00:00:00Z", fleet_eligible: false, kind,
});
const hoursAhead = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
const usage = (id: string, session: number, weekly: number) => ({
  account_id: id, captured_at: new Date().toISOString(),
  five_hour: { utilization: session, resets_at: hoursAhead(0.9) },
  seven_day: { utilization: weekly, resets_at: hoursAhead(90) },
});

test.describe("@changelog-assets", () => {
  test.skip(!process.env.CC_CHANGELOG_SHOTS, "capture-only, run it with CC_CHANGELOG_SHOTS=1");

  test("0.2.154 account picker", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [], get_active_sessions: [],
        list_project_groups: [{
          id: "proj1", path: "C:/repo", name: "repo", parent_segment: null, avatar: { kind: "none" },
          tokens_7d: 0, live: 0, any_automated: false, last_active_at: null, path_exists: true,
          worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
        }],
        list_projects: [],
        list_accounts: [
          acc("acct-personal", "Personal", "#8b5cf6", "user", "subscription"),
          acc("acct-work", "Work", "#f5a623", "briefcase", "subscription"),
          acc("acct-credit", "API credit", "#10b981", "user", "api_credit"),
        ],
        resolve_project_account: null, project_last_activity_at: 0, count_ai_todos: 0,
        list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
        get_settings: { theme: "void", default_account_id: "acct-personal" },
        get_history: [],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        get_usage_map: { "acct-personal": usage("acct-personal", 20, 49), "acct-work": usage("acct-work", 100, 62) },
        get_api_credit_status: {
          "acct-credit": {
            account_id: "acct-credit", max_grant_remaining_cents: 17427, max_grant_total_cents: 20000,
            max_grant_expires_at: "2026-11-30T00:00:00Z", purchased_remaining_cents: 0, spend_cents: 2573,
            limit_cents: 20000, spend_resets_at: "2026-12-01T00:00:00Z", fetched_at: "2026-11-16T12:00:00Z",
            blocked: false, block_reason: null, error: null,
          },
        },
      },
    });
    await page.locator(".view-sessions .view-header").waitFor();
    await page.keyboard.press("Control+n");
    await page.locator(".project-picker-row").click();
    await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
    await page.locator("#session-pane .sb-account-btn").click();
    const card = page.locator(".cam-modal-card");
    await expect(card.locator(".cam-limit")).toHaveCount(3);
    // Hover the first row so the figures show as inline text, as the release note says.
    await card.locator(".cam-row").first().hover();
    await page.waitForTimeout(400);
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .cam-modal-card, .cam-modal-card * { visibility: visible; }" });
    await shoot(page, card, "0.2.154", "account-picker");
  });

  test("0.2.154 missed items panel", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await mountView(page);
    await page.evaluate(async () => {
      const mod = await import("/missed-panel.ts");
      mod.updateMissedPanel([
        { id: "m-1", name: "Reply to the release thread", time: "Nov 15, 08:00", kind: "message" },
        { id: "m-2", name: "New chat: alpha", time: "Nov 15, 09:15", kind: "new_chat" },
        { id: "m-3", name: "Rerun the flaky spec", time: "Nov 14, 17:00", kind: "message" },
      ], () => {});
    });
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .missed-panel, .missed-panel * { visibility: visible; }" });
    const panel = page.locator(".missed-panel");
    await expect(panel.locator(".missed-row")).toHaveCount(3);
    await expect(panel.locator("[data-close]")).toBeVisible();
    await shoot(page, panel, "0.2.154", "missed-items", 40);
  });

  test("0.2.153 ordered question", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await mountView(page);
    await page.evaluate(async () => {
      const mod = await import("/views/sessions/permission-modal/question-ui.ts");
      mod.renderQuestionUI({
        questions: [{
          question: "Which should Claude build first?",
          header: "Build order",
          domain: "arch",
          ordered: true,
          options: [
            { label: "Share sheet", description: "Needs the new store." },
            { label: "Offline mode" },
            { label: "Polish pass", description: "Copy and spacing only." },
            { label: "Docs" },
          ],
        }],
        submitLabel: "Submit", submitIcon: "ph-paper-plane-right", cancelLabel: "Skip", supportsExtras: true,
        onSubmit: () => {}, onCancel: () => {},
      });
    });
    // Only the card: the dashboard behind it would show through as noise.
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .prompt-card, .prompt-card * { visibility: visible; }" });
    const card = page.locator(".prompt-card");
    const row = (label: string) => card.locator(".prompt-opt--ordered", { hasText: label });
    await row("Polish pass").click();
    await row("Share sheet").click();
    await row("Docs").click();
    await expect(row("Docs").locator(".prompt-opt__rank")).toHaveText("3");
    await shoot(page, card, "0.2.153", "ordered-question", 20);
  });

  test("0.2.152 result card", async ({ page }) => {
    const session = sessionInstance();
    let n = 0;
    const tool = (tool_name: string, input: Record<string, unknown>, ts: number) => {
      const id = `t${++n}`;
      return [
        { type: "tool_use", tool_name, input, id, timestamp: ts, parent_tool_use_id: null },
        { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: ts },
      ];
    };
    const t0 = Date.UTC(2026, 10, 10, 13, 40);
    const labels = ["Read the tracker code", "Add the Trello source", "Write tests", "Commit"];
    const step = (done: number) => labels.map((text, i) => ({ text, status: i < done ? "done" : i === done ? "active" : "pending" }));
    const history: unknown[] = [
      { type: "user_message", content: [{ type: "text", text: "sync trello cards into the todo list" }], timestamp: t0 },
      ...tool("mcp__cc_conductor__send_message", { kind: "plan", text: "Read the tracker code, add a Trello source, then test it." }, t0),
      ...labels.flatMap((_, d) => [...tool("mcp__cc_conductor__write_plan", { steps: step(d) }, t0 + (d + 1) * 60_000)]),
      ...tool("mcp__cc_conductor__write_plan", { steps: step(labels.length) }, t0 + 6 * 60_000),
      ...tool("mcp__cc_conductor__send_message", { kind: "report", verdict: "Built, not pushed", tone: "good", text: "Trello cards land in Todos every 5 minutes." }, t0 + 7 * 60_000),
      ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }, t0 + 7 * 60_000),
    ];
    await page.setViewportSize({ width: 1100, height: 700 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    const result = page.locator("#session-pane .cdash-left .cdash-resultcard");
    await expect(result).toContainText("Built, not pushed");
    // The Result card with the Plan card beside it: a fixed window, since the card alone is mostly empty column.
    await page.screenshot({
      path: path.join(IMG, "0.2.152", "result-card.png"),
      clip: { x: 150, y: 60, width: 950, height: 594 },
    });
  });
});
