// @vitest-environment jsdom
// The "Use subchats" switch on a new-chat draft: it writes the choice into the
// draft's config (which the first start_session carries), moves the chat to the
// main-chat model like the daemon does for a live flip, and refuses an API-credit
// account.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { stateMock, saveMock } = vi.hoisted(() => ({
  stateMock: { statusbar: { syncModelEffort: vi.fn() }, pendingNewSession: null },
  saveMock: vi.fn(),
}));

vi.mock("../src/views/sessions/state.ts", () => ({ state: stateMock }));
vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ savePendingSession: saveMock }));

const { mountDraftSubchats, mountDraftSubchatsCard, syncDraftSubchats, lockDraftSubchats, unmountDraftSubchats } = await import("../src/views/sessions/draft-subchats.ts");
const { mainChatLaunch } = await import("../src/views/sessions/subchats-gate.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const acct = (id, kind) => ({ id, label: id, icon: "x", colour: "#fff", kind });

let pane;
let config;
const input = () => pane.querySelector(".draft-subchats input");
const flip = (checked) => {
  input().checked = checked;
  input().dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = `<div id="pane"><div class="session-messages"></div><div class="composer-shell"></div></div>`;
  pane = document.getElementById("pane");
  config = { model: "sonnet", effort: "low", accountId: "sub" };
  setCachedAccounts([acct("sub", "subscription"), acct("api", "api_credit")]);
  stateMock.statusbar.syncModelEffort.mockClear();
  stateMock.pendingNewSession = { placeholderId: "p1", config: { ...config } };
  saveMock.mockClear();
  mountDraftSubchats(pane, config);
});

describe("mainChatLaunch (twin of the daemon's main_launch)", () => {
  it("never changes the model and lifts effort to high or better", () => {
    expect(mainChatLaunch("claude-opus-4-8", "max")).toEqual({ model: "claude-opus-4-8", effort: "max" });
    expect(mainChatLaunch("opus", "xhigh")).toEqual({ model: "opus", effort: "xhigh" });
    expect(mainChatLaunch("sonnet", "low")).toEqual({ model: "sonnet", effort: "high" });
    expect(mainChatLaunch("", "")).toEqual({ model: "", effort: "high" });
    expect(mainChatLaunch("opus", "medium")).toEqual({ model: "opus", effort: "high" });
  });
});

