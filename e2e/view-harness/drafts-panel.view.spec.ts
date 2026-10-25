// Reviewed 2026-10-25 (desktop split): mountDraftsPanel gained an optional open-count callback for the split strip; this spec mounts without it, so its contract is unaffected.
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// shotDir() resolves the running session's own id and creates the directory - never a
// hand-rolled literal (todo 958).
const SCREENSHOT_DIR = shotDir();

// Todo 666, the Drafts panel. Drives the REAL panel and editor, not internal
// state. The harness's invoke map is fixed at mount, so this swaps in a
// stateful in-page fake - an edit has to change what the next list call
// returns, or the round-trip half is theatre.

const VIEWER = "sess-A";

// The panel hides anything untouched for a week, so the seed has to be fresh
// relative to the run, not pinned to a calendar date.
const NOW_ISO = new Date().toISOString();
const HOUR_AGO_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function version(n: number, body: string, author: "ai" | "user", note: string) {
  return { n, body, author, note, created_at: "2026-08-26T08:00:00Z" };
}

const SEED = [
  {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    topic: "Sprint slip heads-up",
    brief: "Tell Bruno the auth migration is late.",
    receipts: [{ claim: "refreshToken()", source: "src/auth/session.ts:88" }],
    variants: [
      {
        recipient: "Bruno",
        handle_n: 2,
        current: 2,
        versions: [
          version(1, "Hey Bruno, the **auth migration** is late.", "ai", "first pass"),
          version(2, "Hey Bruno - the **auth migration** slips.\n\n- Ship behind a flag\n- Hold to Monday", "ai", "softened"),
        ],
      },
      {
        recipient: "Ana",
        handle_n: 1,
        current: 1,
        versions: [version(1, "Hi Ana, the login work needs a few more days.", "ai", "first pass")],
      },
    ],
    state: "needs-you",
    origin_session_id: VIEWER,
    origin_label: "auth-work",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    seen_by_origin: true,
  },
  {
    id: "bbbbbbbb-2222-4222-8222-222222222222",
    topic: "Invoice follow-up, March",
    brief: "",
    receipts: [],
    variants: [
      {
        recipient: "Marko",
        handle_n: 1,
        current: 1,
        versions: [version(1, "Hi Marko, following up on invoice 2026-03-14.", "ai", "first pass")],
      },
    ],
    state: "needs-you",
    origin_session_id: VIEWER,
    origin_label: "auth-work",
    created_at: HOUR_AGO_ISO,
    updated_at: HOUR_AGO_ISO,
    seen_by_origin: true,
  },
];

