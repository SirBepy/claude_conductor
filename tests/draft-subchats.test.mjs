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

const { mountDraftSubchats, syncDraftSubchats, lockDraftSubchats, unmountDraftSubchats } = await import("../src/views/sessions/draft-subchats.ts");
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
  it("keeps an Opus model and a high-or-better effort, else opus/high", () => {
    expect(mainChatLaunch("claude-opus-4-8", "max")).toEqual({ model: "claude-opus-4-8", effort: "max" });
    expect(mainChatLaunch("opus", "xhigh")).toEqual({ model: "opus", effort: "xhigh" });
    expect(mainChatLaunch("sonnet", "low")).toEqual({ model: "opus", effort: "high" });
    expect(mainChatLaunch("", "")).toEqual({ model: "opus", effort: "high" });
    expect(mainChatLaunch("opus", "medium")).toEqual({ model: "opus", effort: "high" });
  });
});

describe("the draft's Use subchats switch", () => {
  it("sits just above the message box and starts off", () => {
    expect(pane.querySelector(".draft-subchats").nextElementSibling).toBe(pane.querySelector(".composer-shell"));
    expect(input().checked).toBe(false);
    expect(config.subchatsOn).toBeUndefined();
  });

  it("switching it on sets the flag, moves the chat to Opus/high, and persists the draft", () => {
    flip(true);
    expect(config).toMatchObject({ subchatsOn: true, model: "opus", effort: "high" });
    expect(stateMock.pendingNewSession.config).toMatchObject({ subchatsOn: true, model: "opus", effort: "high" });
    expect(saveMock).toHaveBeenCalled();
    expect(stateMock.statusbar.syncModelEffort).toHaveBeenLastCalledWith("opus", "high");
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

  it("is removed once the chat has started", () => {
    unmountDraftSubchats(pane);
    expect(pane.querySelector(".draft-subchats")).toBeNull();
  });
});
