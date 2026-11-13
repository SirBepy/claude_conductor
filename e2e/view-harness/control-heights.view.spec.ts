// Reviewed 2026-11-13 (suggestion rows hide while the box holds text or an attachment: composer-typing.ts, draft chip row `data-typing`): nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome): nothing this spec asserts changed. It passes.
// Reviewed 2026-11-12 (quotes as reply bubbles): renderMarkdown tags every blockquote .md-quote and lifts a leading **Name:** onto a speaker line, the transcript no longer wraps a quote in a copy card (.card-block is gone), and the draft editor's blockquote rule moved into the shared one; nothing this spec asserts changed, and it passes (chat-message-cards and subchat-passed fail their phone-width overflow tests on pristine HEAD too).
// Reviewed 2026-11-11 (embedded Composer option for the Subchats card's message box, `:is(.composer-shell, .sx-msg)` field rules in sessions.css): a chat's own composer renders and registers exactly as before; nothing this spec asserts changed.
// Reviewed 2026-11-10: pd-cards.css gained the Due card rules (day cells, missed pill); this spec measures no Due control, so its contract is unchanged and it passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05: project-settings.css gained one rule, .ps-group-title (a heading line for the new Subchats group); no control height or the controls this spec measures changed, and it passed after the change.
// Reviewed 2026-11-05: permission-modal/gating.ts and index.ts gained hydrateSubchatsOn/isSubchatsOn/setSubchatsOn (the Use subchats toggle's in-memory state, hydrated at install time) - additive; the harness's unmocked list_subchats_on rejection is caught inside the hydrate, no change to this spec's contract.
// asserts: src/styles/tokens.css, src/styles/base.css, src/styles/inputs.css, src/styles/color-picker.css, src/styles/settings-sections.css, src/views/sessions/project-picker.css, src/views/sessions/worktree-picker.css, src/views/sessions/sessions.css, src/shared/chat/composer.css, src/shared/chat/file-surface.css, src/views/sessions/drafts-panel.css, src/views/sessions/code-mode/code-mode-shell.css, src/views/sessions/code-mode/code-mode-explorer.css, src/views/sessions/code-mode/code-mode-tabs.css, src/views/sessions/project-dashboard/pd-cards.css, src/views/sessions/project-dashboard/pd-dashboard.css, src/views/sessions/project-dashboard/project-config/project-settings.css, src/shared/confirm.css, src/views/sessions/code-mode/code-mode-commits.css, src/views/sessions/code-mode/branch-switcher.css, src/shared/change-character-modal.css, src/styles/hook-modal.css, src/views/sessions/permission-modal-track.css, src/views/sessions/permission-modal-summary.css, src/shared/modal.css, src/shared/settings-popup.css
import { expect, test, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";
import { CONDUCTOR_CWD, LIST_ROWS, conductorHistory, conductorSnapshot, fakeShot } from "./project-dashboard-fixtures";

// Joe, 2026-11-02: "I don't like that we have so many different sizes for things ... I like it all to be
// consistent." Every field, select, text button and icon button on the main screens is one control height
// (--control-h in tokens.css: 36px, 44px on a phone). This measures the rendered boxes, so a new rule that
// sets its own number for a control fails here instead of being noticed by eye months later.

test.setTimeout(240_000);

const ACCT = {
  id: "acct-sub", label: "Personal", colour: "#8b5cf6", icon: "user", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind: "subscription",
};
const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_accounts: [ACCT],
  get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
  get_auth_state_map: {}, get_terminal_identity: null, list_api_keys: [], get_api_credit_status: {}, get_app_version: "0.2.137",
  get_storage_info: [], piper_status: { installed: true, voices: [] }, list_audio_output_devices: [{ name: "Speakers", is_default: true }],
  get_gaming_mode: { on: false, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false },
  get_default_whitelist: [], list_characters: [], remote_access_status: { enabled: true },
  remote_access_qr: { svg: "<svg width='80' height='80'></svg>", url: "http://x/pair", iroh: null },
  list_remote_devices: [], list_machines: { self: { machine_id: "m0", label: "Desktop", os: "windows" }, peers: [] },
  list_auto_accept: [], get_settings_load_notice: null,
};