async function mountPanel(page: Page, hostCss?: string) {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(
    async ({ seed, viewer, hostCss }) => {
      const w = window as unknown as Record<string, any>;
      const store = { drafts: JSON.parse(JSON.stringify(seed)) };
      w.__draftStore = store;
      w.__clipboard = [];

      // Capture both payloads rather than granting real clipboard access: the
      // dual text/html + text/plain write IS the thing under test.
      // defineProperty, not assignment: navigator.clipboard is an accessor on
      // the prototype, so a plain write is silently dropped.
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: async (items: any[]) => {
            const out: Record<string, string> = {};
            for (const item of items) {
              for (const type of item.types) out[type] = await (await item.getType(type)).text();
            }
            w.__clipboard.push(out);
          },
          writeText: async (text: string) => { w.__clipboard.push({ "text/plain": text }); },
        },
      });

      const tauri = (window as any).__TAURI__;
      const passthrough = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args: any) => {
        const find = (id: string) => store.drafts.find((d: any) => d.id === id);
        const pick = (d: any, recipient: string) =>
          d.variants.find((v: any) => v.recipient === recipient) ?? d.variants[0];
        switch (cmd) {
          case "list_message_drafts":
            return Promise.resolve({ drafts: store.drafts });
          case "set_draft_body": {
            const d = find(args.id);
            if (d) {
              const v = pick(d, args.recipient);
              const last = v.versions[v.versions.length - 1];
              // Mirrors the daemon: coalesce into his own newest version.
              if (last.author === "user" && last.n === v.current) {
                last.body = args.body;
              } else {
                v.versions.push({
                  n: last.n + 1,
                  body: args.body,
                  author: "user",
                  note: "your edit",
                  created_at: "2026-08-26T09:00:00Z",
                });
                v.current = last.n + 1;
              }
              d.seen_by_origin = false;
            }
            return Promise.resolve(null);
          }
          case "set_draft_version": {
            const d = find(args.id);
            if (d) pick(d, args.recipient).current = args.n;
            return Promise.resolve(null);
          }
          case "set_draft_state": {
            const d = find(args.id);
            if (d) d.state = args.next;
            return Promise.resolve(null);
          }
          default:
            return passthrough(cmd, args);
        }
      };

      const host = document.createElement("div");
      host.id = "drafts-spec-host";
      // Below the harness page's own TEST BUILD banner, which paints above this
      // host and would otherwise sit across the panel header in a capture.
      host.style.cssText =
        hostCss ??
        "position:fixed;top:40px;left:0;width:400px;height:520px;z-index:1;display:flex;background:var(--color-background)";
      document.body.appendChild(host);

      const mod = await import("/views/sessions/drafts-panel.ts");
      w.__draftsHandle = mod.mountDraftsPanel(host);
      w.__draftsHandle.setSessionScope(viewer);
    },
    { seed: SEED, viewer: VIEWER, hostCss },
  );

  const panel = page.locator("#drafts-spec-host.drafts-panel");
  await expect(panel.locator(".dr-card").first()).toBeVisible();
  return panel;
}

test("the list pins this chat's drafts and gives each person one row", async ({ page }) => {
  const panel = await mountPanel(page);

  await expect(panel.locator(".dr-group").first()).toHaveText("From this chat");
  await expect(panel.locator(".dr-card")).toHaveCount(2);
  const first = panel.locator(".dr-card").first();
  // One line per draft: the topic, no preview text, who it is for on hover.
  await expect(first.locator(".dr-topic")).toHaveText("Sprint slip heads-up");
  await expect(first).toHaveAttribute("title", "To Bruno, Ana");
  await expect(first).not.toContainText("auth migration");
  // One row per person, not one card per message: a two-recipient card gives
  // both people a row.
  await expect(panel.locator(".dr-person .dr-person-name")).toHaveText(["Bruno", "Ana", "Marko"]);
  await expect(panel.locator(".dr-person").first().locator(".dr-count")).toHaveText("1");
});

test("opening a card renders the markdown as real formatting, not markers", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  const body = panel.locator(".dr-body");
  await expect(body).toBeVisible();
  await expect(body.locator("strong")).toHaveText("auth migration");
  await expect(body).not.toContainText("**");
  await expect(body.locator("li")).toHaveCount(2);
  await expect(panel.locator(".dr-title")).toHaveText("Sprint slip heads-up");
  await expect(body).toHaveAttribute("contenteditable", "true");
});

test("an edit round-trips to the store as markdown and comes back as a your-edit version", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".dr-body")!;
    body.innerHTML = "<p>Bruno - it <strong>slips</strong> to Thursday.</p>";
    body.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Back navigation flushes, so the debounce never has to be waited out.
  await panel.locator("[data-back]").click();

  const stored = await page.evaluate(() => {
    const v = (window as any).__draftStore.drafts[0].variants[0];
    return v.versions[v.versions.length - 1];
  });
  expect(stored.body).toBe("Bruno - it **slips** to Thursday.");
  expect(stored.author).toBe("user");

  await expect(panel.locator(".dr-card").first().locator('.dr-mark[title="Your edit"]')).toHaveCount(1);
});

test("a recipient tab swaps to that person's own version track", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  await expect(panel.locator(".dr-who-tab")).toHaveText(["Bruno", "Ana"]);
  await expect(panel.locator(".dr-body")).toContainText("Hey Bruno");
  await panel.locator('[data-recipient="Ana"]').click();

  await expect(panel.locator(".dr-body")).toContainText("Hi Ana");
  await expect(panel.locator(".dr-body")).not.toContainText("Hey Bruno");
  // Ana's track is one version deep: a plain "v1", no picker offering Bruno's v2.
  await expect(panel.locator("[data-versions]")).toHaveCount(0);
  await expect(panel.locator(".dr-ver-only")).toHaveText("v1");
});

