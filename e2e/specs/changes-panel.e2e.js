// Integration coverage for ai_todo 53: the inline edit-window + changes panel
// (rail, sheet, dim, reviewed) wired into the REAL session pane. The render
// logic itself is unit-tested headlessly (tests/edit-window.test.mjs,
// changes-panel.test.mjs, chat-renderer-edits.test.mjs); this layer proves the
// active-session pane actually mounts the panel and routes ChatRenderer
// callbacks to the DOM.
//
// FREE: seeds a session via the `register_historical` daemon RPC (no `claude`
// process, no billed turn) and injects synthetic file-edit tool_use events via
// the dev-only `window.__injectEdit` seam (main.ts, stripped from prod builds).
// The live activity bar is gated on a busy turn, so it stays a manual eyeball
// (its callback is covered by chat-renderer-edits.test.mjs) and is not asserted
// here.
//
// Opt-in (spawns no claude but seeds the harness daemon's registry):
//   npm run test:e2e:changes

const SESSION_ID = `e2e-changes-${Date.now()}`;

// executeAsync: `browser.execute` with an async callback returns as soon as the
// promise is CREATED, so the row could still be unregistered when awaited.
async function seedSession(cwd) {
  const result = await browser.executeAsync((sessionId, sessionCwd, done) => {
    window.__TAURI__.core
      .invoke("register_historical_session", {
        sessionId,
        cwd: sessionCwd,
        accountId: "e2e-seeded-account",
      })
      .then(() => done("ok"))
      .catch((e) => done("ERR:" + String(e)));
  }, SESSION_ID, cwd);
  if (String(result).startsWith("ERR")) throw new Error(`register_historical_session failed: ${result}`);
}

async function injectEdit(opts) {
  await browser.execute((sessionId, o) => {
    window.__injectEdit(sessionId, o);
  }, SESSION_ID, opts);
}

