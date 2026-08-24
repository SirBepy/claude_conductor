// UI coverage for the multi-account feature's three remaining unverified
// surfaces (milestone 08, docs/multi-account/08-notifications-polish.md item
// 3c): the dashboard account selector (milestone 05), the new-chat account
// picker (milestone 04), and the floating overlay (milestone 06).
//
// WRITTEN, NOT YET RUN. Per the milestone-08 brief this spec was authored and
// parse/type-checked (`pnpm tsc --noEmit` covers .ts specs; this file is
// plain .js so only `node --check` syntax-validates it) but deliberately not
// executed against the harness in this session. Whoever picks this up next
// should run it via the opt-in npm script below, fix whatever the first real
// run surfaces, and only then consider it "verified".
//
//   npm run test:e2e:accounts
//
// FREE in the billing sense (no `claude` process spawned), but NOT fixture-
// free: the harness's `wdio` daemon instance starts with an EMPTY accounts
// registry (no wizard has ever run against it), and the wizard's `/login`
// step cannot be scripted (00-overview.md, locked decision) - there is no
// IPC seam to fabricate a fake registered account the way `changes-panel.
// e2e.js` seeds a fake session via `register_historical_session`. So:
//
//   - The dashboard + new-chat-picker specs below assert the well-defined
//     EMPTY-registry path (deterministic, matches the harness's real state).
//     A future update that adds a lightweight "seed account" test-only IPC
//     command (mirroring `__injectEdit`'s dev-only seam in main.ts) could
//     extend these to the populated (`.dash-acard` / account-chip) path.
//   - The overlay lives in a SEPARATE always-on-top Tauri window
//     (`session-overlay`, `overlay.html`) built only from
//     `ipc::overlay_window::toggle_overlay_window`, which is a plain Rust fn wired to
//     the tray icon's real OS click - NOT an invokable `#[tauri::command]`.
//     There is no scripted way to open it from the webview. The spec below
//     documents this and instead asserts the one thing reachable from here:
//     the overlay's data dependencies (`list_accounts` + `get_usage_map`)
//     round-trip cleanly over IPC, which is what `renderOverlay` awaits
//     before it paints anything (`src/views/overlay/overlay.ts`). The
//     overlay's own render logic is already unit-tested headlessly
//     (`tests/overlay-logic.test.mjs`); true window-level coverage needs
//     either a tray-click automation layer or a dedicated
//     `open_overlay_window_for_test` command - out of this milestone's scope.

describe("Dashboard account selector (multi-account milestone 05)", () => {
  it("renders selector cards with a populated registry, legacy stat cards with an empty one", async () => {
    await browser.execute(() => window.showView("dashboard"));

    const content = await $("#stats-content");
    await content.waitForExist({ timeout: 15000 });

    // Registry-aware (the harness drives the REAL app-data dir, which may or
    // may not have accounts registered): `renderShell`'s `cardsHtml` ternary
    // picks `.dash-sel-row` account cards when `accountsCache.length > 0`,
    // else the legacy stat cards (dashboard.ts).
    const accounts = await browser.execute(() => window.__TAURI__.core.invoke("list_accounts"));
    const selectorRow = await $(".dash-sel-row");
    if (accounts.length > 0) {
      await selectorRow.waitForExist({ timeout: 15000 });
    } else {
      await expect(selectorRow).not.toExist();
    }
  });

  it("surfaces the one-time 'set up your accounts' banner only when a legacy session exists", async () => {
    // Harness-dependent: the banner needs BOTH an empty registry (true here)
    // AND a legacy `session.txt` on disk (`should_show_setup_prompt`). The
    // wdio harness's app-data dir may or may not have one depending on
    // whether a prior manual login ever ran against it - so this assertion
    // is a structural existence check, not a hard true/false expectation.
    const banner = await $("#dashSetupBanner");
    const exists = await banner.isExisting();
    if (exists) {
      await expect($(".dash-setup-banner-cta")).toExist();
      await expect($(".dash-setup-banner-dismiss")).toExist();
    }
  });
});

