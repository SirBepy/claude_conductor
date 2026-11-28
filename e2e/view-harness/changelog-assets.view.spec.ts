// asserts: src/changelog/entries.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { assistantMsg, fireEvent, mountView, mountViewPhone, openPaletteFor, paletteRow, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

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

  test("0.2.157 chat head badge", async ({ page }) => {
    const CWD = "C:/Projects/cv-site";
    const chats = [
      sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CWD }),
      sessionInstance({ session_id: "sub-a", name: "Footer", pid: 102, cwd: CWD, subchat_of: "main", busy: true, awaiting: null }),
      sessionInstance({ session_id: "plain", name: "Plain chat", pid: 105, cwd: CWD, awaiting: null }),
      sessionInstance({ session_id: "calm", name: "Calm chat", pid: 106, cwd: CWD, awaiting: null }),
      sessionInstance({ session_id: "hid", name: "Hidden chat", pid: 107, cwd: CWD, awaiting: null }),
    ];
    const ask = (id: string, asker: string, display: string) => ({
      id, session_id: asker, display_session_id: display, seq: 1,
      questions: [{ question: `Which one for ${id}?`, header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
    });
    const pending = [ask("q-sub", "sub-a", "main"), ask("q-plain", "plain", "plain"), ask("q-hid", "hid", "hid")];
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => localStorage.setItem("cc_hidden_sessions", JSON.stringify(["hid"])));
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: chats, get_active_sessions: chats, list_subchats_on: ["main"],
        list_pending_prompts: pending.map((p) => ({ id: p.id, event: "question-requested", durable: true, payload: p })),
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        respond_question: true, confirm_question_rendered: null, list_auto_accept: [], set_auto_accept: null,
      },
    });
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    await page.locator('#sessions-list li[data-session-id="calm"]').click();
    await page.locator("#session-pane .session-composer").waitFor();
    await fireEvent(page, "question-requested", pending);
    await page.waitForTimeout(800);
    await expect(page.locator('#sessions-list li[data-session-id="plain"] .ht-n.is-red')).toHaveText("1");
    // The heads are a thin column, so enlarge it and crop a 16:10 window around it.
    await page.addStyleTag({ content: "body { visibility: hidden !important; } #sessions-list, #sessions-list * { visibility: visible; } #sessions-list { zoom: 1.5; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(IMG, "0.2.157", "head-badge.png"), clip: { x: 0, y: 40, width: 560, height: 350 } });
  });

  test("0.2.157 secret request card", async ({ page }) => {
    const chats = [
      sessionInstance({ session_id: "main", name: "CV redesign", pid: 101 }),
      sessionInstance({ session_id: "sub-a", name: "Review session code", pid: 102, subchat_of: "main" }),
    ];
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: chats, get_active_sessions: chats, list_subchats_on: ["main"],
        list_pending_prompts: [],
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        respond_question: false, respond_secret: true, confirm_question_rendered: null, list_auto_accept: [], set_auto_accept: null,
      },
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    await page.locator("#session-pane .session-composer").waitFor();
    await fireEvent(page, "secret-requested", [{ id: "sec-1", session_id: "main", label: "Stripe key", file: "C:\\repo\\.env", key: "API_KEY" }]);
    await fireEvent(page, "question-requested", [{
      id: "q-sub", session_id: "sub-a", display_session_id: "main", seq: 1, sub_name: "Review session code",
      questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "Yes" }, { label: "No" }] }],
    }]);
    await expect(page.locator(".prompt-askers .prompt-asker")).toHaveCount(2);
    await page.locator(".secret-card__input").fill("sk-live-51Hx9example");
    await page.waitForTimeout(600);
    const wrap = page.locator(".prompt-askers-wrap");
    const card = page.locator(".prompt-card");
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .prompt-askers-wrap, .prompt-askers-wrap *, .prompt-card, .prompt-card * { visibility: visible; }" });
    const a = (await wrap.boundingBox())!;
    const b = (await card.boundingBox())!;
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const w0 = Math.max(a.x + a.width, b.x + b.width) - x0, h0 = Math.max(a.y + a.height, b.y + b.height) - y0;
    let w = w0 + 48, h = h0 + 48;
    if (w / h < RATIO) w = h * RATIO; else h = w / RATIO;
    const cx = Math.max(0, Math.min(1280 - w, x0 + w0 / 2 - w / 2));
    const cy = Math.max(0, Math.min(800 - h, y0 + h0 / 2 - h / 2));
    await page.screenshot({ path: path.join(IMG, "0.2.157", "secret-card.png"), clip: { x: cx, y: cy, width: w, height: h } });
  });

  test("0.2.157 done card ages", async ({ page }) => {
    const MIN = 60_000;
    const NOW = Date.now();
    const CWD = "C:/Projects/conductor";
    const main = sessionInstance({ session_id: "main", name: "App polish batch", pid: 101, cwd: CWD });
    const sub = (id: string, name: string, pid: number) =>
      sessionInstance({ session_id: id, name, pid, cwd: CWD, subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false, started_at: "2026-11-17T08:00:00Z" });
    const subs = [sub("s1", "login-form-validation", 102), sub("s2", "asset-proposal", 103), sub("s3", "asset-import-plan", 104)];
    const finish = (subId: string, ts: number) => ({
      id: `f-${subId}`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
      verdict: "Done", tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [main, ...subs], get_active_sessions: [main, ...subs], list_subchats_on: ["main"],
        load_history_page: { events: [{ type: "user_message", content: [{ type: "text", text: "go" }], timestamp: NOW - 30 * MIN }], oldest_seq: 10, newest_seq: 11, has_more: false },
        list_subchat_cards: [finish("s1", NOW - 20 * MIN), finish("s2", NOW - 3 * 60 * MIN), finish("s3", NOW - 26 * 60 * MIN)],
        list_session_images: { images: [] }, get_sub_brief: { brief: null }, list_previews: [],
        context_status: { model: "claude-sonnet-4-6", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      },
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const card = page.locator("#session-pane .cdash .cdash-done");
    await expect(card.locator(".dn-task")).toHaveCount(3);
    await expect(card.locator(".dn-at").first()).toHaveText("20 min ago");
    await page.waitForTimeout(600);
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .cdash-done, .cdash-done * { visibility: visible; }" });
    await shoot(page, card, "0.2.157", "done-card", 36);
  });

  // 0.2.157 drew the Images tab; 0.2.158 draws the Files tab (names only) of the same card, now Previews, Images, Files, Links.
  for (const [version, name, tab] of [["0.2.157", "attachments-tabs", "images"], ["0.2.158", "attachments-card", "files"]] as const) test(`${version} attachments card tabs`, async ({ page }) => {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf: Buffer): number => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(type), data]);
      const out = Buffer.alloc(8 + data.length + 4);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crc(body), 8 + data.length);
      return out;
    };
    const png = (w: number, h: number, [r, g, b]: [number, number, number]): string => {
      const raw = Buffer.alloc((w * 3 + 1) * h);
      for (let y = 0; y < h; y++) {
        const band = y > h * 0.35 && y < h * 0.6;
        for (let x = 0; x < w; x++) {
          const o = y * (w * 3 + 1) + 1 + x * 3;
          raw[o] = band ? Math.min(255, r + 70) : r;
          raw[o + 1] = band ? Math.min(255, g + 70) : g;
          raw[o + 2] = band ? Math.min(255, b + 70) : b;
        }
      }
      const head = Buffer.alloc(13);
      head.writeUInt32BE(w, 0);
      head.writeUInt32BE(h, 4);
      head[8] = 8;
      head[9] = 2;
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
    };
    const SEND = "mcp__cc_conductor__send_message";
    const session = sessionInstance();
    const history = [
      userMsg("the login screen as it is now", png(320, 200, [70, 92, 160])),
      { type: "tool_use", tool_name: SEND, input: { kind: "artifact", text: "PR is up: https://github.com/acme/app/pull/42\nCI: https://github.com/acme/app/actions/runs/9001\nSee C:\\proj\\docs\\notes.md and C:\\proj\\docs\\plan.md, C:\\proj\\src\\login\\form.ts, C:\\proj\\src\\login\\form.test.ts" }, id: "t1", timestamp: 0, parent_tool_use_id: null },
      { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
      userMsg("and the empty state", png(320, 200, [150, 80, 110])),
    ];
    const meta = (id: string) => ({
      id, slug: `slug-${id}`, title: `Mockup ${id}`, source: "chat", session_id: session.session_id, version: 1,
      created_at: "2026-11-10T10:00:00Z", published: null, versions: [], shared: false,
    });
    await page.setViewportSize({ width: 1280, height: version === "0.2.157" ? 860 : 1000 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        answers_state: { read: {}, threads: {}, questions: [] }, ask_list_threads: [],
        list_previews: [meta("p2"), meta("p1")],
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    const card = page.locator("#session-pane .cdash .cdash-links");
    await expect(card.locator("[data-act='links-tab']")).toHaveCount(4);
    await card.locator(`[data-act='links-tab'][data-tab='${tab}']`).click();
    if (tab === "images") {
      const rows = card.locator(".cdash-irow");
      await expect(rows).toHaveCount(2);
      await expect.poll(() => rows.first().locator("img").evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    await expect(card.locator(".cdash-llist.is-in")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await page.addStyleTag({ content: "body { visibility: hidden !important; } .cdash-links, .cdash-links * { visibility: visible; }" });
    if (version === "0.2.157") { await shoot(page, card, version, name, 36); return; }
    // The Result card's button beside it is not what the caption is about.
    await page.getByRole("button", { name: "Got it" }).evaluate((el) => { (el as HTMLElement).style.display = "none"; });
    await shoot(page, card, version, name, 24);
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

  // ---- 0.2.158 ---------------------------------------------------------------------------------
  const V158 = "0.2.158";
  const MIN158 = 60_000;
  const CV = "C:/Projects/cv-site";
  const ago158 = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const tool158 = (name: string, input: Record<string, unknown>, id: string) => [
    { type: "tool_use", tool_name: name, input, id, timestamp: 0, parent_tool_use_id: null },
    { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
  ];
  const ctx158 = { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 };
  /** Shows only `selector`'s subtree, so the picture is the thing the caption is about. */
  const only = (page: Page, selector: string) =>
    page.addStyleTag({ content: `body { visibility: hidden !important; } ${selector}, ${selector} * { visibility: visible; } #test-build-banner { display: none !important; }` });

  test("0.2.158 plan card shows the run", async ({ page }) => {
    const main = sessionInstance({ session_id: "main", name: "Finish todos", pid: 101, cwd: CV });
    const history = [
      userMsg("work through the todo list"),
      ...tool158("mcp__cc_conductor__write_plan", { steps: [{ text: "Read the todos", status: "done" }, { text: "Start the lanes", status: "active" }, { text: "Review and release", status: "pending" }] }, "p1"),
    ];
    const step = (id: string, over: Record<string, unknown> = {}) => ({
      id, title: `Step ${id}`, owner: "sub", status: "waiting", after: [], todo_ids: [], sub: `lane-${id}`, sub_id: `sid-${id}`, ...over,
    });
    const steps = [
      step("s1", { status: "done", title: "Footer" }), step("s2", { after: ["s1"], status: "running", title: "Footer tests" }),
      step("s3", { status: "running", title: "Header" }), step("s4", { after: ["s3"], title: "Header tests" }),
      step("s5", { after: ["s2", "s4"], title: "Review gate" }),
      step("s6", { owner: "main", after: ["s5"], title: "Release", sub: undefined, sub_id: undefined }),
    ];
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        get_settings: { theme: "void", chatView: "dashboard" },
        list_instances: [main], get_active_sessions: [main], list_subchats_on: ["main"],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        context_status: ctx158, list_subchat_cards: [], list_previews: [], send_message: null,
        run_plan_state: { session_id: "main", run: { id: "run-1", title: "Finish todos", goal: "ship the release", status: "open", steps } },
      },
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const plan = page.locator("#session-pane .cdash-right .cdash-plan");
    await expect(plan.locator(".rn-host .rn-chain")).toHaveCount(2);
    await page.waitForTimeout(800);
    await only(page, ".cdash-plan");
    await shoot(page, plan, V158, "run-plan", 24);
  });

  test("0.2.158 opened sub has Plan and Attachments tabs and a composer", async ({ page }) => {
    const main = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CV });
    const work = sessionInstance({
      session_id: "sub-work", name: "Footer", pid: 102, cwd: CV, subchat_of: "main", busy: true, awaiting: null, started_at: ago158(12 * MIN158),
      effort: "high", progress: { plan: [{ text: "Read", status: "done" }, { text: "Write", status: "done" }, { text: "Render", status: "active" }, { text: "Verify", status: "pending" }] as never, state_since: ago158(2 * MIN158) },
    });
    const history = [userMsg("build the new CV site")];
    await page.setViewportSize({ width: 1280, height: 1100 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [main, work], get_active_sessions: [main, work], list_subchats_on: ["main"],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        context_status: ctx158, list_subchat_cards: [],
        list_session_images: { images: [{ id: "i1" }, { id: "i2" }, { id: "i3" }] },
        dashboard_gallery_image: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs><rect width="160" height="100" fill="url(#g)"/><path d="M0 100 L0 70 L40 50 L80 66 L120 40 L160 64 L160 100Z" fill="rgba(0,0,0,.35)"/></svg>')}`,
        get_sub_brief: { brief: { task: "Build the footer", goal: "Match the mock", done_when: "Tests green" } },
        list_previews: [],
        send_message: null,
      },
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    await page.locator('#session-pane .cdash-left .cdash-subs .sx-av[data-sub="sub-work"]').click();
    const det = page.locator("#session-pane .cdash-subs .sx-det").last();
    await expect(det).not.toHaveClass(/is-opening/);
    await expect(det).toHaveCSS("transform", "none");
    await det.locator(".sx-tab", { hasText: "Attachments" }).click();
    await expect(det.locator(".sx-att .cdash-ltab")).toHaveText(["Previews0", "Images3", "Files0", "Links0"]);
    await det.locator(".sx-att .cdash-ltab", { hasText: "Images" }).click();
    await expect(det.locator(".sx-att .cdash-irow")).toHaveCount(3);
    await page.waitForTimeout(500);
    await only(page, ".sx-det");
    await shoot(page, det, V158, "sub-tabs", 28);
  });

  test("0.2.158 continue the plan card", async ({ page }) => {
    const AWAY = "2026-11-21T10:00:00Z";
    const chat = (id: string, name: string, pid: number, over: Record<string, unknown> = {}) =>
      sessionInstance({ session_id: id, name, pid, cwd: CV, project_id: "p-cv", ...over } as never);
    const rows = [
      chat("main", "CV redesign", 101, { hidden_at: AWAY, frozen: true, busy: false, awaiting: "done" }),
      ...[["sub-api", "API"], ["sub-web", "Web"], ["sub-deploy", "Deploy"], ["sub-docs", "Docs"]].map(([id, name], i) =>
        chat(id!, name!, 102 + i, { subchat_of: "main", frozen: true, busy: false, awaiting: null })),
    ];
    const paused = [
      { sub_id: "sub-api", name: "API", prior: "working", needs_continue: true, machine_id: null, after: [] },
      { sub_id: "sub-web", name: "Web", prior: "held", needs_continue: false, machine_id: null, after: ["sub-api"] },
      { sub_id: "sub-deploy", name: "Deploy", prior: "held", needs_continue: false, machine_id: null, after: ["sub-web"] },
      { sub_id: "sub-docs", name: "Docs", prior: "idle", needs_continue: false, machine_id: null, after: [] },
    ];
    // A daemon that remembers: a reopen clears `hidden_at` on the main row (the same wrapper continue-plan.view.spec.ts installs).
    await page.addInitScript((s: { rows: Array<Record<string, unknown>>; paused: unknown[] }) => {
      let tauri: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined;
      Object.defineProperty(window, "__TAURI__", {
        configurable: true,
        get: () => tauri,
        set: (v) => {
          const real = v.core.invoke;
          v.core.invoke = (cmd: string, args?: Record<string, unknown>) => {
            const answer = (value: unknown): Promise<unknown> => Promise.resolve(JSON.parse(JSON.stringify(value)));
            const main = s.rows.find((r) => r.session_id === "main");
            if (cmd === "list_instances" || cmd === "get_active_sessions") return answer(s.rows);
            if (cmd === "reopen_main_chat") {
              if (main) { main.hidden_at = null; main.frozen = false; }
              return answer({ ok: true, state: { hidden: false, paused: s.paused, unreadable: false } });
            }
            if (cmd === "put_away_paused") return answer({ hidden: !!main?.hidden_at, paused: s.paused, unreadable: false });
            return real(cmd, args);
          };
          tauri = v;
        },
      });
    }, { rows: rows as never, paused });
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: rows, get_active_sessions: rows, list_subchats_on: ["main"],
        list_projects: [{ id: "p-cv", path: CV, name: "cv-site", default_model: null, default_effort: null, main_chat_id: "main" }],
        start_session: "real-new", send_message: null, unfreeze_session: null, set_auto_accept: null,
        set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" }, clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        context_status: null, list_slash_commands: [], list_auto_accept: [],
      },
    });
    await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
    await page.evaluate(() => {
      (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: Record<string, unknown>) => void })
        .__launchDraftForTest({ path: "C:/Projects/cv-site", name: "cv-site" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: true });
    });
    const input = page.locator("#session-pane .session-composer .composer-textarea");
    await input.waitFor();
    await expect(page.locator(".dmr-line").filter({ hasText: "Reopens" }).first()).toBeVisible();
    await input.fill("add a contact form");
    await page.locator("#session-pane .session-composer .composer-send").click();
    const part = page.locator("#session-pane .continue-plan");
    await expect(part).toBeVisible();
    await page.waitForTimeout(600);
    await only(page, "#session-pane");
    await shoot(page, part, V158, "continue-plan", 90);
  });

  test("0.2.158 turn a chat into a project", async ({ page }) => {
    const scratch = sessionInstance({ session_id: "scratch", name: "Shop idea", pid: 101, cwd: "C:/Users/joe/Documents/ObsidianVault" });
    const events = [userMsg("how would a small shop site look"), assistantMsg("Three pages and a cart.")];
    const moves = { subs: 2, remote_subs: 0, cards: 1 };
    const stays = ["Each sub keeps its own folder and worktree", "This chat ends here and shows in History"];
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [scratch], get_active_sessions: [scratch], list_subchats_on: [], list_pending_prompts: [],
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
        context_status: ctx158, list_slash_commands: [], list_auto_accept: [], confirm_question_rendered: null,
        promote_preview: { moved: moves, forks: true, stays_behind: stays },
        pick_folder: "C:/Projects/shop-site",
      },
    });
    await page.locator('#sessions-list li[data-session-id="scratch"]').click();
    await page.locator(".session-composer .cc-typing-input").waitFor({ state: "attached" });
    await openPaletteFor(page, "Turn into a project");
    await paletteRow(page, "Turn into a project").click();
    const dialog = page.locator("[data-turn-into-project]");
    await dialog.locator("[data-tip-choose]").click();
    await expect(dialog.locator("[data-tip-path]")).toHaveText("C:/Projects/shop-site");
    await page.waitForTimeout(500);
    await only(page, "[data-turn-into-project]");
    await shoot(page, dialog, V158, "turn-into-project", 40);
  });

  test("0.2.158 waiting on you keeps only live questions", async ({ page }) => {
    const session = sessionInstance();
    const ASK = "mcp__cc_conductor__ask_user_question";
    // Seconds, as history rows carry them (2026-11-01 18:40 UTC).
    const T0 = 1793558400;
    const ask = (id: string, question: string, ts: number) => [
      { type: "tool_use", tool_name: ASK, id, timestamp: ts, parent_tool_use_id: null,
        input: { questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] } },
      { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"acknowledged\":true,\"note\":\"The card is shown.\"}" }, is_error: false, timestamp: ts },
    ];
    const history = [
      { type: "user_message", content: [{ type: "text", text: "clean up the old projects" }], timestamp: T0 },
      ...ask("toolu_skipped", "Archive the demo folder?", T0 + 60),
      ...ask("toolu_open", "Delete the wedding_dj folder now?", T0 + 120),
    ];
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        list_pending_prompts: [], get_skipped_question_marks: [{ timestamp: T0 + 90, question_id: "toolu_skipped" }],
        get_session_drafts: {}, respond_question: false,
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    const waiting = page.locator("#session-pane .cdash-waiting");
    await expect(waiting.locator(".question-card")).toHaveCount(1);
    await page.waitForTimeout(600);
    await only(page, ".cdash-waiting");
    // The "New question" button above the card is not what the caption is about.
    await page.getByRole("button", { name: "New question" }).evaluate((el) => { (el as HTMLElement).style.display = "none"; });
    await shoot(page, waiting, V158, "waiting-on-you", 40);
  });

  test("0.2.158 idle chats hide by themselves", async ({ page }) => {
    // A face-sized picture with some colour, so the head reads as an avatar and not a grey disc.
    const CHAR_URL = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="34" cy="42" r="7" fill="#fff"/><circle cx="62" cy="42" r="7" fill="#fff"/><path d="M28 64 Q48 82 68 64" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/></svg>')}`;
    const chat = (id: string, name: string, pid: number, over: Record<string, unknown> = {}) =>
      sessionInstance({ session_id: id, name, pid, cwd: `C:/Projects/${name.toLowerCase()}`, awaiting: "done", ...over } as never);
    const rows = [chat("a", "Alpha", 101, { busy: true, awaiting: null }), chat("b", "Bravo", 102), chat("c", "Charlie", 103)];
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: rows, get_active_sessions: rows,
        list_session_characters: { a: "a", b: "b", c: "c" }, character_asset_url: CHAR_URL,
        get_project_icon: null, get_project_tech: null,
        get_hidden_chats: { sessions: [], projects: [] }, update_hidden_chats: { sessions: [], projects: [] },
      },
    });
    await page.locator('#sessions-list li[data-session-id="b"]').waitFor();
    await fireEvent(page, "hidden-chats-changed", [{ sessions: ["b", "c"], projects: [] }]);
    await expect(page.locator("#sessions-list li[data-heads-hidden] .chat-head-count")).toHaveText("2");
    await page.waitForTimeout(800);
    await only(page, "#sessions-list");
    await page.addStyleTag({ content: "#sessions-list { zoom: 2; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(IMG, V158, "idle-hidden.png"), clip: { x: 0, y: 140, width: 400, height: 250 } });
  });

  test("0.2.158 notes card shows calls and corrections", async ({ page }) => {
    const session = sessionInstance();
    const SEND = "mcp__cc_conductor__send_message";
    const history = [
      { type: "user_message", content: [{ type: "text", text: "add the Shortcut board setting" }], timestamp: 1_000 },
      ...tool158(SEND, { kind: "call", verdict: "Kept the board id in project settings", text: "It sits next to the Shortcut one." }, "n1"),
      ...tool158(SEND, { kind: "correction", verdict: "The sync runs every 5 minutes, not hourly", text: "The first note had the interval wrong." }, "n2"),
      ...tool158(SEND, { kind: "report", verdict: "Board setting added", tone: "good", text: "Cards sync every 5 minutes." }, "n3"),
    ];
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        context_status: ctx158,
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    const notes = page.locator("#session-pane .cdash-slot[data-zone='notes'] .cdash-zone");
    await expect(notes).toBeVisible();
    await page.waitForTimeout(600);
    await only(page, ".cdash-slot[data-zone='notes']");
    const nb = (await notes.boundingBox())!;
    const nw = nb.width + 28, nh = nw / RATIO;
    await page.screenshot({ path: path.join(IMG, V158, "notes-card.png"), clip: { x: nb.x - 14, y: nb.y + nb.height / 2 - nh / 2, width: nw, height: nh } });
  });

  test("0.2.158 suggestion chips stay whole", async ({ page }) => {
    const session = sessionInstance();
    const SEND = "mcp__cc_conductor__send_message";
    const long = "A long paragraph so the message wraps over several lines and the transcript grows well past one screen. ".repeat(6);
    const history: unknown[] = [];
    for (let i = 0; i < 8; i++) history.push({ type: "user_message", content: [{ type: "text", text: `step ${i}` }], timestamp: 0 }, ...tool158(SEND, { kind: "report", verdict: `Step ${i} done`, text: long }, `c${i}`));
    history.push(
      ...tool158("mcp__cc_conductor__write_plan", { steps: [{ text: "Fix the board id", status: "done" }, { text: "Open the PR", status: "active" }, { text: "Release", status: "pending" }] }, "cp"),
      ...tool158(SEND, { kind: "artifact", text: "PR https://github.com/acme/app/pull/42 and CI https://github.com/acme/app/actions/runs/9001.", next_actions: ["Push main", "Refresh the draft now", "Talk regional plush and kid tests"] }, "ca"),
    );
    await page.setViewportSize({ width: 1280, height: 620 });
    await mountView(page, {
      view: "sessions",
      chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        get_settings: { theme: "void", chatView: "dashboard" },
        list_instances: [session], get_active_sessions: [session],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        answers_state: { read: {}, threads: {}, questions: [] }, ask_list_threads: [], list_previews: [],
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    await expect(page.locator("#session-pane .next-chip")).toHaveCount(3);
    await page.evaluate(() => { const m = document.querySelector("#session-pane .cdash-body")!; m.scrollTop = m.scrollHeight; });
    await page.waitForTimeout(600);
    await only(page, "#session-pane");
    // The Result card above would be cut mid-text by the crop; the picture is about the chips and the message box.
    await page.locator("#session-pane .cdash-resultcard").evaluate((el) => { (el as HTMLElement).style.display = "none"; });
    // The chips and the message box under them, with the end of the dashboard fading into them.
    const sb = (await page.locator("#session-pane .next-chip-slot").boundingBox())!;
    const shell = (await page.locator("#session-pane .composer-shell").boundingBox())!;
    const cw = 560, ch = cw / RATIO;
    await page.screenshot({ path: path.join(IMG, V158, "chips-whole.png"), clip: { x: shell.x - 20, y: sb.y + 80 - ch, width: cw, height: ch } });
  });

  // ---- 0.2.159 ---------------------------------------------------------------------------------
  const V159 = "0.2.159";
  const MIN159 = 60_000;
  const NOW159 = Date.parse("2026-11-23T14:00:00");
  const ago159 = (ms: number): string => new Date(NOW159 - ms).toISOString();
  type Over159 = Parameters<typeof sessionInstance>[0];
  const chat159 = (id: string, name: string, pid: number, over: Over159 = {}) => sessionInstance({ session_id: id, name, pid, cwd: CV, ...over });
  const sub159 = (id: string, name: string, pid: number, over: Over159 = {}) =>
    chat159(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, started_at: ago159(12 * MIN159), ...over });
  const PLAN159 = [
    { text: "Read the brief", status: "done" }, { text: "Write the card", status: "done" }, { text: "Render it", status: "active" }, { text: "Verify", status: "pending" },
  ];
  const dash159 = (extra: Record<string, unknown>) => ({
    ...SESSIONS_BASE_INVOKE,
    list_subchats_on: ["main"],
    load_history_page: { events: [userMsg("build the lanes")], oldest_seq: 0, newest_seq: 1, has_more: false },
    context_status: ctx158, list_session_images: { images: [] }, get_sub_brief: { brief: null }, list_previews: [],
    set_sub_pinned: null, freeze_session: null, unfreeze_session: null, cancel_turn: null, send_message: null, detach_window: null,
    ...extra,
  });
  const subscription159 = { id: "acct-sub", label: "Claude personal", colour: "#d97757", icon: "sparkle", config_dir: "", chrome_profile_dir: "", email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z", fleet_eligible: false, kind: "subscription" };
  const endpoint159 = (id: string, label: string, preset: string, base_url: string, models: string[]) => ({
    ...subscription159, id, label, colour: "#4ea1ff", icon: "key", email: "", org_uuid: "", subscription_tier: "", kind: "endpoint",
    endpoint: { preset, base_url, auth_style: "bearer", models },
  });

  test("0.2.159 plan card lists features with a trail of chat icons", async ({ page }) => {
    const rows = [
      chat159("main", "CV redesign", 101),
      sub159("sub-build", "pc-1804 build lanes", 102, { subchat_finished: true, awaiting: "done", started_at: ago159(50 * MIN159), progress: { plan: null, state_since: ago159(30 * MIN159) } }),
      sub159("sub-review", "pc-1804 review lanes", 103, { busy: true, started_at: ago159(20 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(2 * MIN159) } }),
      sub159("sub-ask", "pc-1804 fix lanes", 104, { awaiting: "question", started_at: ago159(5 * MIN159) }),
      sub159("sub-ticket", "sc-56709 invite modal", 105, { busy: true, started_at: ago159(8 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(MIN159) } }),
      sub159("sub-queued", "Contact form", 106, { started_at: null as never, progress: { plan: null, state_since: null, waiting_for: "Invite modal" } as never }),
    ];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({ list_instances: rows, get_active_sessions: rows, list_subchat_cards: [] }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const plan = page.locator("#session-pane .cdash .cdash-plan");
    await expect(plan.locator(".pf-feat")).toHaveCount(3);
    await page.waitForTimeout(800);
    await only(page, ".cdash-plan");
    await shoot(page, plan, V159, "plan-features", 24);
  });

  test("0.2.159 done is its own card", async ({ page }) => {
    const finished = (id: string, name: string, pid: number, min: number) =>
      sub159(id, name, pid, { subchat_finished: true, awaiting: "done", started_at: ago159((min + 30) * MIN159), progress: { plan: null, state_since: ago159(min * MIN159) } });
    const fin = (subId: string, min: number, verdict: string) => ({
      id: `f-${subId}`, ts: NOW159 - min * MIN159, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
      verdict, tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
    });
    const rows = [
      chat159("main", "CV redesign", 101),
      sub159("sub-work", "Contact form", 102, { busy: true, started_at: ago159(10 * MIN159), progress: { plan: null, state_since: ago159(MIN159) } }),
      finished("f1", "pc-1811 build header", 111, 5), finished("f2", "sc-56709 invite modal", 112, 20), finished("f3", "Footer links", 113, 45),
      finished("f4", "pc-1812 review hero", 114, 180), finished("f6", "pc-1811 review header", 116, 2),
    ];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({
        list_instances: rows, get_active_sessions: rows,
        list_subchat_cards: [fin("f1", 5, "Header built"), fin("f6", 2, "Header reviewed"), fin("f2", 20, "Modal done"), fin("f3", 45, "Links fixed"), fin("f4", 180, "Hero reviewed")],
      }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const done = page.locator("#session-pane .cdash .cdash-done");
    await expect(done.locator(".dl-host")).toHaveCount(1);
    await expect(done.locator(".dl-feat")).toHaveCount(3);
    await page.waitForTimeout(800);
    await only(page, ".cdash-done");
    await shoot(page, done, V159, "done-card", 24);
  });

  test("0.2.159 no project chat is a main chat of its own", async ({ page }) => {
    const VAULT = "C:/Users/tecno/Documents/ObsidianVault";
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [], get_active_sessions: [], list_subchats_on: [],
        list_projects: [{ id: "p-vault", path: VAULT, name: "ObsidianVault", default_model: null, default_effort: null, main_chat_id: null }],
        dashboard_list_targets: [{ target: { kind: "group", id: "g-vault", name: "ObsidianVault", repos: [{ cwd: VAULT, name: "ObsidianVault", project_id: null }] }, last_active_ms: 0, live_count: 0, question_count: 0, working_count: 0 }],
        start_session: "real-new", send_message: null, set_auto_accept: null,
        set_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" }, clear_composer_draft: { updated_at: "2026-11-06T00:00:00.000Z" },
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        context_status: null, list_slash_commands: [], list_auto_accept: [],
      },
    });
    await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
    await page.evaluate((p) => {
      (window as unknown as { __launchDraftForTest: (p: { path: string; name: string }, c: Record<string, unknown>) => void })
        .__launchDraftForTest({ path: p, name: "ObsidianVault" }, { model: "sonnet", effort: "low", accountId: "acc1", subchatsOn: false, plainChat: true });
    }, VAULT);
    const route = page.locator("#session-pane .draft-main-route");
    await route.waitFor();
    await route.locator(".slider").click();
    await expect(route.locator(".dmr-line")).toHaveText("A main chat of its own");
    await page.locator("#session-pane .session-composer .composer-textarea").fill("sketch the shop site with me");
    await page.waitForTimeout(600);
    await only(page, "#session-pane");
    const shell = page.locator("#session-pane .composer-shell");
    const rb = (await route.boundingBox())!;
    const sb = (await shell.boundingBox())!;
    const w = sb.width + 40, h = w / RATIO;
    const cy = (rb.y + sb.y + sb.height) / 2 - 20;
    await page.screenshot({ path: path.join(IMG, V159, "no-project-main.png"), clip: { x: Math.max(0, sb.x - 20), y: Math.max(0, cy - h / 2), width: w, height: h } });
  });

  test("0.2.159 a put-away chat is closed everywhere", async ({ page }) => {
    const CHAR_URL = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="34" cy="42" r="7" fill="#fff"/><circle cx="62" cy="42" r="7" fill="#fff"/><path d="M28 64 Q48 82 68 64" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/></svg>')}`;
    // The rows the daemon hands a client: the put-away main chat and its paused subs are left out of the list.
    const rows = [
      sessionInstance({ session_id: "plain", name: "Plain chat", pid: 110, cwd: "C:/Projects/other", project_id: "p2", awaiting: "done" } as never),
      sessionInstance({ session_id: "plain2", name: "Another chat", pid: 111, cwd: "C:/Projects/other", project_id: "p2", awaiting: "done" } as never),
    ];
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_projects: [{ id: "p1", path: CV, name: "cv-site", main_chat_id: "main" }],
        list_instances: rows, get_active_sessions: rows, list_subchats_on: ["main"],
        list_session_characters: { plain: "a", plain2: "b" }, character_asset_url: CHAR_URL, get_project_icon: null, get_project_tech: null,
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        context_status: null, list_slash_commands: [], list_auto_accept: [],
      },
    });
    await page.locator("#sessions-list li").first().waitFor();
    await page.waitForTimeout(800);
    await expect(page.locator('#sessions-list li[data-session-id="main"]')).toHaveCount(0);
    await expect(page.locator("#sessions-list li[data-heads-hidden]")).toHaveCount(0);
    await expect(page.locator("#sessions-list li[data-session-id]")).toHaveCount(2);
    await only(page, "#sessions-list");
    await page.addStyleTag({ content: "#sessions-list { zoom: 2; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(IMG, V159, "put-away-closed.png"), clip: { x: 0, y: 100, width: 400, height: 250 } });
  });

  test("0.2.159 dictation words stay while the rewrite lands", async ({ page }) => {
    const session = sessionInstance();
    await page.setViewportSize({ width: 820, height: 512 });
    const dictationHistory = [userMsg("what is left on the footer"), assistantMsg("The links and the legal line are done. The contact form is the last piece.")];
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: dictationHistory, oldest_seq: 0, newest_seq: dictationHistory.length, has_more: false },
        context_status: ctx158, list_slash_commands: [], list_auto_accept: [],
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    const input = page.locator("#session-pane .session-composer .composer-textarea");
    await input.waitFor();
    await input.fill("add a contact form to the footer with name email and message fields and a send button");
    // The mic only shows while recording; the recording style is the one the real button wears.
    await page.locator("#session-pane .composer-mic").evaluate((el) => el.classList.add("recording"));
    await page.waitForTimeout(500);
    await page.addStyleTag({ content: "#test-build-banner, #session-pane .session-header, #sessions-list, .view-header { display: none !important; }" });
    await page.waitForTimeout(300);
    const cb = (await page.locator("#session-pane .composer-shell").boundingBox())!;
    const dw = cb.width + 48, dh = dw / RATIO;
    await page.screenshot({ path: path.join(IMG, V159, "dictation.png"), clip: { x: Math.max(0, cb.x - 24), y: Math.max(0, cb.y + cb.height + 24 - dh), width: dw, height: dh } });
  });

  test("0.2.159 models and providers page", async ({ page }) => {
    const credit = { ...subscription159, id: "acct-credit", label: "API credit", colour: "#10b981", icon: "key", org_uuid: "console-org", subscription_tier: "", kind: "api_credit" };
    const accounts = [subscription159, credit, endpoint159("acct-kimi", "Kimi Code", "kimi_code", "https://api.kimi.ai/coding/", ["k3.1-pro"]), endpoint159("acct-ds", "DeepSeek", "deepseek", "https://api.deepseek.com/anthropic", ["deepseek-v4-pro", "deepseek-flash"])];
    const routing = { groups: { personal: {
      build: { account_id: "acct-ds", model: "deepseek-v4-pro", effort: "high", fallback: { kind: "wait" } },
      plan: { account_id: "acct-sub", model: "opus", effort: "xhigh", range: { min_model: "sonnet", max_model: "opus" } },
    }, client: {} } };
    await page.setViewportSize({ width: 1100, height: 900 });
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: accounts,
        list_projects: [{ id: "p1", path: "C:/a", name: "cv-site", payment_group: "personal" }, { id: "p3", path: "C:/c", name: "shop-site", payment_group: "client" }],
        get_settings: { theme: "void", routing }, save_settings: null, add_endpoint_account: {}, remove_account: null,
        get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
        get_auth_state_map: {}, get_terminal_identity: null, get_api_credit_status: {},
      },
    });
    // The merged Accounts & models page opens on Accounts; the role cards are on its Who does what tab.
    await page.locator("#acm-tab-who").click();
    await page.locator(".view-settings-models-providers .mp-card").first().waitFor();
    await page.waitForTimeout(900);
    await page.addStyleTag({ content: "#test-build-banner { display: none !important; }" });
    // Scrolled a little so the first role cards of Who does what sit under the tabs.
    await page.locator(".mp-page .view-body").evaluate((el) => { el.scrollTop = 80; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(IMG, V159, "models-providers.png"), clip: { x: 0, y: 0, width: 1100, height: 1100 / RATIO } });
  });

  test("0.2.159 project settings payment group", async ({ page }) => {
    const CWD = "C:/work/demo";
    await page.setViewportSize({ width: 700, height: 900 });
    await mountView(page, {
      view: "settings-appearance",
      invoke: {
        list_accounts: [subscription159, endpoint159("acct-ds", "DeepSeek", "deepseek", "https://api.deepseek.com/anthropic", ["deepseek-v4-pro", "deepseek-flash"])],
        resolve_project_account: null, get_ticket_tracker: null,
        list_projects: [{ id: "p1", path: CWD, name: "demo", payment_group: "client", routing_overrides: { build: { account_id: "acct-ds", model: "deepseek-flash" }, review: { account_id: "acct-sub", model: "opus", effort: "high" } } }],
        get_settings: { routing: { groups: { personal: { build: { account_id: "acct-sub", model: "opus", effort: "high" } }, client: { build: { account_id: "acct-sub", model: "sonnet" }, review: { account_id: "acct-sub", model: "sonnet" } } } } },
        update_project: null, ensure_project: { id: "p1", path: CWD },
      },
    });
    await page.locator(".kit-row").first().waitFor();
    await page.evaluate(async (cwd) => {
      await import("/views/sessions/project-dashboard/pd-cards.css");
      const { renderProjectSettings } = await import("/views/sessions/project-dashboard/project-config/project-settings.ts");
      const host = document.createElement("div");
      host.id = "rail";
      host.style.cssText = "width:300px;padding:16px;position:absolute;top:0;left:0;background:var(--color-background)";
      document.body.appendChild(host);
      await renderProjectSettings(host, cwd);
    }, CWD);
    await page.locator("#rail #paymentGroupSelect").waitFor();
    await expect(page.locator("#paymentGroupRows .mp-diff")).toHaveCount(2);
    await page.waitForTimeout(700);
    await page.evaluate(() => { for (const el of Array.from(document.body.children)) if (el.id !== "rail") (el as HTMLElement).style.display = "none"; });
    // The rail's Payment group block: the select, its override rows and the Change a role button.
    const sel = (await page.locator("#paymentGroupSelect").boundingBox())!;
    const add = (await page.locator("#paymentGroupAdd").boundingBox())!;
    const h = add.y + add.height - sel.y + 140, w = h * RATIO;
    await page.screenshot({ path: path.join(IMG, V159, "payment-group.png"), clip: { x: 0, y: Math.max(0, sel.y - 80), width: w, height: w / RATIO } });
  });

  test("0.2.159 usage shows the claude.ai percent only", async ({ page }) => {
    const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const snap = (five: number, seven: number) => ({ captured_at: new Date().toISOString(), five_hour: { utilization: five, resets_at: future(2) }, seven_day: { utilization: seven, resets_at: future(48) } });
    await page.setViewportSize({ width: 820, height: 700 });
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [{ id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6" }, { id: "acc-2", label: "Work", icon: "user", colour: "#f59e0b" }],
        get_usage_map: { "acc-1": snap(40, 20), "acc-2": snap(15, 60) }, get_auth_state_map: {},
        get_skill_usage_week: { entries: [], total_sessions: 0 }, list_instances: [], poll_now: null, schedule_list: [], schedule_list_external: [],
      },
    });
    await page.locator(".dash-acard .dash-ring").first().waitFor();
    await page.waitForTimeout(900);
    await page.addStyleTag({ content: "#test-build-banner { display: none !important; }" });
    // Everything under the account cards is another widget: hide it so the picture holds only the usage rings.
    await page.locator(".dash-acard").first().evaluate((card) => {
      let node: HTMLElement | null = card.parentElement;
      while (node && node !== document.body) {
        let sib = node.nextElementSibling as HTMLElement | null;
        while (sib) { sib.style.display = "none"; sib = sib.nextElementSibling as HTMLElement | null; }
        node = node.parentElement;
      }
    });
    await page.waitForTimeout(200);
    const cardsBox = (await page.locator(".dash-acard").first().boundingBox())!;
    const cw2 = 800, ch2 = cw2 / RATIO;
    await page.screenshot({ path: path.join(IMG, V159, "usage-percent-only.png"), clip: { x: 10, y: Math.max(0, cardsBox.y + cardsBox.height / 2 - ch2 / 2), width: cw2, height: ch2 } });
  });

  test("0.2.159 the private ask chat is off", async ({ page }) => {
    const SESSION = sessionInstance();
    const SEND = "mcp__cc_conductor__send_message";
    const history = [
      userMsg("does it read the Shortcut tracker or start from scratch?"),
      ...tool158(SEND, { kind: "answer", verdict: "It copies Shortcut's shape", tone: "good", question: "Does Trello reuse the Shortcut tracker, or start from scratch?", text: "Trello fits the same small tracker interface with one board id.\nNo new settings page." }, "a1"),
    ];
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE, list_instances: [SESSION], get_active_sessions: [SESSION],
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        answers_state: { read: {}, threads: {}, questions: [] }, ask_list_threads: [], answers_mark: { read: {}, threads: {}, questions: [] },
        context_status: ctx158,
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
    const card = page.locator("#session-pane .cdash-answers");
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Reply" })).toHaveCount(0);
    await page.waitForTimeout(700);
    await only(page, ".cdash-answers");
    await shoot(page, card, V159, "private-ask-off", 30);
  });

  // ---- 0.2.160 ---------------------------------------------------------------------------------
  const V160 = "0.2.160";

  test("0.2.160 a main chat always has its Plan card", async ({ page }) => {
    const rows = [chat159("main", "CV redesign", 101)];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({ list_instances: rows, get_active_sessions: rows, list_subchat_cards: [] }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const plan = page.locator("#session-pane .cdash .cdash-plan");
    await expect(plan.locator(".cdash-pnone")).toHaveText("No chats in progress.");
    await page.waitForTimeout(800);
    await only(page, ".cdash-plan");
    await shoot(page, plan, V160, "plan-always", 24);
  });

  test("0.2.160 the Done card is always open", async ({ page }) => {
    const finished = (id: string, name: string, pid: number, min: number) =>
      sub159(id, name, pid, { subchat_finished: true, awaiting: "done", started_at: ago159((min + 30) * MIN159), progress: { plan: null, state_since: ago159(min * MIN159) } });
    const fin = (subId: string, min: number, verdict: string) => ({
      id: `f-${subId}`, ts: NOW159 - min * MIN159, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
      verdict, tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
    });
    const rows = [
      chat159("main", "CV redesign", 101),
      finished("f1", "pc-1811 build header", 111, 5), finished("f2", "sc-56709 invite modal", 112, 20), finished("f3", "Footer links", 113, 45),
      finished("f4", "pc-1812 review hero", 114, 180),
    ];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({
        list_instances: rows, get_active_sessions: rows,
        list_subchat_cards: [fin("f1", 5, "Header built"), fin("f2", 20, "Modal done"), fin("f3", 45, "Links fixed"), fin("f4", 180, "Hero reviewed")],
      }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const done = page.locator("#session-pane .cdash .cdash-done");
    await expect(done.locator(".dl-feat")).toHaveCount(3);
    await page.waitForTimeout(800);
    await only(page, ".cdash-done");
    await shoot(page, done, V160, "done-open", 24);
  });

  test("0.2.160 the phone opens a chat after an update with fewer bytes", async ({ page }) => {
    const session = sessionInstance({ session_id: "phone-chat", name: "CV redesign", pid: 101, cwd: CV });
    // Only the user message: the phone harness page draws no assistant reply from this mock, so the picture would otherwise differ from the mock.
    const hist = [userMsg("what is left on the footer")];
    await page.setViewportSize({ width: 640, height: 400 });
    await mountViewPhone(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session],
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: hist, oldest_seq: 0, newest_seq: hist.length, has_more: false },
        context_status: ctx158, list_slash_commands: [], list_auto_accept: [],
      },
    });
    await page.locator(`#sessions-list li[data-session-id="${session.session_id}"]`).click();
    await expect(page.getByText("what is left on the footer")).toBeVisible();
    await page.waitForTimeout(800);
    await page.addStyleTag({ content: "#test-build-banner { display: none !important; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(IMG, V160, "phone-first-open.png") });
  });

  const V161 = "0.2.161";
  const sums161 = (input: number, output: number) => ({ input, output, cache_read: 0, cache_creation: 0, turns: 3 });
  const prov161 = (id: string, source: string, over: Record<string, unknown> = {}) => ({
    account_id: id, fetched_at: new Date().toISOString(), windows: [], balances: [], spend: null, available: null, error: null, source, ...over,
  });
  const tok161 = (id: string, week: number) => ({ account_id: id, five_hour: sums161(week / 4, week / 4), today: sums161(week / 4, week / 4), seven_day: sums161(week / 2, week / 2) });
  const credit161 = { ...subscription159, id: "acct-credit", label: "API credit", colour: "#10b981", icon: "sparkle", org_uuid: "console-org", subscription_tier: "", kind: "api_credit" };
  const accounts161 = [
    subscription159, credit161,
    endpoint159("acct-kimi", "Kimi Code", "kimi_code", "https://api.kimi.ai/coding/", ["k3.1-pro"]),
    endpoint159("acct-ds", "DeepSeek", "deepseek", "https://api.deepseek.com/anthropic", ["deepseek-v4-pro", "deepseek-flash"]),
  ];
  const routing161 = { groups: { personal: {
    build: { account_id: "acct-ds", model: "deepseek-v4-pro", effort: "high", fallback: { kind: "wait" } },
    plan: { account_id: "acct-sub", model: "opus", effort: "xhigh", range: { min_model: "sonnet", max_model: "opus" } },
  }, client: {} } };
  async function mountAccounts161(page: Page, providerUsage: unknown): Promise<void> {
    await page.setViewportSize({ width: 1100, height: 900 });
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: accounts161,
        list_projects: [{ id: "p1", path: "C:/a", name: "cv-site", payment_group: "personal" }],
        get_settings: { theme: "void", routing: routing161, default_account_id: "acct-sub" }, save_settings: null, add_endpoint_account: {}, remove_account: null,
        get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
        get_auth_state_map: {}, get_terminal_identity: null, get_api_credit_status: {}, get_provider_usage: providerUsage,
      },
    });
    await page.locator(".view-settings-models-providers .acm-prov").first().waitFor();
    await page.waitForTimeout(900);
    await page.addStyleTag({ content: "#test-build-banner { display: none !important; }" });
  }

  test("0.2.161 one Accounts and models page", async ({ page }) => {
    await mountAccounts161(page, { usage: {}, tokens: {} });
    await page.screenshot({ path: path.join(IMG, V161, "accounts-models.png"), clip: { x: 0, y: 0, width: 1100, height: 1100 / RATIO } });
  });

  test("0.2.161 provider accounts show what is left", async ({ page }) => {
    const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
    await mountAccounts161(page, {
      usage: {
        "acct-ds": prov161("acct-ds", "deepseek", { balances: [{ currency: "USD", amount: 12.4 }], available: true }),
        "acct-kimi": prov161("acct-kimi", "kimi_code", { windows: [{ label: "5h", used_pct: 42, resets_at: inHours(2) }] }),
      },
      tokens: { "acct-ds": tok161("acct-ds", 1_800_000), "acct-kimi": tok161("acct-kimi", 600_000) },
      plan_usage: { "acct-kimi": true },
    });
    const first = (await page.locator(".view-settings-models-providers .acm-prov").nth(2).boundingBox())!;
    await page.locator(".mp-page .view-body").evaluate((el, top) => { el.scrollTop = top; }, Math.max(0, first.y - 140));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(IMG, V161, "provider-usage.png"), clip: { x: 0, y: 0, width: 1100, height: 1100 / RATIO } });
  });

  test("0.2.161 Who does what shows the model ladder", async ({ page }) => {
    await mountAccounts161(page, { usage: {}, tokens: {} });
    await page.locator("#acm-tab-who").click();
    await page.locator(".view-settings-models-providers .mp-card").first().waitFor();
    await page.waitForTimeout(600);
    await page.locator(".mp-page .view-body").evaluate((el) => { el.scrollTop = 80; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(IMG, V161, "who-does-what.png"), clip: { x: 0, y: 0, width: 1100, height: 1100 / RATIO } });
  });

  test("0.2.161 a long title in the Done card stays inside it", async ({ page }) => {
    const finished = (id: string, name: string, pid: number, min: number) =>
      sub159(id, name, pid, { subchat_finished: true, awaiting: "done", started_at: ago159((min + 30) * MIN159), progress: { plan: null, state_since: ago159(min * MIN159) } });
    const fin = (subId: string, min: number, verdict: string) => ({
      id: `f-${subId}`, ts: NOW159 - min * MIN159, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
      verdict, tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
    });
    const rows = [
      chat159("main", "CV redesign", 101),
      finished("f1", "Write the What's new entry for the release with cards, screenshots and a spec case", 111, 5),
      finished("f2", "sc-56709 invite modal", 112, 20), finished("f3", "Footer links", 113, 45),
    ];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({
        list_instances: rows, get_active_sessions: rows,
        list_subchat_cards: [fin("f1", 5, "Entry written"), fin("f2", 20, "Modal done"), fin("f3", 45, "Links fixed")],
      }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const done = page.locator("#session-pane .cdash .cdash-done");
    await expect(done.locator(".dl-feat")).toHaveCount(3);
    await page.waitForTimeout(800);
    await only(page, ".cdash-done");
    await shoot(page, done, V161, "done-long-title", 24);
  });


  // ---- 0.2.162 ---------------------------------------------------------------------------------
  const V162 = "0.2.162";
  const SEND162 = "mcp__cc_conductor__send_message";
  const ASK162 = "mcp__cc_conductor__ask_user_question";
  const chatShot162 = async (page: Page, notes: unknown[], name: string): Promise<void> => {
    // The notes card lists calls; a closing report ends the turn the way a real one does.
    const history = [...notes, ...tool158(SEND162, { kind: "report", verdict: "Done", tone: "good", text: "All done." }, "m9")];
    const session = chat159("main", "Order check", 101);
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: [session], get_active_sessions: [session], list_subchats_on: [],
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
        context_status: ctx158, list_slash_commands: [], list_auto_accept: [],
      },
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const card = page.locator("#session-pane .cdash-slot[data-zone='notes'] .cdash-zone");
    await expect(card).toBeVisible();
    await page.waitForTimeout(800);
    await only(page, ".cdash-slot[data-zone='notes']");
    await shoot(page, card, V162, name, 24);
  };

  test("0.2.162 Claude keeps its tabs and can take one of yours", async ({ page }) => {
    await chatShot162(page, [
      userMsg("check the open orders in the shop admin tab I already have open"),
      ...tool158(SEND162, { kind: "call", verdict: "Took your Orders tab", text: "I am reading the Orders - Shop admin tab you already had open. When I am done I only let go of it, I never close it." }, "m1"),
      ...tool158(SEND162, { kind: "call", verdict: "Tabs I opened stay open", text: "They are still there for the next step." }, "m2"),
    ], "own-and-adopted-tabs");
  });

  test("0.2.162 Claude says when a page waits on you", async ({ page }) => {
    await chatShot162(page, [
      userMsg("log in to the supplier site and download the invoice"),
      ...tool158(SEND162, { kind: "call", verdict: "Blocked on you", text: "The supplier sign-in page is waiting for the verification code sent to your phone. I stopped instead of retrying." }, "m1"),
      ...tool158(SEND162, { kind: "call", verdict: "Waiting in the same tab", text: "Enter the code in the open window and I carry on there." }, "m2"),
    ], "blocked-on-joe");
  });

  test("0.2.162 a missed question is a line of the Plan card", async ({ page }) => {
    const T0 = Math.floor(NOW159 / 1000) - 600;
    const rows = [
      chat159("main", "CV redesign", 101),
      sub159("sub-work", "Contact form", 102, { busy: true, started_at: ago159(10 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(MIN159) } }),
    ];
    const history = [
      { type: "user_message", content: [{ type: "text", text: "tidy the old demo folders" }], timestamp: T0 },
      { type: "tool_use", tool_name: ASK162, id: "toolu_missed", timestamp: T0 + 60, parent_tool_use_id: null, input: { questions: [{ question: "Delete the wedding_dj folder now?", options: [{ label: "Yes" }, { label: "No" }] }] } },
      { type: "tool_result", tool_use_id: "toolu_missed", output: { type: "text", text: "{\"acknowledged\":true,\"note\":\"The card is shown.\"}" }, is_error: false, timestamp: T0 + 60 },
    ];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({
        list_instances: rows, get_active_sessions: rows, list_subchat_cards: [], list_pending_prompts: [], get_skipped_question_marks: [], respond_question: false,
        load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false },
      }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const plan = page.locator("#session-pane .cdash .cdash-plan");
    await expect(plan.locator(".pq-host .pf-row")).toHaveCount(1);
    await page.waitForTimeout(800);
    await only(page, ".cdash-plan");
    await shoot(page, plan, V162, "missed-question", 24);
  });

  test("0.2.162 the chats of one job are one Plan line", async ({ page }) => {
    const rows = [
      chat159("main", "CV redesign", 101),
      sub159("b1", "Bridge sub 1 reconnect", 102, { subchat_finished: true, awaiting: "done", started_at: ago159(50 * MIN159), progress: { plan: null, state_since: ago159(30 * MIN159) } }),
      sub159("b2", "Bridge sub 2 parking", 103, { busy: true, started_at: ago159(20 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(2 * MIN159) } }),
      sub159("b3", "Bridge sub 3 blocked detector", 104, { busy: true, started_at: ago159(12 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(MIN159) } }),
      sub159("b4", "Bridge sub 4 adopt tab", 105, { started_at: null as never, progress: { plan: null, state_since: null, waiting_for: "Bridge sub 3 blocked detector" } as never }),
      sub159("footer", "Footer links", 106, { busy: true, started_at: ago159(8 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(MIN159) } }),
    ];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({ list_instances: rows, get_active_sessions: rows, list_subchat_cards: [] }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const plan = page.locator("#session-pane .cdash .cdash-plan");
    await expect(plan.locator(".pf-feat")).toHaveCount(2);
    await page.waitForTimeout(800);
    await only(page, ".cdash-plan");
    await shoot(page, plan, V162, "plan-one-line", 24);
  });

  test("0.2.162 a What's new card opens fullscreen", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await mountView(page, {
      view: "sessions",
      invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [], get_active_sessions: [], is_daemon_connected: true, get_app_version: V162 },
    });
    await page.locator("#session-pane .wn-btn").click();
    await page.locator("#session-pane .wn-panel .wn-card").nth(2).locator(".wn-shot").click();
    await expect(page.locator(".lightbox-slide img")).toBeVisible();
    await expect(page.locator(".lightbox-counter")).toHaveText("3 / 5");
    await page.addStyleTag({ content: "#test-build-banner { display: none !important; }" });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(IMG, V162, "cards-fullscreen.png") });
  });

  // ---- 0.2.163 ---------------------------------------------------------------------------------
  const V163 = "0.2.163";
  const bridge163 = (n: number, pid: number, state: "done" | "busy" | "queued") => {
    const name = `Bridge sub ${n}`;
    if (state === "done") return sub159(`b${n}`, name, pid, { subchat_finished: true, awaiting: "done", started_at: ago159((60 - n) * MIN159), progress: { plan: null, state_since: ago159((40 - n * 3) * MIN159) } });
    if (state === "busy") return sub159(`b${n}`, name, pid, { busy: true, started_at: ago159(15 * MIN159), progress: { plan: PLAN159 as never, state_since: ago159(MIN159) } });
    return sub159(`b${n}`, name, pid, { started_at: null as never, progress: { plan: null, state_since: null, waiting_for: "Bridge sub 5" } as never });
  };

  test("0.2.163 a busy Plan line folds its chats into +N", async ({ page }) => {
    const states = ["done", "done", "done", "busy", "busy", "queued", "queued"] as const;
    const rows = [chat159("main", "CV redesign", 101), ...states.map((s, i) => bridge163(i + 1, 102 + i, s))];
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({ list_instances: rows, get_active_sessions: rows, list_subchat_cards: [] }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const plan = page.locator("#session-pane .cdash .cdash-plan");
    await expect(plan.locator(".pf-fold").first()).toBeVisible();
    await page.waitForTimeout(800);
    await only(page, ".cdash-plan");
    await shoot(page, plan, V163, "plan-fold", 24);
  });

  test("0.2.163 the Done card shows the last three chats and +N", async ({ page }) => {
    const rows = [chat159("main", "CV redesign", 101), ...[1, 2, 3, 4, 5, 6, 7].map((n) => bridge163(n, 101 + n, "done"))];
    const fin = (n: number) => ({
      id: `f-b${n}`, ts: NOW159 - (40 - n * 3) * MIN159, parent_id: "main", kind: "finish", sub_id: `b${n}`, sub_name: `Bridge sub ${n}`, round: 1, model: "sonnet", effort: "high",
      verdict: "Done", tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
    });
    await page.clock.setFixedTime(NOW159);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, {
      view: "sessions", chatView: "dashboard",
      invoke: dash159({ list_instances: rows, get_active_sessions: rows, list_subchat_cards: [1, 2, 3, 4, 5, 6, 7].map(fin) }),
    });
    await page.locator('#sessions-list li[data-session-id="main"]').click();
    const done = page.locator("#session-pane .cdash .cdash-done");
    await expect(done.locator(".dl-more").first()).toBeVisible();
    await page.waitForTimeout(800);
    await only(page, ".cdash-done");
    await shoot(page, done, V163, "done-more", 24);
  });
});
