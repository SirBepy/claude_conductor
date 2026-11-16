// @vitest-environment jsdom
// A sub that runs on a paired machine (cross-machine subchats, step 7): the machine
// shows on its row, hover card and finish card, an offline machine says so instead of
// a guessed state, and a sub on this machine shows nothing extra.

import { describe, it, expect } from "vitest";
import { subListHtml } from "../src/views/sessions/sub-list.ts";
import { mainChatInfo } from "../src/views/sessions/main-chat.ts";
import { buildSubHoverCardHtml } from "../src/views/sessions/sidebar-hover-card-html.ts";
import { subMachineChipHtml, subMachineWords } from "../src/views/sessions/sub-machine.ts";
import { renderSubCard } from "../src/shared/chat/chat-subchat-card.ts";

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "/p/cv", project_id: "p", kind: "interactive", is_remote: false,
  started_at: "2026-11-05T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});
const main = inst({ session_id: "main", name: "CV redesign" });
const sub = (id, over = {}) => inst({ session_id: id, name: id, subchat_of: "main", busy: true, ...over });
const mac = (online = true) => ({ id: "mac-1", label: "Mac mini", online });

describe("a sub that runs on a paired machine", () => {
  it("shows the machine on its row, and a sub on this machine shows none", () => {
    const all = [main, sub("Port", { machine: mac() }), sub("Local")];
    const subs = mainChatInfo(main, all).subs;
    const html = subListHtml(subs, all);
    expect(html).toContain('<span class="sub-machine" data-machine="mac-1" title="on Mac mini"><i class="ph ph-desktop" aria-hidden="true"></i>Mac mini</span>');
    expect(html.match(/class="sub-machine/g)).toHaveLength(1);
    expect(subs.find((s) => s.id === "Local").machine).toBeNull();
    expect(subMachineChipHtml(null)).toBe("");
    expect(subMachineWords(undefined)).toBe("");
  });

  it("escapes a machine label that came from the peer", () => {
    const all = [main, sub("Port", { machine: { id: "m<1>", label: "<img src=x onerror=1>", online: true } })];
    const html = subListHtml(mainChatInfo(main, all).subs, all);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("says the machine is offline instead of guessing a state from the row it last sent", () => {
    const all = [main, sub("Port", { machine: mac(false) }), sub("Done", { machine: mac(false), subchat_finished: true })];
    const subs = mainChatInfo(main, all).subs;
    expect(subs.find((s) => s.id === "Port").progress).toBe("Mac mini offline");
    expect(subs.find((s) => s.id === "Done").progress).toBe("finished");
    const html = subListHtml(subs, all);
    expect(html).toContain("sub-machine sub-machine--offline");
    expect(html).toContain('title="on Mac mini (offline)"');
  });

  it("names the machine on the hover card", () => {
    const hover = { stateWord: "Working", step: null, plan: null, action: null, queue: null, resetsAt: null, gaming: false };
    const base = { name: "Port", tier: "Sonnet high", kind: "working", hover, startedAt: null, contextPct: null, now: 0 };
    expect(buildSubHoverCardHtml({ ...base, machine: "on Mac mini" })).toContain('<div class="hc-sub">Sonnet high · on Mac mini</div>');
    expect(buildSubHoverCardHtml(base)).toContain('<div class="hc-sub">Sonnet high</div>');
  });

  it("names the machine on its finish card, from the card itself so it outlives the machine", () => {
    const entry = { id: "c1", ts: 1, parent_id: "main", kind: "finish", sub_id: "s1", sub_name: "Port", model: "claude-sonnet-4-5", effort: "high", verdict: "Built", text: "Done", machine: "Mac mini" };
    const m = { role: "assistant", text: "Built\nDone", card: { kind: "report", verdict: "Built" } };
    expect(renderSubCard(m, entry, (t) => t)).toContain("on Mac mini");
    expect(renderSubCard(m, { ...entry, machine: null }, (t) => t)).not.toContain("on Mac mini");
  });
});
