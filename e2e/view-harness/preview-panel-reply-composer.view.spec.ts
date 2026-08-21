import { test, expect } from "@playwright/test";
import { mountView, invokeCalls, sessionInstance } from "./harness";

// Preview panel reply composer (ai_todo composer-unification, task 5): a
// compact composer docked at the bottom of the panel sends a user message to
// whichever session pushed the currently-viewed snapshot, auto-tagged with a
// reference to it. Mirrors preview-panel-inline-script.view.spec.ts's mount
// pattern (renderPreview directly, no full sessions-view boot), but also
// seeds src/views/sessions/state.ts's `state.sessions` directly - the send
// path resolves the owning session's `cwd` from there, same as the main
// composer's send_message call.

test("typing in the preview reply composer and pressing Enter sends a tagged message to the owning session", async ({ page }) => {
  await mountView(page, {
    invoke: {
      list_previews: [
        {
          id: "snap-1", slug: "fixture", title: "Login flow", source: "chat",
          session_id: "sess-1", version: 3, created_at: new Date().toISOString(),
        },
      ],
      get_preview: {
        id: "snap-1", slug: "fixture", title: "Login flow", html: "<p>hi</p>",
        source: "chat", session_id: "sess-1", version: 3, created_at: new Date().toISOString(),
      },
      send_message: "ok",
    },
  });

  await page.evaluate(async (session) => {
    const stateMod = await import("/views/sessions/state.ts");
    stateMod.state.sessions.push(session);

    const mod = await import("/views/sessions/preview-panel.ts");
    const root = document.createElement("div");
    root.id = "preview-panel-host";
    document.body.appendChild(root);
    const controller = mod.renderPreview(root, { mode: "panel" });
    controller.setSessionScope("sess-1");
    controller.open("snap-1");
  }, sessionInstance({ session_id: "sess-1", cwd: "/fake/project" }));

  const root = page.locator("#preview-panel-host");
  const input = root.locator(".pv-composer-input");
  await expect(input).toBeVisible();
  await input.fill("looks off on mobile");
  await input.press("Enter");

  await expect(input).toHaveValue("");

  const calls = await invokeCalls(page);
  const sendCall = calls.find((c) => c.cmd === "send_message");
  expect(sendCall).toBeTruthy();
  const args = sendCall!.args as { sessionId: string; cwd: string; blocks: Array<{ type: string; text: string }> };
  expect(args.sessionId).toBe("sess-1");
  expect(args.cwd).toBe("/fake/project");
  expect(args.blocks[0]?.text).toContain("[re: preview v3 - Login flow]");
  expect(args.blocks[0]?.text).toContain("looks off on mobile");
});