test("a one-recipient draft shows no recipient tabs", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-person", { hasText: "Marko" }).click();
  await panel.locator(".dr-card").click();
  await expect(panel.locator(".dr-title")).toHaveText("Invoice follow-up, March");
  await expect(panel.locator(".dr-who-tab")).toHaveCount(0);
});

test("the version chip opens every version, newest first and labelled, and picking one shows it", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  await expect(panel.locator("[data-versions]")).toContainText("v2");
  await panel.locator("[data-versions]").click();
  await expect(panel.locator(".dr-ver-row .dr-ver-n")).toHaveText(["v2", "v1"]);
  await expect(panel.locator(".dr-ver-row .dr-ver-note")).toHaveText(["softened", "first pass"]);

  await panel.locator('[data-version-n="1"]').click();
  await expect(panel.locator(".dr-ver-list")).toHaveCount(0);
  await expect(panel.locator(".dr-body")).toContainText("is late.");
  await expect(panel.locator("[data-versions]")).toContainText("v1");
});

test("the editor has no Ready or Delete button, and formatting only shows while typing", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  await expect(panel.locator("[data-ready]")).toHaveCount(0);
  await expect(panel.locator("[data-delete]")).toHaveCount(0);
  await expect(panel.locator(".dr-bar")).toBeHidden();
  const topBefore = (await panel.locator(".dr-body").boundingBox())!.y;
  await panel.locator(".dr-body").click();
  await expect(panel.locator(".dr-bar")).toBeVisible();
  // The row opens under the body, so the text itself never moves down.
  await page.waitForTimeout(250);
  expect((await panel.locator(".dr-body").boundingBox())!.y).toBe(topBefore);
  const bodyBox = (await panel.locator(".dr-body").boundingBox())!;
  expect((await panel.locator(".dr-bar").boundingBox())!.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height - 0.5);
  // Pressing a format button keeps the body focused, so the row stays.
  await panel.locator('[data-cmd="bold"]').click();
  await expect(panel.locator(".dr-bar")).toBeVisible();
});

test("Copy writes rich HTML and markdown in one clipboard call, and marks the card copied", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();
  await panel.locator("[data-copy]").click();

  await expect.poll(() => page.evaluate(() => (window as any).__clipboard.length)).toBe(1);
  const payload = await page.evaluate(() => (window as any).__clipboard.at(-1));
  expect(payload["text/html"]).toContain("<strong>auth migration</strong>");
  expect(payload["text/plain"]).toContain("**auth migration**");
  expect(payload["text/plain"]).toContain("- Ship behind a flag");

  await expect
    .poll(() => page.evaluate(() => (window as any).__draftStore.drafts[0].state))
    .toBe("copied");
});

test("a webview that refuses the rich write gets Slack-ready plain text, never markdown syntax", async ({ page }) => {
  const panel = await mountPanel(page);
  await page.evaluate(() => {
    (navigator.clipboard as any).write = () => Promise.reject(new Error("NotAllowedError"));
  });
  await panel.locator(".dr-card").first().click();
  await panel.locator("[data-copy]").click();

  await expect.poll(() => page.evaluate(() => (window as any).__clipboard.length)).toBe(1);
  const payload = await page.evaluate(() => (window as any).__clipboard.at(-1));
  expect(payload["text/html"]).toBeUndefined();
  expect(payload["text/plain"]).toContain("*auth migration*");
  expect(payload["text/plain"]).not.toContain("**");
});

test("the bold button marks the selection instead of typing asterisks", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  await panel.locator(".dr-body").click();
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".dr-body")!;
    body.innerHTML = "<p>plain words</p>";
    const target = body.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await panel.locator('[data-cmd="bold"]').click();

  await expect(panel.locator(".dr-body b, .dr-body strong")).toHaveText("plain");
});

