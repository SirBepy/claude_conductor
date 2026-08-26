import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Todo 666, the Drafts panel. Drives the REAL panel and editor, not internal
// state. The harness's invoke map is fixed at mount, so this swaps in a
// stateful in-page fake - an edit has to change what the next list call
// returns, or the round-trip half is theatre.

const VIEWER = "sess-A";

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
    created_at: "2026-08-26T08:00:00Z",
    updated_at: "2026-08-26T08:00:00Z",
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
    state: "ready",
    origin_session_id: VIEWER,
    origin_label: "auth-work",
    created_at: "2026-08-26T08:10:00Z",
    updated_at: "2026-08-26T08:10:00Z",
    seen_by_origin: true,
  },
];

async function mountPanel(page: Page) {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(
    async ({ seed, viewer }) => {
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
          case "delete_draft":
            store.drafts = store.drafts.filter((d: any) => d.id !== args.id);
            return Promise.resolve(null);
          default:
            return passthrough(cmd, args);
        }
      };

      const host = document.createElement("div");
      host.id = "drafts-spec-host";
      // Below the harness page's own TEST BUILD banner, which paints above this
      // host and would otherwise sit across the panel header in a capture.
      host.style.cssText =
        "position:fixed;top:40px;left:0;width:400px;height:520px;z-index:1;display:flex;background:var(--color-background)";
      document.body.appendChild(host);

      const mod = await import("/views/sessions/drafts-panel.ts");
      w.__draftsHandle = mod.mountDraftsPanel(host);
      w.__draftsHandle.setSessionScope(viewer);
    },
    { seed: SEED, viewer: VIEWER },
  );

  const panel = page.locator("#drafts-spec-host.drafts-panel");
  await expect(panel.locator(".dr-card").first()).toBeVisible();
  return panel;
}

test("the list groups by state and shows every recipient handle", async ({ page }) => {
  const panel = await mountPanel(page);

  await expect(panel.locator(".dr-card")).toHaveCount(2);
  await expect(panel.locator(".dr-group").first()).toHaveText("Needs you");
  const first = panel.locator(".dr-card").first();
  await expect(first.locator(".dr-handle")).toHaveText(["Bruno #2", "Ana #1"]);
  await expect(first.locator(".dr-ver")).toHaveText("v2");
  // Markdown markers must not leak into the one-line excerpt...
  await expect(first.locator(".dr-excerpt")).not.toContainText("**");
  // ...but stripping them must not eat a hyphen inside the text: that fused
  // the invoice date into "20260314" the first time round.
  await expect(panel.locator(".dr-card").nth(1).locator(".dr-excerpt")).toContainText("2026-03-14");
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

  await expect(panel.locator(".dr-card").first().locator(".dr-edited")).toHaveText("your edit");
});

test("the recipient dropdown swaps to that person's own version track", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

  await expect(panel.locator(".dr-body")).toContainText("Hey Bruno");
  await panel.locator("[data-recipient]").selectOption("Ana");

  await expect(panel.locator(".dr-body")).toContainText("Hi Ana");
  await expect(panel.locator(".dr-body")).not.toContainText("Hey Bruno");
  // Ana's track is one version deep; the picker must not offer Bruno's v2.
  await expect(panel.locator("[data-version] option")).toHaveCount(1);
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

test("the bold button marks the selection instead of typing asterisks", async ({ page }) => {
  const panel = await mountPanel(page);
  await panel.locator(".dr-card").first().click();

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