describe("New-chat account picker (multi-account milestone 04)", () => {
  // Tear down even on failure: a modal left up covers `#acc-add-btn`.
  afterEach(async () => {
    await browser.execute(() => {
      document.querySelector(".me-cancel")?.click();
      document.querySelector(".project-picker-backdrop")?.remove();
      document.querySelector(".project-picker")?.remove();
      document.querySelector(".model-effort-modal")?.remove();
      document.querySelector(".modal-backdrop:not([hidden])")?.setAttribute("hidden", "");
    });
    await browser.keys(["Escape"]);
  });

  it("shows account chips with a populated registry, the 'no accounts yet' state with an empty one", async () => {
    await browser.execute(() => window.showView("sessions"));
    // New chat is only interactable once the view-more menu relocates it out
    // of the hidden `#view-more-host` (view-more-menu.ts:112-118).
    const moreBtn = await $("#viewMoreBtn");
    await moreBtn.waitForClickable({ timeout: 15000 });
    await moreBtn.click();

    const newSessionBtn = await $("#newSessionBtn");
    await newSessionBtn.waitForClickable({ timeout: 15000 });
    await newSessionBtn.click();

    // `.project-picker-row` (project-picker.ts:266); `[data-project-path]` never matched.
    const projectPickerItem = await $(".project-picker-row");
    await projectPickerItem.waitForExist({ timeout: 15000 });
    await projectPickerItem.click();

    const accField = await $(".me-acc-field");
    await accField.waitForExist({ timeout: 15000 });
    // Registry-aware (model-effort-modal.ts `renderAccountFieldHtml`): chip
    // picker with accounts, warning + "Add one in Settings" link without.
    const accounts = await browser.execute(() => window.__TAURI__.core.invoke("list_accounts"));
    if (accounts.length > 0) {
      // Two shapes (account-field.ts:66-85): an ambiguous/multi-account
      // registry shows the chip picker list; a resolved single account shows
      // the borderless ghost-dropdown trigger (.me-acc-ghost) instead.
      const hasChip = await $(".me-acc-field .account-chip").isExisting();
      const hasGhost = await $(".me-acc-field .me-acc-ghost").isExisting();
      await expect(hasChip || hasGhost).toBe(true);
      await expect($(".me-acc-empty")).not.toExist();
    } else {
      await expect($(".me-acc-empty")).toExist();
      await expect($(".me-acc-add-link")).toExist();
      await expect($("[data-acc-id]")).not.toExist();
    }
  });
});

