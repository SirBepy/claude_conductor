// asserts: src/views/sessions/projects-tab/dash-html-card.ts
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// A chat-written html card runs its own script, but in a sandboxed frame:
// it cannot read the app's DOM or globals, and it has no network.

const PROBE = `<div id="out">pending</div><script>
  var out = [];
  try { out.push(window.parent.document.title ? "leaked-dom" : "leaked-dom"); } catch (e) { out.push("dom-blocked"); }
  try { out.push(window.parent.__TAURI__ ? "leaked-ipc" : "no-ipc"); } catch (e) { out.push("ipc-blocked"); }
  out.push("hours=" + window.CARD_DATA.hours);
  fetch("http://127.0.0.1:27182/").then(function(){ out.push("net-open"); }, function(){ out.push("net-blocked"); })
    .finally(function(){ document.getElementById("out").textContent = out.join(" "); });
</script>`;

test("an html card's script cannot reach the app or the network, and sees its data", async ({ page }) => {
  await mountView(page, { invoke: { list_previews: [] } });
  await page.evaluate(async (template) => {
    // The bare package is served under /@id/; a variable keeps tsc from resolving it.
    const litId = "/@id/lit-html";
    const { render } = await import(/* @vite-ignore */ litId);
    const { htmlCardFrame } = await import("/views/sessions/projects-tab/dash-html-card.ts");
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(htmlCardFrame("Probe", template, { hours: 7.5 }), host);
  }, PROBE);

  const out = page.frameLocator("iframe.pd-html-frame").locator("#out");
  await expect(out).not.toHaveText("pending");
  const text = await out.textContent();
  expect(text).toContain("dom-blocked");
  expect(text).not.toContain("leaked");
  expect(text).toContain("hours=7.5");
  expect(text).toContain("net-blocked");
});

test("the frame sizes itself to its content", async ({ page }) => {
  await mountView(page, { invoke: { list_previews: [] } });
  await page.evaluate(async () => {
    // The bare package is served under /@id/; a variable keeps tsc from resolving it.
    const litId = "/@id/lit-html";
    const { render } = await import(/* @vite-ignore */ litId);
    const { htmlCardFrame } = await import("/views/sessions/projects-tab/dash-html-card.ts");
    const host = document.createElement("div");
    host.style.width = "400px";
    document.body.appendChild(host);
    render(htmlCardFrame("Tall", `<div style="height:240px"></div>`, null), host);
  });
  await expect.poll(async () => (await page.locator("iframe.pd-html-frame").boundingBox())?.height).toBe(240);
});

test("a card shorter than the frame's starting height shrinks to its content", async ({ page }) => {
  await mountView(page, { invoke: { list_previews: [] } });
  await page.evaluate(async () => {
    // The bare package is served under /@id/; a variable keeps tsc from resolving it.
    const litId = "/@id/lit-html";
    const { render } = await import(/* @vite-ignore */ litId);
    const { htmlCardFrame } = await import("/views/sessions/projects-tab/dash-html-card.ts");
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(htmlCardFrame("Short", `<div style="height:30px"></div>`, null), host);
  });
  await expect.poll(async () => (await page.locator("iframe.pd-html-frame").boundingBox())?.height).toBe(30);
});
