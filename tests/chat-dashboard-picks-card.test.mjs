// @vitest-environment jsdom
//
// The Autopilot picks card's click behaviour (pc-1750) against a deferred daemon:
// a second click on Send to chat while the first is still saving sends nothing
// more, and an empty box saves nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: async () => () => {} }) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { PicksCard } = await import("../src/views/sessions/chat-dashboard/picks-card.ts");
const { derivePicks, normalisePicks } = await import("../src/shared/chat/dashboard/picks-model.ts");

const pick = (over = {}) => ({
  id: "P1", date: "2026-11-15T03:00:00+01:00", who: "Footer", sub: null, question: "Which colour?",
  options: ["Teal", "Navy"], pick: "Teal", reason: "logo", landed: "", status: "unreviewed", instead: null, corrected_note: null, ...over,
});

let host;
let card;
let send;

function mount(picks, { viewing = "main", sendResult = true } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  send = vi.fn().mockResolvedValue(sendResult);
  card = new PicksCard({ sessionId: () => viewing, schedule: () => {}, send });
  // The dashboard hands the card the list it read; `adopt` is what a daemon read ends in.
  card.adopt({ owner: "main", picks });
  card.update(host, derivePicks(normalisePicks({ owner: "main", picks })));
}

const click = (sel) => host.querySelector(sel).click();

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
});

describe("PicksCard overrule", () => {
  it("a second click while the first is saving sends one review and one message", async () => {
    let release;
    invokeMock.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ owner: "main", picks: [pick({ status: "overruled", instead: "Navy" })] }); }),
    );
    mount([pick()]);
    click('[data-pk-act="overrule-open"]');
    const box = host.querySelector("textarea");
    box.value = "Navy";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    click('[data-pk-act="overrule-send"]');
    click('[data-pk-act="overrule-send"]');
    // The correction goes out first, then the row is saved.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "picks_review")).toHaveLength(1);
  });

  it("Change answer sends the prefilled earlier answer when the box is left untouched", async () => {
    invokeMock.mockResolvedValue({ owner: "main", picks: [pick({ status: "overruled", instead: "Navy" })] });
    mount([pick({ status: "overruled", instead: "Navy" })]);
    click('[data-pk-act="overrule-open"]');
    expect(host.querySelector("textarea").value).toBe("Navy");
    click('[data-pk-act="overrule-send"]');
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ id: "P1", action: "overrule", instead: "Navy" });
  });

  it("on a sub's dashboard the correction goes to the main chat that owns the list", async () => {
    invokeMock.mockResolvedValue({ owner: "main", picks: [pick({ status: "overruled", instead: "Navy" })] });
    mount([pick()], { viewing: "sub-1" });
    click('[data-pk-act="overrule-open"]');
    host.querySelector("textarea").value = "Navy";
    host.querySelector("textarea").dispatchEvent(new window.Event("input", { bubbles: true }));
    click('[data-pk-act="overrule-send"]');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][1]).toBe("main");
  });

  it("a refused send leaves the row unmarked, the box open and says so", async () => {
    mount([pick()], { sendResult: false });
    click('[data-pk-act="overrule-open"]');
    host.querySelector("textarea").value = "Navy";
    host.querySelector("textarea").dispatchEvent(new window.Event("input", { bubbles: true }));
    // A click moves the focus to the button, so the held redraw may land.
    host.querySelector("textarea").blur();
    click('[data-pk-act="overrule-send"]');
    await vi.waitFor(() => expect(host.querySelector(".pk-send-failed")).not.toBeNull());
    expect(invokeMock).not.toHaveBeenCalled();
    expect(host.querySelector(".pk-chip").textContent).toBe("To review");
    expect(host.querySelector("textarea").value).toBe("Navy");
  });

  it("Send again sends once on a double click and shows a refused send on the row", async () => {
    let finish;
    mount([pick({ status: "overruled", instead: "Navy" })]);
    send.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    click('[data-pk-act="resend"]');
    click('[data-pk-act="resend"]');
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-pk-act="resend"]').disabled).toBe(true);
    finish(false);
    await vi.waitFor(() => expect(host.querySelector(".pk-send-failed")).not.toBeNull());
    expect(host.querySelector('[data-pk-act="resend"]').disabled).toBe(false);
  });

  it("an empty box saves nothing", async () => {
    mount([pick()]);
    click('[data-pk-act="overrule-open"]');
    click('[data-pk-act="overrule-send"]');
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