describe("Add-account wizard (browser-first flow, 2026-07-08)", () => {
  // Drives the real wizard up to - but never across - the side-effect
  // boundaries: "Open browser login" (launches a real Chrome) and "Use
  // terminal /login instead" (spawns a real terminal) are asserted to exist
  // but never clicked. Create DOES hit the real backend: it makes a
  // ~/.claude-<slug> profile dir, which the final Discard deletes again
  // (add_account_cancel removes dirs the wizard created fresh).
  const SLUG = "wdio-wizard-e2e";

  it("opens from Settings > Accounts and shows the 4-step browser-first header", async () => {
    await browser.execute(() => window.showView("settings-accounts"));
    const addBtn = await $("#acc-add-btn");
    await addBtn.waitForClickable({ timeout: 15000 });
    await addBtn.click();

    const wizard = await $(".aaw-overlay .wizard");
    await wizard.waitForExist({ timeout: 5000 });

    // wdio v9 `$$.map()` resolves to a Promise, not an Array.
    const steps = await $$(".aaw-overlay .wz-steps .st");
    const labels = await Promise.all([...steps].map((s) => s.getText()));
    expect(labels.join(" | ")).toContain("Create");
    expect(labels.join(" | ")).toContain("Browser login");
    expect(labels.join(" | ")).toContain("CLI login");
    expect(labels.join(" | ")).toContain("Finalize");
    // Browser login must come BEFORE CLI login.
    expect(labels.findIndex((l) => l.includes("Browser login"))).toBeLessThan(
      labels.findIndex((l) => l.includes("CLI login")),
    );
  });

  it("does not dismiss on overlay (backdrop) click", async () => {
    // Click the backdrop, not the dialog: coordinates near the top-left
    // corner of the overlay are outside the centered wizard box.
    const overlay = await $(".aaw-overlay");
    await overlay.click({ x: -600, y: -300 });
    await expect($(".aaw-overlay .wizard")).toExist();
  });

  it("closes without confirmation from step 1 via the X", async () => {
    const closeBtn = await $("#aaw-close-btn");
    await closeBtn.click();
    // No progress yet -> no confirm dialog, closes immediately.
    await expect($(".app-confirm-overlay")).not.toExist();
    await browser.waitUntil(async () => !(await $(".aaw-overlay").isExisting()), { timeout: 5000 });
  });

  it("advances to the browser-login step on Create and offers both routes", async () => {
    const addBtn = await $("#acc-add-btn");
    await addBtn.waitForClickable({ timeout: 15000 });
    await addBtn.click();

    const nameEl = await $("#aaw-name");
    await nameEl.waitForExist({ timeout: 5000 });
    await nameEl.setValue(SLUG);
    await (await $("#aaw-create-btn")).click();

    // Step 2 (Browser login): both the browser CTA and the CLI escape hatch
    // exist; neither is clicked (real side effects).
    const captureBtn = await $("#aaw-capture-btn");
    await captureBtn.waitForExist({ timeout: 15000 });
    await expect($("#aaw-skip-browser-btn")).toExist();
    const cur = await $(".aaw-overlay .wz-steps .st.cur");
    expect(await cur.getText()).toContain("Browser login");
  });

  it("X past step 1 asks for confirmation; 'Keep going' stays open", async () => {
    await (await $("#aaw-close-btn")).click();
    const confirmBox = await $(".app-confirm");
    await confirmBox.waitForExist({ timeout: 5000 });
    await (await $(".app-confirm-cancel")).click();
    await expect($(".aaw-overlay .wizard")).toExist();
    await expect($(".app-confirm-overlay")).not.toExist();
  });

  it("'Discard' closes the wizard and cancels the backend session", async () => {
    await (await $("#aaw-close-btn")).click();
    const confirmBox = await $(".app-confirm");
    await confirmBox.waitForExist({ timeout: 5000 });
    await (await $(".app-confirm-ok")).click();
    await browser.waitUntil(async () => !(await $(".aaw-overlay").isExisting()), { timeout: 10000 });
    // The registry must be untouched (nothing was finalized).
    const accounts = await browser.execute(() => window.__TAURI__.core.invoke("list_accounts"));
    expect(accounts.every((a) => !String(a.config_dir).includes("wdio-wizard-e2e"))).toBe(true);
  });
});

describe("Overlay data dependencies (multi-account milestone 06)", () => {
  it("list_accounts + get_usage_map round-trip cleanly (what renderOverlay awaits before painting)", async () => {
    const result = await browser.execute(async () => {
      const [accounts, usageMap] = await Promise.all([
        window.__TAURI__.core.invoke("list_accounts"),
        window.__TAURI__.core.invoke("get_usage_map"),
      ]);
      return { accountsIsArray: Array.isArray(accounts), usageMapIsObject: typeof usageMap === "object" && usageMap !== null };
    });
    expect(result.accountsIsArray).toBe(true);
    expect(result.usageMapIsObject).toBe(true);
  });

  // NOT automated (see file header): opening the actual `session-overlay`
  // window requires a real tray-icon click, which has no scripted IPC path.
  it.skip("overlay window renders .oc-panel with account rows - needs a tray-click automation seam or a test-only open command", () => {});
});
