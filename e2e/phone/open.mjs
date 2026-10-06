// Hands a driver a Playwright Pixel 5 page already logged in on the
// scripts/phone-verify.ps1 rig's served SPA, so phone-path (`isRemote()`
// true) checks are one call instead of re-deriving the state-file path and
// token handshake each time. Run `scripts\phone-verify.ps1 up` first.
import { chromium, devices } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Mirrors phone-verify.ps1's own $stateDir - the two must agree since this
// is the only thing that locates a running rig.
const STATE_PATH = path.join(
  process.env.LOCALAPPDATA,
  "claude-conductor-phone-verify",
  "state.json"
);

export function readRigState() {
  if (!existsSync(STATE_PATH)) {
    throw new Error(
      `No phone-verify instance recorded at ${STATE_PATH}. Run 'scripts\\phone-verify.ps1 up' first.`
    );
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

// Returns an already-navigated Pixel 5 page plus the browser/context (the
// caller owns closing `browser`) and the rig state (port/token/paths), so a
// driver needs no second read of the state file.
export async function openPhonePage() {
  const state = readRigState();
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await context.newPage();
  await page.goto(state.Url);
  // #sessionsFab is the sessions-list FAB, present once the SPA has finished
  // its first daemon round-trip - waiting for it is the same "loaded" signal
  // earlier phone-verify drivers (todo 1037/1061) used.
  await page.locator("#sessionsFab").waitFor({ timeout: 20000 });
  return { browser, context, page, state };
}
