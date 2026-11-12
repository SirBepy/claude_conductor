// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/asker-face.ts, src/views/sessions/permission-modal/question-ui-templates.ts

import { describe, it, expect, beforeEach } from "vitest";
import { state } from "../src/views/sessions/state.ts";
import { adoptSubchatsOn } from "../src/views/sessions/permission-modal/gating.ts";
import { askerFaceOf } from "../src/views/sessions/permission-modal/asker-face.ts";
import { fromChipHtml } from "../src/views/sessions/permission-modal/question-ui-templates.ts";

const row = (session_id, name, extra = {}) => ({ session_id, name, model: "claude-sonnet-4-5", effort: "high", ...extra });

describe("who a card says it comes from (C5)", () => {
  beforeEach(() => {
    state.sessions = [row("main", "CV redesign"), row("sub-a", "Review session code", { subchat_of: "main" }), row("solo", "Solo chat")];
    adoptSubchatsOn("main");
  });

  it("a sub's own card, even alone, is that sub with its model and job", () => {
    const face = askerFaceOf({ session_id: "sub-a", display_session_id: "main", sub_name: "Review session code", sub_task: "Review it" });
    expect(face).toEqual({ name: "Review session code", task: "Review it", model: "claude-sonnet-4-5", effort: "high" });
  });

  it("the main chat's own card is the Main chat, and a plain chat's is nobody", () => {
    expect(askerFaceOf({ session_id: "main" })).toEqual({ name: "Main chat", main: true });
    expect(askerFaceOf({ session_id: "solo" })).toBeUndefined();
  });

  it("a daemon card about a sub names that sub, taking the row's name when the daemon sent none", () => {
    const card = { session_id: "main", display_session_id: "main", daemon_card: true, sub_id: "sub-a" };
    expect(askerFaceOf({ ...card, sub_name: "Header" })?.name).toBe("Header");
    expect(askerFaceOf(card)?.name).toBe("Review session code");
    // A daemon card about no sub (a close approval) is not the main chat asking.
    expect(askerFaceOf({ ...card, sub_id: undefined })).toBeUndefined();
  });
});

describe("fromChipHtml", () => {
  it("draws a sub as initials, a ring and the battery beside its name", () => {
    const html = fromChipHtml({ name: "Review session code", model: "claude-sonnet-4-5", effort: "high" });
    expect(html).toContain("prompt-from--sub");
    expect(html).toContain(">RS<");
    expect(html).toContain("avatar-ring");
    expect(html).toContain("session-model-battery");
    expect(html).toContain("Review session code");
    // A daemon card is about the sub, not asked by it, so the tooltip only names it.
    expect(html).toContain('title="Subchat: Review session code"');
    expect(html).not.toContain("Asked by");
  });

  it("draws the main chat as a plain chip, and nothing without a name", () => {
    const html = fromChipHtml({ name: "Main chat", main: true });
    expect(html).toContain("prompt-from--main");
    expect(html).not.toContain("avatar-ring");
    expect(fromChipHtml(undefined)).toBe("");
    expect(fromChipHtml({})).toBe("");
  });
});
