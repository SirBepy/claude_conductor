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

  test("0.2.157 lightbox gallery", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page);
    await page.evaluate(async () => {
      const lightbox = await import("/shared/chat/lightbox.ts");
      const model = await import("/shared/chat/lightbox-gallery-model.ts");
      // Pictures with some content in them, so the shot reads as photos and not flat colour.
      const palettes = [["#1e3a8a", "#38bdf8"], ["#7c2d12", "#fbbf24"], ["#14532d", "#86efac"], ["#581c87", "#f0abfc"]];
      const items = palettes.map(([a, b], i) => {
        const canvas = document.createElement("canvas");
        canvas.width = 960;
        canvas.height = 600;
        const ctx = canvas.getContext("2d")!;
        const sky = ctx.createLinearGradient(0, 0, 0, 600);
        sky.addColorStop(0, a!);
        sky.addColorStop(1, b!);
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, 960, 600);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.moveTo(0, 600);
        ctx.lineTo(0, 430);
        ctx.lineTo(240, 300);
        ctx.lineTo(430, 400);
        ctx.lineTo(650, 250);
        ctx.lineTo(960, 420);
        ctx.lineTo(960, 600);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.arc(700 - i * 90, 130, 46, 0, Math.PI * 2);
        ctx.fill();
        return { type: "image" as const, mime: "image/png", base64: canvas.toDataURL("image/png").split(",")[1]!, filename: `photo-${i + 1}.png` };
      });
      lightbox.openLightbox(items[1]!, null, model.galleryOfItems(items, 1));
    });
    await expect(page.locator(".lightbox-slide img")).toBeVisible();
    await expect(page.locator(".lightbox-counter")).toHaveText("2 / 4");
    await page.mouse.move(640, 400);
    await page.waitForTimeout(500);
    // The dev-only TEST BUILD strip would sit on top of the counter.
    await page.addStyleTag({ content: "#test-build-banner { display: none !important; }" });
    await page.screenshot({ path: path.join(IMG, "0.2.157", "lightbox-gallery.png") });
  });

  test("0.2.157 question card keeps its place", async ({ page }) => {
    const session = sessionInstance();
    await page.setViewportSize({ width: 1280, height: 640 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    await page.locator("#session-pane .session-composer").waitFor();
    const features = ["Dark theme", "Offline mode", "Share sheet", "Keyboard shortcuts", "Export to PDF", "Search history", "Saved filters", "Sync across devices", "Custom icons", "Usage report"];
    await page.evaluate(async (labels) => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({
        id: "q-1", session_id: "s1",
        questions: [{
          question: "Which features should ship in this release?", header: "Features", multiSelect: true,
          options: labels.map((label, i) => ({ label, description: i % 2 ? "Small change, mostly copy and spacing." : "Needs the new store and a settings row." })),
        }] as never,
      });
    }, features);
    const card = page.locator(".prompt-card");
    await card.waitFor();
    await page.waitForTimeout(500);
    // Scroll the card body down, pick two options there: the card must stay where it is.
    await page.evaluate(() => { document.querySelector<HTMLElement>(".prompt-card__body")!.scrollTop = 140; });
    const opts = page.locator('.prompt-panel[data-panel="0"] .prompt-q__opts label');
    await opts.nth(5).click();
    await opts.nth(6).click();
    await page.waitForTimeout(500);
    expect(await page.locator(".prompt-card__body").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .prompt-card, .prompt-card * { visibility: visible; }" });
    await shoot(page, card, "0.2.157", "question-keeps-place", 20);
  });

  test("0.2.157 queued subs count", async ({ page }) => {
    const MIN = 60_000;
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    type Over = Parameters<typeof sessionInstance>[0];
    const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: "C:/Projects/cv-site", ...over });
    const sub = (id: string, name: string, pid: number, over: Over = {}) =>
      chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, started_at: ago(12 * MIN), ...over });
    const held = (waiting: string, extra: Record<string, unknown> = {}) => ({ plan: null, state_since: null, waiting_for: waiting, ...extra }) as never;
    const sessions = [
      chat("main", "CV redesign", 101),
      sub("sub-work", "Footer", 102, { busy: true, progress: { plan: null, state_since: ago(2 * MIN) } as never }),
      sub("q1", "Contact form", 111, { started_at: ago(8 * MIN), progress: held("waiting for Footer") }),
      sub("q2", "Sitemap", 112, { started_at: ago(6 * MIN), progress: held("waiting for Footer") }),
      sub("q3", "Icons", 113, { started_at: ago(4 * MIN), progress: held("waiting for the writer before it", { queue_place: 1, queue_behind: "Footer" }) }),
    ];
    const SEND = "mcp__cc_conductor__send_message";
    const history = [
      { type: "user_message", content: [{ type: "text", text: "build the new CV site" }], timestamp: Date.now() - 20 * MIN },
      { type: "tool_use", tool_name: SEND, input: { kind: "plan", verdict: "Jobs out", text: "Handed out." }, id: "t1", timestamp: 0, parent_tool_use_id: null },
      { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
    ];
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: sessions, get_active_sessions: sessions,
        list_subchats_on: ["main"],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
        list_subchat_cards: [], list_session_images: { images: [] }, list_previews: [],
        get_sub_brief: { brief: { task: "Build the contact form with a honeypot", goal: "g", done_when: "d" } },
      },
    });
    await page.locator(`#sessions-list li[data-session-id="main"]`).click();
    const card = page.locator("#session-pane .cdash-left .cdash-subs");
    await card.locator(".sx-queued").click();
    const pop = page.locator(".sq-pop");
    await expect(pop).toHaveClass(/is-open/);
    await expect(pop).toHaveCSS("transform", "none");
    await expect(pop.locator(".sq-task").first()).toHaveText("Build the contact form with a honeypot");
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .cdash-subs, .cdash-subs *, .sq-pop, .sq-pop * { visibility: visible; }" });
    const a = (await card.boundingBox())!;
    const b = (await pop.boundingBox())!;
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const w0 = Math.max(a.x + a.width, b.x + b.width) - x0;
    const h0 = Math.max(a.y + a.height, b.y + b.height) - y0;
    let w = w0 + 56;
    let h = h0 + 56;
    if (w / h < RATIO) w = h * RATIO; else h = w / RATIO;
    const cx = Math.max(0, Math.min(1280 - w, x0 + w0 / 2 - w / 2));
    const cy = Math.max(0, Math.min(800 - h, y0 + h0 / 2 - h / 2));
    await page.screenshot({ path: path.join(IMG, "0.2.157", "queued-subs.png"), clip: { x: cx, y: cy, width: w, height: h } });
  });

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