test("a refresh that brings back the same drafts keeps the rows, so a click landing mid-refresh still counts", async ({ page }) => {
  const panel = await mountPanel(page);
  await page.evaluate(() => {
    (window as any).__row = document.querySelector("#drafts-spec-host .dr-person");
    (window as any).__lists = 0;
    const tauri = (window as any).__TAURI__;
    const inner = tauri.core.invoke;
    tauri.core.invoke = (cmd: string, args: any) => {
      if (cmd === "list_message_drafts") (window as any).__lists++;
      return inner(cmd, args);
    };
    // Focusing the window refetches the list - the same path a first click
    // into an unfocused window takes, between its mousedown and mouseup.
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__lists)).toBeGreaterThan(0);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as any).__row.isConnected)).toBe(true);
  await panel.locator(".dr-person", { hasText: "Marko" }).click();
  await expect(panel.locator(".dr-title")).toHaveText("Marko");
});

test("a person row opens just their drafts, and Archive hides one behind the eye without deleting it", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-person", { hasText: "Marko" }).click();

  await expect(panel.locator(".dr-title")).toHaveText("Marko");
  await expect(panel.locator(".dr-person-sub")).toHaveText("Not in your vault");
  await expect(panel.locator(".dr-card")).toHaveCount(1);
  // Nothing done yet, so there is nothing for an eye to reveal.
  await expect(panel.locator("[data-eye]")).toHaveCount(0);

  await panel.locator(".dr-card").click();
  await panel.locator("[data-archive]").click();

  await expect
    .poll(() => page.evaluate(() => (window as any).__draftStore.drafts[1].state))
    .toBe("archived");
  // Back on Marko's view: nothing open, no fold, the archived draft behind the eye.
  await expect(panel.locator(".dr-none")).toHaveText("Nothing open.");
  await expect(panel.locator(".dr-line")).toHaveCount(0);
  await panel.locator("[data-eye]").click();
  await expect(panel.locator(".dr-quiet .dr-line")).toHaveCount(1);
  await expect(panel.locator('.dr-line .dr-mark[title="Archived"]')).toHaveCount(1);

  // The eye stays on for the list: Marko, now with nothing open, sits dimmed below the line.
  await panel.locator("[data-list]").click();
  await expect(panel.locator(".dr-group").first()).toHaveText("From this chat");
  await expect(panel.locator(".dr-quiet .dr-person-name")).toHaveText(["Marko"]);
  await panel.locator("[data-eye]").click();
  await expect(panel.locator(".dr-quiet")).toHaveCount(0);
});

test("the panel has no fold rows: done drafts only show while the eye is on", async ({ page }) => {
  const panel = await mountPanel(page);
  await page.evaluate(() => {
    const store = (window as any).__draftStore;
    store.drafts[1].state = "copied";
    window.dispatchEvent(new Event("focus"));
  });
  await expect(panel.locator(".dr-person .dr-person-name")).toHaveText(["Bruno", "Ana"]);
  await expect(panel.locator(".dr-fold")).toHaveCount(0);
  await expect(panel.locator("[data-eye]")).toHaveAttribute("aria-pressed", "false");

  await panel.locator("[data-eye]").click();
  await expect(panel.locator("[data-eye]")).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".dr-quiet .dr-person-name")).toHaveText(["Marko"]);
  const opacity = await panel.locator(".dr-quiet .dr-person").first().evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(opacity)).toBeLessThan(1);
});