const VIEWS = [
  "settings", "settings-appearance", "settings-notifications", "settings-chat-defaults", "settings-accounts",
  "settings-shortcuts", "settings-permissions", "settings-remote-access", "settings-data", "settings-about",
  "settings-voice", "settings-browser", "settings-power", "settings-usage-meter", "settings-characters",
  "characters", "history", "dashboard", "schedule",
];

/** Controls that are deliberately neither size, each with its reason. A new entry needs a reason a reviewer
 *  would accept: "it was already that size" is not one. Every other control is --control-h or --control-h-sm. */
const EXEMPT = [
  // A name that edits in place, drawn as plain text until hovered.
  "input.ra-name-input",
  // Segments inside a segmented switch: the switch itself (.view-toggle, .tp-seg) is measured and is control-h.
  ".view-toggle button", ".tp-seg button",
  // A two-line list row (title over a caption) that happens to be a <button>; the picker's project rows are
  // <li>s of the same shape and never measured.
  "button.wt-picker-choice",
  // The Drafts panel's person row: a 30px avatar beside a name over a caption, the same two-line shape.
  "button.dr-person",
  // The character picker's tile: a 52px portrait over a name in a grid of cards, an avatar tile and not a control in a row.
  "button.cc-char-card",
  // The review step's answer rows: the question over its chosen answer, a two-line row that happens to be a <button>.
  "button.prompt-summary-row",
  // The remove badge on an attachment chip's corner: a badge hanging off a 80px tile, not a control in a row,
  // so a 24 or 36px disc would cover the thumbnail it belongs to (20px desktop, 28px phone for the tap).
  ".composer-attachments .rm",
  // The review card's Submit on a phone is 48px on purpose: the one button that sends the whole card, so it
  // is sized above the 44px tap floor.
  "button.prompt-submit-cta",
].join(", ");

interface Offender { sig: string; h: number }

async function offenders(page: Page): Promise<{ want: number; bad: Offender[] }> {
  return page.evaluate((exempt) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const want = parseFloat(rootStyle.getPropertyValue("--control-h"));
    const small = parseFloat(rootStyle.getPropertyValue("--control-h-sm"));
    const SEL = "button, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]), select, .view-toggle, .tp-seg";
    const bad: { sig: string; h: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (el.matches(exempt)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 4 || r.height < 4 || cs.visibility === "hidden") continue;
      // A control inside a closed popover/overlay has no box of its own; off-screen ones are not on the screen.
      if (r.bottom < 0 || r.right < 0) continue;
      // Faded out and unclickable (a revert arrow that only shows once its field changed): not on the screen
      // as a control, and its rotated resting transform would inflate the box being measured.
      if (cs.opacity === "0" && cs.pointerEvents === "none") continue;
      if (Math.abs(r.height - want) > 0.6 && Math.abs(r.height - small) > 0.6) {
        const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
        bad.push({ sig: `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`, h: Math.round(r.height * 10) / 10 });
      }
    }
    return { want, bad };
  }, EXEMPT);
}

const summarise = (bad: Offender[]) => [...new Set(bad.map((b) => `${b.sig} ${b.h}px`))].sort();