describe("the draft's Use subchats switch", () => {
  it("sits just above the message box and starts off", () => {
    expect(pane.querySelector(".draft-subchats").nextElementSibling).toBe(pane.querySelector(".composer-shell"));
    expect(input().checked).toBe(false);
    expect(config.subchatsOn).toBeUndefined();
  });

  it("switching it on sets the flag, keeps the model, raises effort to high, and persists the draft", () => {
    flip(true);
    expect(config).toMatchObject({ subchatsOn: true, model: "sonnet", effort: "high" });
    expect(stateMock.pendingNewSession.config).toMatchObject({ subchatsOn: true, model: "sonnet", effort: "high" });
    expect(saveMock).toHaveBeenCalled();
    expect(stateMock.statusbar.syncModelEffort).toHaveBeenLastCalledWith("sonnet", "high");
  });

  it("switching it off puts back the model and effort it replaced", () => {
    flip(true);
    flip(false);
    expect(config).toMatchObject({ subchatsOn: false, model: "sonnet", effort: "low" });
    expect(stateMock.statusbar.syncModelEffort).toHaveBeenLastCalledWith("sonnet", "low");
  });

  it("switching it off keeps a model the user picked after switching on", () => {
    flip(true);
    config.model = "fable";
    flip(false);
    expect(config).toMatchObject({ subchatsOn: false, model: "fable" });
  });

  it("is disabled on an API-credit account, with the reason as its tooltip", () => {
    config.accountId = "api";
    syncDraftSubchats(pane, config);
    expect(input().disabled).toBe(true);
    expect(pane.querySelector(".draft-subchats").title).toContain("API-credit");
  });

  it("goes off when the draft's account moves to API credit while it was on", () => {
    flip(true);
    config.accountId = "api";
    syncDraftSubchats(pane, config);
    expect(config.subchatsOn).toBe(false);
    expect(input().checked).toBe(false);
    expect(config.model).toBe("sonnet");
  });

  it("is frozen while the first send is in flight and thaws after a failed one", () => {
    lockDraftSubchats(pane, config, true);
    expect(input().disabled).toBe(true);
    lockDraftSubchats(pane, config, false);
    expect(input().disabled).toBe(false);
    config.accountId = "api";
    lockDraftSubchats(pane, config, false);
    expect(input().disabled).toBe(true);
  });

  it("reads a reopened draft's saved choice", () => {
    config.subchatsOn = true;
    mountDraftSubchats(pane, config);
    expect(input().checked).toBe(true);
    expect(pane.querySelectorAll(".draft-subchats")).toHaveLength(1);
  });

  it("a rail card replaces the row, and both copies would follow one config", () => {
    // The draft rail's body (dashboard.ts renderDraftRail): only the line into the project's settings.
    document.body.innerHTML = `<div id="pane"><div class="session-messages"><div class="pd-rail"><div class="view-project-settings"><div class="ps-group ps-open-settings"></div></div></div></div><div class="composer-shell"></div></div>`;
    pane = document.getElementById("pane");
    mountDraftSubchats(pane, config);
    expect(pane.querySelectorAll(".draft-subchats")).toHaveLength(1);

    mountDraftSubchatsCard(pane, pane.querySelector(".pd-rail"), config);
    expect(pane.querySelector(".draft-subchats")).toBeNull();
    const card = pane.querySelector(".view-project-settings > .ps-group.draft-subchats-card");
    // The rail is titled "This chat" itself, so the card carries no title of its own,
    // and the per-chat cards sit above the project settings line.
    expect(card.querySelector(".ps-group-title")).toBeNull();
    const groups = [...pane.querySelectorAll(".view-project-settings > .ps-group")].map((g) => g.className);
    expect(groups.at(-1)).toContain("ps-open-settings");
    expect(groups.indexOf(card.className)).toBeLessThan(groups.length - 1);

    const cardInput = card.querySelector("input");
    cardInput.checked = true;
    cardInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(config).toMatchObject({ subchatsOn: true, model: "sonnet", effort: "high" });
    expect(card.classList.contains("is-on")).toBe(true);

    config.accountId = "api";
    syncDraftSubchats(pane, config);
    expect(cardInput.disabled).toBe(true);
    expect(config.subchatsOn).toBe(false);
    unmountDraftSubchats(pane);
    expect(pane.querySelector(".draft-subchats-card")).toBeNull();
  });

  it("leaves the dashboard's fading ghost copy alone, and a failed send gives the pane a row again", () => {
    document.body.innerHTML = `<div id="pane"><div class="session-messages"><div class="pd-rail"><div class="view-project-settings"></div></div></div><div class="composer-shell"></div></div>`;
    pane = document.getElementById("pane");
    mountDraftSubchats(pane, config);
    const liveRail = pane.querySelector(".pd-rail");
    mountDraftSubchatsCard(pane, liveRail, config);
    const cardInput = liveRail.querySelector(".draft-subchats-card input");
    cardInput.checked = true;
    cardInput.dispatchEvent(new Event("change", { bubbles: true }));
    // The send: the live dashboard comes down, a clone of it fades in its place.
    const ghost = document.createElement("div");
    ghost.className = "pd-draft pd-ghost";
    ghost.append(liveRail.cloneNode(true));
    pane.querySelector(".session-messages").append(ghost);
    liveRail.remove();

    lockDraftSubchats(pane, config, true);
    expect(ghost.querySelector(".draft-subchats-card input").disabled).toBe(false);
    unmountDraftSubchats(pane);
    expect(ghost.querySelector(".draft-subchats-card")).not.toBeNull();

    lockDraftSubchats(pane, config, false);
    const rows = pane.querySelectorAll(".draft-subchats");
    expect(rows).toHaveLength(1);
    expect(rows[0].classList.contains("is-on")).toBe(true);
    expect(rows[0].querySelector("input").checked).toBe(true);
    expect(config.subchatsOn).toBe(true);
    // Switching off still puts back the model the switch replaced.
    rows[0].querySelector("input").checked = false;
    rows[0].querySelector("input").dispatchEvent(new Event("change", { bubbles: true }));
    expect(config).toMatchObject({ subchatsOn: false, model: "sonnet", effort: "low" });
  });

  it("a remount of the same draft keeps the model it would restore and the chip the user changed", () => {
    config.subchatsOn = true;
    mountDraftSubchats(pane, config);
    expect(config).toMatchObject({ model: "sonnet", effort: "high" });
    config.model = "fable";
    mountDraftSubchats(pane, config);
    expect(config.model).toBe("fable");
    config.model = "sonnet";
    mountDraftSubchats(pane, config);
    flip(false);
    expect(config).toMatchObject({ subchatsOn: false, model: "sonnet", effort: "low" });
  });

  it("the reveal timer of an earlier mount cannot show a later mount's row early", () => {
    vi.useFakeTimers();
    try {
      mountDraftSubchats(pane, config);
      vi.advanceTimersByTime(3000);
      mountDraftSubchats(pane, config);
      vi.advanceTimersByTime(1500);
      expect(pane.querySelector(".draft-subchats").classList.contains("is-pending")).toBe(true);
      vi.advanceTimersByTime(3000);
      expect(pane.querySelector(".draft-subchats").classList.contains("is-pending")).toBe(false);
      mountDraftSubchats(pane, config);
      unmountDraftSubchats(pane);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is removed once the chat has started", () => {
    unmountDraftSubchats(pane);
    expect(pane.querySelector(".draft-subchats")).toBeNull();
  });
});
