// @vitest-environment jsdom
// createMoreMenu arms its outside-click listener on a 0ms timer. A close()
// before that timer fires must cancel it: otherwise the listener lands after
// cleanup ran, and the next time the same menu opens from a different button
// that opening click counts as "outside" the old menu and shuts the new one.

import { describe, it, expect } from "vitest";
import { createMoreMenu } from "../src/views/sessions/more-menu-base.ts";

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createMoreMenu closed in the same tick it opened", () => {
  it("leaves no outside-click listener to shut its next opening", async () => {
    document.body.innerHTML = "";
    const btnA = document.createElement("button");
    const btnB = document.createElement("button");
    document.body.append(btnA, btnB);

    const handle = createMoreMenu({ build: () => {} });
    btnB.addEventListener("click", () => handle.open(btnB));

    handle.open(btnA);
    handle.close();
    await tick();

    btnB.click();
    expect(handle.element()).not.toBeNull();

    // The fresh listener still dismisses on a genuine outside click.
    await tick();
    btnA.click();
    expect(handle.element()).toBeNull();
  });
});
