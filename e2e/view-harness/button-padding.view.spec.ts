// asserts: src/styles/color-picker.css
import { test, expect } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE } from "./harness";

// A bare `button {}` rule that sets padding pushed every icon-only button with its own width/height
// off centre unless that button remembered `padding: 0`. Text buttons get their padding from the
// shared classes instead, so a plain button carries none.

test("a plain button has no padding, the shared text-button classes keep 7px 16px", async ({ page }) => {
  await mountView(page, { view: "settings", invoke: SESSIONS_BASE_INVOKE });
  await page.waitForLoadState("networkidle");
  const padding = await page.evaluate(() => {
    const read = (cls: string) => {
      const b = document.createElement("button");
      if (cls) b.className = cls;
      document.body.appendChild(b);
      // transition: all would otherwise report the start value of a fresh button's first frame.
      b.style.transition = "none";
      const p = getComputedStyle(b).padding;
      b.remove();
      return p;
    };
    return Object.fromEntries(["", "btn", "btn-primary", "btn-secondary", "btn-danger"].map((c) => [c || "plain", read(c)]));
  });
  expect(padding).toEqual({
    plain: "0px",
    btn: "7px 16px",
    "btn-primary": "7px 16px",
    "btn-secondary": "7px 16px",
    "btn-danger": "7px 16px",
  });
});

test("a class rule that sets its own padding still beats the shared text-button padding", async ({ page }) => {
  await mountView(page, { view: "settings", invoke: SESSIONS_BASE_INVOKE });
  await page.waitForLoadState("networkidle");
  const padding = await page.evaluate(() => {
    // Prepended, so it sits EARLIER in the cascade than color-picker.css: a plain `.btn-primary`
    // padding rule (0,1,0) would win this tie by order, `button:where(...)` (0,0,1) cannot.
    const style = document.createElement("style");
    style.textContent = ".own-padding { padding: 3px 5px; }";
    document.head.prepend(style);
    const b = document.createElement("button");
    b.className = "btn-primary own-padding";
    b.style.transition = "none";
    document.body.appendChild(b);
    return getComputedStyle(b).padding;
  });
  expect(padding).toBe("3px 5px");
});