/** Before/after evidence for a visual change: set PC1570_SHOTS to a folder and each call writes <name>-<width>.png. */
async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.PC1570_SHOTS;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}-${page.viewportSize()!.width}.png` });
}

for (const [label, size] of [["desktop", { width: 1200, height: 900 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`view-harness / one control height (${label})`, () => {
    test.use({ viewport: size });

    for (const view of VIEWS) {
      test(`${view}: every field, select and button is --control-h or --control-h-sm`, async ({ page }) => {
        await mountView(page, { view, invoke: INVOKE });
        await page.waitForTimeout(1200);
        const { want, bad } = await offenders(page);
        expect(want).toBe(label === "phone" ? 44 : 36);
        expect(summarise(bad)).toEqual([]);
      });
    }

    test("chat: composer, Send, header buttons, tool chips, working line and the rest of the pane", async ({ page }) => {
      const sess = sessionInstance({ busy: true, awaiting: null });
      const history = {
        events: [
          { type: "user_message", content: [{ type: "text", text: "Check the modal." }], timestamp: 0, remote_echo: false, is_meta: false },
          { type: "assistant_message", content: [{ type: "text", text: "Reading the stylesheet first." }], timestamp: 0 },
          { type: "tool_use", tool_name: "PowerShell", input: { command: "rg -n prompt-card src" }, id: "tu-1", timestamp: 0, parent_tool_use_id: null },
        ],
        oldest_seq: 0, newest_seq: 0, has_more: false,
      };
      await mountView(page, { view: "sessions", invoke: { ...INVOKE, list_instances: [sess], get_active_sessions: [sess], load_history_page: history } });
      await page.locator("#sessions-list li[data-session-id]").first().click();
      await page.locator("#session-pane .session-composer").first().waitFor();
      await waitForPaneSettled(page);
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);

      // The working bar's opened block holds Copy and Stop turn, which exist only while it is open.
      await page.locator(".thinking-main:not(:disabled)").click();
      await page.locator(".thinking-detail:not([hidden]) .thinking-stop-turn").waitFor();
      await page.locator(".thinking-detail:not([hidden]) .thinking-copy").waitFor();
      const opened = await offenders(page);
      expect(summarise(opened.bad)).toEqual([]);
    });

    // On a phone a wrapped message moves the paperclip out of the field and stacks it above Send, and a staged
    // attachment hangs a remove badge off its chip. Neither exists until the composer holds that content.
    test("chat composer: wrapped message with attachment chips keeps the paperclip and Send on the scale", async ({ page }) => {
      const sess = sessionInstance({ busy: false, awaiting: null });
      await mountView(page, {
        view: "sessions",
        invoke: { ...INVOKE, list_instances: [sess], get_active_sessions: [sess], paste_attachment: "C:/tmp/pasted.png" },
      });
      await page.locator("#sessions-list li[data-session-id]").first().click();
      await page.locator("#session-pane .session-composer").first().waitFor();
      await waitForPaneSettled(page);

      await page.locator(".composer-file-input").setInputFiles([
        { name: "shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") },
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
      ]);
      await page.locator(".composer-attachments .attachment").nth(1).waitFor();
      await page.waitForFunction(() => document.querySelectorAll(".composer-attachments .attachment.uploading").length === 0);
      await page.locator("#session-pane .session-composer .composer-textarea").first().fill(Array.from({ length: 6 }, (_, i) => `Line ${i + 1} of a message long enough to wrap.`).join("\n"));
      await page.waitForFunction(() => !!document.querySelector(".composer-row--tall"));
      await page.waitForTimeout(300);

      const { want, bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
      // The paperclip is only displayed on a phone; there it must be a full control, not a shorter box than Send.
      if (label === "phone") {
        const clip = (await page.locator(".composer-row--tall .composer-attach").boundingBox())!;
        expect(Math.round(clip.height)).toBe(want);
      }
    });

    // Code mode covers the chat with its own explorer, file tabs and diff viewer. Opened on the whole repo, then
    // a file, then the scope menu, so the explorer rows, the tab strip and the menu are all on screen.
    test("code mode: explorer, scope menu, file tab and diff viewer", async ({ page }) => {
      page.setDefaultTimeout(15_000);
      const cwd = "C:/Projects/alpha";
      const sess = sessionInstance({ cwd, name: "Code mode review", busy: false });
      const files = [
        { path: "src/views/sessions/git-card.ts", status: "M", added: 3, removed: 1, old_path: null },
        { path: "src/shared/shortcuts.ts", status: "M", added: 3, removed: 8, old_path: null },
      ];
      const row = ["model", "git", "commits"];
      await mountView(page, {
        view: "sessions",
        invoke: {
          ...INVOKE, list_instances: [sess], get_active_sessions: [sess], session_live_cwd: cwd,
          load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
          get_settings: { theme: "void", statuslineRowsV2Applied: true, statuslineRows: [row], statuslineRowsMobile: [row] },
          get_git_info: { branch: "master", repo: "alpha", ahead: 2, behind: 0, sha: "abc1234", insertions: null, deletions: null },
          get_commit_sync: { ahead: [{ short_sha: "8b3cb30", message: "FIX: a thing" }], behind: [], has_upstream: true },
          get_recent_branches: [
            { name: "master", current: true, short_sha: "8b3cb30", upstream: "origin/master" },
            { name: "feature/preview-me", current: false, short_sha: "1a2b3c4", upstream: null },
          ],
          get_git_dirty: [files[0]!.path], get_range_files: files,
          get_file_diff: "diff --git a/src/shared/shortcuts.ts b/src/shared/shortcuts.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n",
          get_file_at_rev: { content: "export const x = 1;\n", truncated: false },
          list_project_files: [...files.map((f) => f.path), "README.md"],
        },
      });
      await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
      await page.locator("#session-pane .session-composer").first().waitFor();
      await waitForPaneSettled(page);
      // The statusbar's commits chip is the one entry that exists at both widths; it opens the Unpushed range,
      // so the whole repo is one scope-menu pick away.
      await page.locator("#session-pane .sb-commits-btn").click();
      const code = page.locator(".code-mode");
      await code.waitFor();
      await code.locator(".cm-qtitle").click();
      await code.locator('.cm-mi[data-scope="all"]').click();
      const closed = code.locator('.cm-dir[aria-expanded="false"]');
      while (await closed.count()) await closed.first().click();
      await code.locator('[data-file="README.md"]').click();
      await page.waitForTimeout(600);
      const shown = await offenders(page);
      expect(summarise(shown.bad)).toEqual([]);
      await code.locator(".cm-qtitle").click();
      await code.locator('.cm-mi[data-scope="chat"]').waitFor();
      const menu = await offenders(page);
      expect(summarise(menu.bad)).toEqual([]);

      // A changed file opens its diff toolbar; the file menu holds Search, which opens the find bar.
      await code.locator('.cm-mi[data-scope="unpushed"]').click();
      while (await closed.count()) await closed.first().click();
      const unpushed = await offenders(page);
      expect(summarise(unpushed.bad)).toEqual([]);
      // The commit rows, the Push and Pull buttons and the branch button sit behind the commits fold.
      const fold = code.locator(".cm-fold");
      if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
      await code.locator(".cm-pushtext").first().waitFor();
      const commits = await offenders(page);
      expect(summarise(commits.bad)).toEqual([]);
      await code.locator(".cm-branchbtn").click();
      await page.locator(".bs-search input").waitFor();
      await page.waitForTimeout(400);
      const branches = await offenders(page);
      expect(summarise(branches.bad)).toEqual([]);
      await page.keyboard.press("Escape");
      await code.locator(`[data-file="${files[1]!.path}"]`).click();
      await code.locator(".fs-menu-btn").first().click();
      const fileMenu = await offenders(page);
      expect(summarise(fileMenu.bad)).toEqual([]);
      await code.locator('.fs-mi[data-act="search"]').first().click();
      await code.locator(".fs-search:not(.fs-hidden)").first().waitFor();
      const search = await offenders(page);
      expect(summarise(search.bad)).toEqual([]);
    });

    // The Drafts panel is a list of cards that opens into an editor with version and recipient controls.
    test("drafts panel: list, then an opened draft with its editor controls", async ({ page }) => {
      page.setDefaultTimeout(15_000);
      const now = new Date().toISOString();
      const ver = (n: number, body: string) => ({ n, body, author: "ai", note: "pass", created_at: "2026-08-26T08:00:00Z" });
      const draft = {
        id: "aaaaaaaa-1111-4111-8111-111111111111", topic: "Sprint slip heads-up", brief: "Tell Bruno it is late.",
        receipts: [{ claim: "refreshToken()", source: "src/auth/session.ts:88" }],
        variants: [
          { recipient: "Bruno", handle_n: 2, current: 2, versions: [ver(1, "Hey Bruno, late."), ver(2, "Hey Bruno - slips.")] },
          { recipient: "Ana", handle_n: 1, current: 1, versions: [ver(1, "Hi Ana, a few more days.")] },
        ],
        state: "needs-you", origin_session_id: "sess-A", origin_label: "auth-work", created_at: now, updated_at: now, seen_by_origin: true,
      };
      // A sent ticket comment: a Linear variant makes the tab strip appear, a sent draft is the line the eye reveals,
      // and Joe's own version of it is what offers Check & learn.
      const sent = {
        ...draft, id: "bbbbbbbb-2222-4222-8222-222222222222", topic: "REV-7345 rollout note", state: "copied",
        variants: [{ recipient: "Ana", platform: "Linear", handle_n: 1, current: 2, versions: [ver(1, "Rollout starts Monday."), { ...ver(2, "Rollout starts Monday, flag on."), author: "user" }] }],
      };
      await mountView(page, { invoke: { ...INVOKE, list_slash_commands: [], list_message_drafts: { drafts: [draft, sent] } } });
      await page.evaluate(async () => {
        const host = document.createElement("div");
        host.id = "drafts-spec-host";
        host.style.cssText = "position:fixed;top:40px;left:0;width:min(400px,100vw);height:520px;z-index:1;display:flex;background:var(--color-background)";
        document.body.appendChild(host);
        const mod = await import("/views/sessions/drafts-panel.ts");
        mod.mountDraftsPanel(host).setSessionScope("sess-A");
      });
      const panel = page.locator("#drafts-spec-host.drafts-panel");
      await panel.locator(".dr-card").first().waitFor();
      const list = await offenders(page);
      expect(summarise(list.bad)).toEqual([]);
      await panel.locator(".dr-tab").first().waitFor();
      await panel.locator(".dr-eye").first().click();
      await panel.locator(".dr-tab").nth(1).click();
      await panel.locator("[data-ticket]").first().click();
      await panel.locator(".dr-line").first().waitFor();
      const tracker = await offenders(page);
      expect(summarise(tracker.bad)).toEqual([]);
      await panel.locator(".dr-line").first().click();
      await panel.locator(".dr-learn").waitFor();
      const learn = await offenders(page);
      expect(summarise(learn.bad)).toEqual([]);
      await panel.locator("[data-back]").click();
      await panel.locator("[data-list]").click();
      await panel.locator(".dr-tab").first().click();
      await panel.locator(".dr-card").first().click();
      await panel.locator(".dr-body").waitFor();
      const opened = await offenders(page);
      expect(summarise(opened.bad)).toEqual([]);
      // The formatting bar slides in only while the body has focus.
      await panel.locator(".dr-body").focus();
      await page.waitForTimeout(400);
      const editing = await offenders(page);
      expect(summarise(editing.bad)).toEqual([]);
      await panel.locator(".dr-ver-btn").click();
      await panel.locator(".dr-ver-list").waitFor();
      const versions = await offenders(page);
      expect(summarise(versions.bad)).toEqual([]);
    });

    // The in-app confirm every destructive action goes through: two buttons, nothing else.
    test("confirm dialog: both buttons are full controls", async ({ page }) => {
      page.setDefaultTimeout(15_000);
      await mountView(page, { invoke: INVOKE });
      await page.evaluate(async () => {
        const mod = await import("/shared/confirm.ts");
        void mod.askConfirm("Remove this account? Its chats stay.", { confirmLabel: "Remove" });
      });
      await page.locator(".app-confirm").waitFor();
      await page.waitForTimeout(400);
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });

    // The project page opened from a chat header: the dashboard cards beside the project settings rail, whose
    // fields and toggles are the screen's controls.
    test("project dashboard: page header, cards and the settings rail", async ({ page }) => {
      page.setDefaultTimeout(15_000);
      const sess = sessionInstance({ session_id: "s-q", pid: 202, name: "Dashboard chat", cwd: CONDUCTOR_CWD, awaiting: null });
      await mountView(page, {
        view: "sessions",
        invoke: {
          ...INVOKE, list_instances: [sess], get_active_sessions: [sess],
          load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
          dashboard_list_targets: LIST_ROWS, dashboard_snapshot: conductorSnapshot(), dashboard_history: conductorHistory(),
          dashboard_closed_chats: [], dashboard_gallery_image: fakeShot(0),
        },
      });
      await page.locator("#sessions-list li[data-session-id=\"s-q\"]").click();
      await page.locator("#session-pane .session-header .meta-proj").click();
      await page.locator(".pd-root.is-page").waitFor();
      await page.waitForTimeout(1000);
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });

    // A modal body is a flex column holding a field above a long scrolling list. With enough rows the field
    // becomes a shrink candidate, so this uses far more rows than fit: a short list never exposes it.
    test("project picker: search field and footer stay full height beside a long list", async ({ page }) => {
      const projects = Array.from({ length: 60 }, (_, i) => ({
        id: `proj-${i}`, path: `C:/Projects/app-${i}`, name: `app-${i}`, parent_segment: null,
        avatar: { kind: "none" }, tokens_7d: 0, live: 0, any_automated: false, last_active_at: null,
        path_exists: true, worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
      }));
      await mountView(page, {
        invoke: {
          ...INVOKE, list_project_groups: projects, project_last_activity_at: 0, count_ai_todos: 0,
          list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }], list_worktree_details: [],
          get_accounts_setup_prompt_state: { shouldShow: false },
          list_machines: { self: { machine_id: "m0", label: "Desktop", os: "windows" }, peers: [{ machine_id: "m1", label: "mac", os: "macos" }] },
        },
      });
      await page.evaluate(() => {
        void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
      });
      await page.waitForSelector(".project-picker-row");
      await page.waitForTimeout(800);
      const { want, bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
      const search = (await page.locator("#project-picker-search").boundingBox())!;
      expect(Math.round(search.height)).toBe(want);
    });

    test("worktree picker: every field and button stays full height beside a long worktree list", async ({ page }) => {
      const wts = Array.from({ length: 40 }, (_, i) => ({ path: `C:/repo/wt-${i}`, name: `wt-${i}`, tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }));
      const project = {
        id: "proj1", path: "C:/repo", name: "repo", parent_segment: null, avatar: { kind: "none" }, tokens_7d: 0, live: 0,
        any_automated: false, last_active_at: null, path_exists: true, worktrees: wts, last_worktree_path: null, last_start_folder_rel: null,
      };
      await mountView(page, {
        invoke: {
          ...INVOKE, list_project_groups: [project], project_last_activity_at: 0, count_ai_todos: 0,
          list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
          list_worktree_details: wts.map((w) => ({ path: w.path, name: w.name, branch: w.name, last_commit_at: null, stale: false, stale_reason: null })),
          get_accounts_setup_prompt_state: { shouldShow: false },
        },
      });
      await page.evaluate(() => {
        void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
      });
      await page.locator(".project-picker-row").click();
      await page.locator(".loc-chip").click();
      await page.waitForSelector(".wt-picker-modal");
      await page.waitForFunction(() => !document.querySelector(".wt-picker-modal")?.classList.contains("modal-card-morph-hidden"));
      await page.waitForTimeout(800);
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });

    // Modals draw over whatever is underneath. Each is opened with only the mocks its own code reads.
    test("change-character modal: tabs, search, Random, Save and the cards", async ({ page }) => {
      page.setDefaultTimeout(30_000);
      const chars = ["c1", "c2", "c3", "c4"].map((id, i) => ({ id, label: ["Alexstrasza", "Anduin", "Arthas", "Azmodan"][i], version: 1, icon: "icon.png", game_label: "Heroes of the Storm", slots: {} }));
      await mountView(page, { invoke: { ...INVOKE, resolve_whitelist_characters: chars, list_characters: chars, character_asset_url: null, play_character_slot: null } });
      await page.evaluate(async () => {
        const mod = await import("/shared/change-character-modal.ts");
        void mod.openChangeCharacterModal({ projectId: "proj1", currentId: "c2" });
      });
      await page.locator(".cc-char-card").first().waitFor();
      await page.waitForTimeout(600);
      await shoot(page, "change-character");
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });

    test("hook modal: Enable, Not now and Never", async ({ page }) => {
      page.setDefaultTimeout(30_000);
      await mountView(page, { invoke: { ...INVOKE, get_hook_registration_state: { registered: false, declined: false, port: 27182 } } });
      await page.evaluate(async () => { await (await import("/shared/boot.ts")).maybeShowHookModal(); });
      await page.locator("#hookModalAccept").waitFor();
      await page.waitForTimeout(400);
      await shoot(page, "hook-modal");
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });

    // Settings in the Chats window is a popup over the chat; its pages are measured above as full screens, so
    // this measures the same pages inside the popup frame (its own header and close button).
    test("settings popup: the frame, its close button and the index inside it", async ({ page }) => {
      page.setDefaultTimeout(30_000);
      await mountView(page, { view: "blank", invoke: { ...INVOKE, list_installed_skills: [], list_projects: [] } });
      await page.evaluate(async () => {
        document.body.classList.add("chats-window-mode");
        const chat = document.createElement("main");
        chat.id = "fake-chat";
        chat.style.cssText = "position:fixed;inset:0 44px 0 0;background:#14141c";
        document.body.appendChild(chat);
        (await import("/shared/navigation.ts")).setActiveView("sessions");
        const rail = await import("/shared/app-rail.ts");
        rail.mountAppRail();
        rail.syncAppRail("sessions");
      });
      await page.locator("#app-rail [data-rail-go=\"settings\"]").click();
      await page.locator(".settings-popup .view-settings").waitFor();
      await page.waitForTimeout(800);
      await shoot(page, "settings-popup");
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });

    test("question card: header button, options, answer field and footer", async ({ page }) => {
      await mountView(page, { invoke: { respond_question: null } });
      await page.evaluate(async () => {
        const qm = await import("/views/sessions/permission-modal/index.ts");
        const sm = await import("/views/sessions/state.ts");
        sm.state.selectedId = "sess-1";
        qm.setSelectedSessionId("sess-1");
        const pane = document.createElement("div");
        pane.innerHTML = '<div class="session-composer"></div>';
        document.body.appendChild(pane);
        qm.handleQuestionRequested({
          id: "q1", session_id: "sess-1",
          questions: [
            { question: "Which lane should the builder take?", header: "Lane", options: [{ label: "Inline" }, { label: "Subagent" }] },
            { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Unit" }, { label: "E2E" }] },
          ],
        });
      });
      await page.locator(".prompt-card").waitFor();
      await page.waitForTimeout(600);
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);

      // The review step's Submit is EXEMPT from the scan, so it is measured here by hand: a desktop one is a plain
      // --control-h button, only the phone one is the deliberate 48px.
      await page.locator(".prompt-card .prompt-dot[data-dot=\"2\"]").click();
      const submit = page.locator(".prompt-card__footer > [data-act=\"primary\"].prompt-submit-cta");
      await submit.waitFor();
      await page.waitForTimeout(400);
      const review = await offenders(page);
      expect(summarise(review.bad)).toEqual([]);
      const h = (await submit.boundingBox())!.height;
      expect(Math.round(h)).toBe(label === "phone" ? 48 : review.want);
    });
  });
}
