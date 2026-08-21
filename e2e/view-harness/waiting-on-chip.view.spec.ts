import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Todo 675: exercised directly via TurnFooterRegistry (same pattern as
// turn-todo-checklist.view.spec.ts's third test) since the full ChatEvent
// pipeline isn't simulated here. Covers all three `kind` values, the
// rejected-href case, and the absent-chip case.

async function mountHarness(page: Page): Promise<void> {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    const { TurnFooterRegistry } = await import("/shared/chat/turn-chips.ts");
    const el = document.createElement("div");
    el.id = "waiting-harness";
    el.className = "chat-messages";
    el.style.cssText = "padding:16px;max-width:720px";
    document.body.replaceChildren(el);
    const reg = new TurnFooterRegistry();
    el.appendChild(reg.getOrCreateFooter(1));
    el.appendChild(reg.getOrCreateFooter(2));
    (window as unknown as { __reg: TurnFooterRegistry }).__reg = reg;
  });
}

function setWaitingOn(page: Page, key: number, target: unknown): Promise<void> {
  return page.evaluate(
    ({ key, target }) => {
      (window as unknown as { __reg: { setWaitingOn: (k: number, v: unknown) => void } })
        .__reg.setWaitingOn(key, target);
    },
    { key, target },
  );
}

test("a session with no waiting_on target renders no chip at all", async ({ page }) => {
  await mountHarness(page);
  // getOrCreateFooter(1) was called (empty footer) but setWaitingOn never was.
  await expect(page.locator("#waiting-harness .turn-chip--waiting-on")).toHaveCount(0);
});

test("a ci target renders a clickable chip with its label", async ({ page }) => {
  await mountHarness(page);
  await setWaitingOn(page, 1, {
    label: "release CI",
    kind: "ci",
    href: "https://github.com/SirBepy/repo/actions/runs/1",
  });
  const chip = page.locator("#waiting-harness [data-turn-id='1'] .turn-chip--waiting-on");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/release CI/);
  await expect(chip).toHaveClass(/turn-chip--clickable/);
  await expect(chip.locator("i")).toHaveClass(/ph-github-logo/);
});

test("a local-process target renders with the terminal icon", async ({ page }) => {
  await mountHarness(page);
  await setWaitingOn(page, 1, { label: "build.log", kind: "local-process", href: "C:\\proj\\build.log" });
  const chip = page.locator("#waiting-harness [data-turn-id='1'] .turn-chip--waiting-on");
  await expect(chip).toHaveText(/build\.log/);
  await expect(chip.locator("i")).toHaveClass(/ph-terminal-window/);
  await expect(chip).toHaveClass(/turn-chip--clickable/);
});

test("an external target renders with the open-external icon", async ({ page }) => {
  await mountHarness(page);
  await setWaitingOn(page, 1, { label: "docs page", kind: "external", href: "https://example.com" });
  const chip = page.locator("#waiting-harness [data-turn-id='1'] .turn-chip--waiting-on");
  await expect(chip.locator("i")).toHaveClass(/ph-arrow-square-out/);
});

// The decision recorded in the todo: a rejected href keeps the label, drops
// the click action - never a broken link, never a hidden chip.
test("a rejected href (null) still shows the label but is not clickable", async ({ page }) => {
  await mountHarness(page);
  await setWaitingOn(page, 2, { label: "release CI", kind: "ci", href: null });
  const chip = page.locator("#waiting-harness [data-turn-id='2'] .turn-chip--waiting-on");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/release CI/);
  await expect(chip).not.toHaveClass(/turn-chip--clickable/);
  await expect(chip).toHaveAttribute("data-kind", "ci");
});

test("applyWaitingOnNotification parses the Notification body onto the active turn", async ({ page }) => {
  await mountHarness(page);
  await page.evaluate(async () => {
    const { applyWaitingOnNotification } = await import("/shared/chat/turn-chips.ts");
    const reg = (window as unknown as { __reg: unknown }).__reg;
    const body = JSON.stringify({ label: "watcher", kind: "local-process", href: "C:\\proj\\out.log" });
    applyWaitingOnNotification(reg as never, 1, body);
  });
  const chip = page.locator("#waiting-harness [data-turn-id='1'] .turn-chip--waiting-on");
  await expect(chip).toHaveText(/watcher/);
});

test("applyWaitingOnNotification silently drops a malformed body", async ({ page }) => {
  await mountHarness(page);
  await page.evaluate(async () => {
    const { applyWaitingOnNotification } = await import("/shared/chat/turn-chips.ts");
    const reg = (window as unknown as { __reg: unknown }).__reg;
    applyWaitingOnNotification(reg as never, 1, "not json");
    applyWaitingOnNotification(reg as never, null, JSON.stringify({ label: "x", kind: "ci", href: null }));
  });
  await expect(page.locator("#waiting-harness .turn-chip--waiting-on")).toHaveCount(0);
});