test("a Shortcut comment gets a Shortcut tab with one row per ticket, and stays under its person", async ({ page }) => {
  const panel = await mountPanel(page);
  await page.evaluate((iso) => {
    const store = (window as any).__draftStore;
    store.drafts.push({
      id: "cccccccc-3333-4333-8333-333333333333",
      topic: "sc-56157 retest note",
      brief: "",
      receipts: [],
      // The Shortcut comment is the SECOND variant: the ticket view must show
      // it, not the email to Ana that happens to come first.
      variants: [{
        recipient: "Ana",
        handle_n: 2,
        current: 1,
        platform: "Email",
        versions: [{ n: 1, body: "Hi Ana", author: "ai", note: "first pass", created_at: iso }],
      }, {
        recipient: "Bruno",
        handle_n: 3,
        current: 1,
        platform: "Shortcut",
        versions: [{ n: 1, body: "@bruno a draft now only counts once", author: "ai", note: "first pass", created_at: iso }],
      }],
      state: "needs-you",
      origin_session_id: "sess-B",
      origin_label: "zirtue",
      created_at: iso,
      updated_at: iso,
      seen_by_origin: true,
    });
    window.dispatchEvent(new Event("focus"));
  }, NOW_ISO);

  await expect(panel.locator(".dr-tab")).toHaveText(["People", "Shortcut"]);
  // Under Bruno too: one draft, two ways in.
  await expect(panel.locator(".dr-person", { hasText: "Bruno" }).locator(".dr-count")).toHaveText("2");

  await panel.locator('.dr-tab', { hasText: "Shortcut" }).click();
  const row = panel.locator(".dr-ticket");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".dr-ticket-id")).toHaveText("sc-56157");
  await expect(row.locator(".dr-ticket-label")).toHaveText("retest note");

  await row.click();
  await expect(panel.locator(".dr-title")).toHaveText("sc-56157");
  await expect(panel.locator(".dr-person-sub")).toHaveText("Bruno");
  await expect(panel.locator(".dr-card .dr-topic")).toHaveText("retest note");
  await expect(panel.locator(".dr-card .dr-av")).toHaveText("B");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/drafts-panel-ticket.png`, clip: (await page.locator("#drafts-spec-host").boundingBox())! });
});

test("an empty project explains what the panel is for instead of showing a blank box", async ({ page }) => {
  await mountPanel(page);
  await page.evaluate(() => {
    (window as any).__draftStore.drafts = [];
    window.dispatchEvent(new Event("focus"));
  });

  const panel = page.locator("#drafts-spec-host.drafts-panel");
  await expect(panel.locator(".dr-empty")).toBeVisible();
  await expect(panel.locator(".dr-card")).toHaveCount(0);
});

// Todo 803: the FAB card is 400x390 (40px spine + 360x390 body), 130px
// shorter than every prior render of this panel. Measures the actual card
// geometry, not the 400x520 the rest of this file uses.
test("the footer stays inside the card and the toolbar stays reachable at the real 360x390 body size", async ({ page }) => {
  const hostCss =
    "position:fixed;top:40px;left:0;width:360px;height:390px;z-index:1;display:flex;background:var(--color-background)";
  const panel = await mountPanel(page, hostCss);
  await panel.locator(".dr-card").first().click();

  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".dr-body")!;
    body.innerHTML =
      "<p>Line one of a longer draft.</p><p>Line two follows right after.</p>" +
      "<p>Line three keeps going.</p><p>Line four is still here.</p>" +
      "<p>Line five nears the end.</p><p>Line six closes it out.</p>";
    body.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await panel.locator(".dr-body").click();

  const host = page.locator("#drafts-spec-host");
  const hostBox = (await host.boundingBox())!;
  const footBox = (await panel.locator(".dr-foot").boundingBox())!;
  const barBox = (await panel.locator(".dr-bar").boundingBox())!;
  const bodyBox = (await panel.locator(".dr-body").boundingBox())!;

  const hostBottom = hostBox.y + hostBox.height;
  // getBoundingClientRect, not offsetHeight: offsetHeight rounds and misreports
  // clipping at fractional DPI scale.
  expect(footBox.y + footBox.height).toBeLessThanOrEqual(hostBottom + 0.5);
  expect(barBox.y).toBeGreaterThanOrEqual(hostBox.y - 0.5);
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(hostBottom + 0.5);
  // The body still gets real room between the pinned toolbar and footer -
  // min-height alone would not prove the flex chrome actually yielded space.
  expect(bodyBox.height).toBeGreaterThan(60);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/drafts-panel-360x390.png`, clip: hostBox });
});