describe("Changes panel + inline edit-window (ai_todo 53)", () => {
  before(async () => {
    await browser.execute(() => window.showView("sessions"));
    await (await $("#sessions-list")).waitForExist({ timeout: 15000 });
    // Tool-use rows are `chat-narration`, hidden by default (chat-messages.css:97).
    // `active-session-mount.ts:253` reads this pref on mount, so set it BEFORE
    // selecting or every `.edit-window` renders 0x0 inside a hidden parent.
    await browser.execute((sessionId) => {
      localStorage.setItem("cc-show-raw-chat:" + sessionId, "1");
    }, SESSION_ID);
    // Seed an Interactive session in the daemon registry so a clickable sidebar
    // row appears. Use this repo's root as cwd so no throwaway project is
    // created (it is already a known project).
    await seedSession(process.cwd());

    const row = await $(`#sessions-list li[data-session-id="${SESSION_ID}"]`);
    await row.waitForExist({ timeout: 15000 });
    // A freshly broadcast row animates in as `row-entering`; a click during
    // that animation is swallowed and the pane stays on `.session-empty`.
    await browser.waitUntil(
      async () => !(await row.getAttribute("class")).includes("row-entering"),
      { timeout: 10000, interval: 250, timeoutMsg: "sidebar row never settled" }
    );
    await row.waitForClickable({ timeout: 10000 });
    // Re-query and retry: the sidebar re-renders on every daemon tick, so the
    // handle above can be detached and its click silently goes nowhere.
    await browser.waitUntil(
      async () => {
        await (await $(`#sessions-list li[data-session-id="${SESSION_ID}"]`)).click().catch(() => {});
        return browser.execute(() => !!document.querySelector(".session-messages"));
      },
      { timeout: 20000, interval: 1000, timeoutMsg: "clicking the seeded row never mounted the chat pane" }
    );

    // Pane mounted: renderer attached and the composer wired.
    await (await $(".session-messages")).waitForExist({ timeout: 15000 });
    await (await $(".session-composer")).waitForExist({ timeout: 15000 });
  });

  /** wdio's `*=` partial-text syntax cannot combine with a compound class
   *  selector, so match by text with `$$` plus a JS-side filter. */
  async function clickMenuItemByText(label) {
    await browser.waitUntil(
      async () => {
        for (const el of await $$(".smore-item")) {
          const text = (await el.getText().catch(() => "")).trim();
          if (!text.startsWith(label)) continue;
          if (!(await el.isClickable().catch(() => false))) continue;
          await el.click();
          return true;
        }
        return false;
      },
      { timeout: 10000, interval: 400, timeoutMsg: `menu item "${label}" never became clickable` }
    );
  }

  /** "View changes" moved into the row menu's Chat submenu in 6d6b286b, which
   *  deleted the old `.session-header .changes-btn` (session-header.ts:85-86). */
  async function openChangesRail() {
    const row = await $(`#sessions-list li[data-session-id="${SESSION_ID}"]`);
    await row.click({ button: "right" });
    await clickMenuItemByText("Chat");
    await clickMenuItemByText("View changes");
  }

  after(async () => {
    // Clean up the seeded session so it doesn't linger as live in the registry.
    await browser.execute(async (sessionId) => {
      try {
        await window.__TAURI__.core.invoke("clear_session", { sessionId });
      } catch { /* best effort */ }
    }, SESSION_ID);
  });

  it("renders an inline edit-window for an Edit tool_use, collapsed by default", async () => {
    await injectEdit({
      tool: "Edit",
      file: "src/demo/alpha.ts",
      oldText: "const a = 1;",
      newText: "const a = 2;",
    });

    const win = await $(".session-messages .edit-window");
    await win.waitForExist({ timeout: 10000 });
    // Collapsed: <details> has no `open` attribute yet.
    expect(await win.getAttribute("open")).toBe(null);
    expect(await (await $(".edit-window .edit-window-path")).getText()).toContain("alpha.ts");
  });

  it("expands to show side-by-side before/after columns", async () => {
    await (await $(".edit-window .edit-window-summary")).click();

    // One round-trip: the transcript re-renders on daemon ticks, so a handle
    // taken for the second side can be detached by the time it is read.
    await browser.waitUntil(
      async () => {
        const sides = await browser.execute(() => {
          const win = document.querySelector(".edit-window");
          if (!win || !win.open) return null;
          return {
            before: win.querySelector('.edit-window-side[data-side="before"]')?.textContent || "",
            after: win.querySelector('.edit-window-side[data-side="after"]')?.textContent || "",
          };
        });
        return !!sides && sides.before.includes("const a = 1;") && sides.after.includes("const a = 2;");
      },
      { timeout: 10000, interval: 500, timeoutMsg: "expanded edit-window never showed both before/after sides" }
    );
  });

  it("opens the changes rail (dimming the chat) listing every edited file", async () => {
    // Add a second file so the rail shows two deduped rows.
    await injectEdit({
      tool: "Write",
      file: "src/demo/beta.ts",
      content: "export const b = true;",
    });

    await openChangesRail();

    const rail = await $(".changes-rail");
    await rail.waitForExist({ timeout: 10000 });

    const dimmed = await $(".session-messages.chat--dimmed");
    expect(await dimmed.isExisting()).toBe(true);

    const rows = await $$(".changes-rail .changes-row");
    expect(rows.length).toBe(2);
    expect(await (await $(".changes-rail-chip")).getText()).toBe("0 of 2 reviewed");
  });

  it("checking a row's reviewed box increments the chip", async () => {
    const firstCheckbox = await $(".changes-rail .changes-row .changes-row-reviewed");
    await firstCheckbox.click();
    // Rail re-renders; chip reflects 1 reviewed.
    await browser.waitUntil(
      async () => (await (await $(".changes-rail-chip")).getText()) === "1 of 2 reviewed",
      { timeout: 5000, timeoutMsg: "chip did not increment after reviewing a row" }
    );
  });

  it("clicking a file row opens the sheet overlay, and it closes again", async () => {
    await (await $(".changes-rail .changes-row .changes-row-name")).click();

    const sheet = await $(".changes-sheet");
    await sheet.waitForExist({ timeout: 5000 });
    // Sheet body shows the stacked diff for that file.
    expect(await (await $(".changes-sheet-body")).getText()).toContain("a = 1;");

    await (await $(".changes-sheet-close")).click();
    await sheet.waitForExist({ timeout: 5000, reverse: true });
  });
});
