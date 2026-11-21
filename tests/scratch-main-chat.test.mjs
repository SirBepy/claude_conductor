// @vitest-environment jsdom
// pc-1806 step 7: the "No project" folder (the Obsidian vault) holds ONE shared scratch main chat.
// A draft there is plain unless its "Send to the scratch main chat" switch is on; every other
// project's draft keeps the old behaviour (a main chat takes the message unless "Plain chat instead").

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ savePendingSession: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({ api: { listProjects: vi.fn(async () => []) } }));

const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");
const { setProjectMainChatsForTest } = await import("../src/views/sessions/project-main-chats.ts");
const { mountDraftSubchats, draftRouteTarget, isScratchDraft, syncDraftSubchats } = await import("../src/views/sessions/draft-subchats.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const VAULT = "C:\\Users\\tecno\\Documents\\ObsidianVault";
const OTHER = "C:/Projects/cv";
const acct = (id, kind) => ({ id, label: id, icon: "x", colour: "#fff", kind });
const inst = (over = {}) => ({
  session_id: "scratch", pid: 1, cwd: VAULT, project_id: "p-vault", kind: "interactive", is_remote: false,
  started_at: "2026-11-21T10:00:00Z", transcript_path: null, name: "Scratch pad", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});

let pane;
let config;

function draft(path, over = {}) {
  config = { model: "sonnet", effort: "low", accountId: "sub", ...over };
  state.pendingNewSession = { placeholderId: "p1", projectPath: path, config };
  mountDraftSubchats(pane, config);
  syncDraftSubchats(pane, config);
}

const route = () => pane.querySelector(".draft-main-route");
const routeInput = () => route().querySelector("input");
const useRow = () => pane.querySelector(".draft-subchats");
const flip = (checked) => {
  routeInput().checked = checked;
  routeInput().dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = `<div id="pane"><div class="session-messages"></div><div class="composer-shell"></div></div>`;
  pane = document.getElementById("pane");
  state.sessions = [];
  state.pendingNewSession = null;
  state.statusbar = { syncModelEffort: vi.fn() };
  setCachedAccounts([acct("sub", "subscription"), acct("api", "api_credit")]);
  setProjectMainChatsForTest([
    { id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: null },
    { id: "p-cv", path: OTHER, name: "cv-site", mainChatId: null },
  ]);
});

describe("a draft in the No project folder", () => {
  it("is a scratch draft only on this machine's vault", () => {
    expect(isScratchDraft({ ...{ model: "x", effort: "y" } })).toBe(false);
    draft(VAULT);
    expect(isScratchDraft(config)).toBe(true);
    draft(OTHER);
    expect(isScratchDraft(config)).toBe(false);
    draft(VAULT, { machineId: "m1" });
    expect(isScratchDraft(config)).toBe(false);
  });

  it("shows the Send to the scratch main chat switch, off, and never the Use subchats row", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false });
    expect(route().hidden).toBe(false);
    expect(route().querySelector(".dmr-switch-label").textContent).toBe("Send to the scratch main chat");
    expect(routeInput().getAttribute("aria-label")).toBe("Send to the scratch main chat");
    expect(routeInput().checked).toBe(false);
    expect(route().querySelector(".dmr-line").textContent).toBe("A plain chat");
    expect(useRow().hidden).toBe(true);
  });

  it("with no scratch main chat open, switching on makes this draft the main chat (mode on, not plain)", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false });
    flip(true);
    expect(config).toMatchObject({ plainChat: false, subchatsOn: true, model: "sonnet", effort: "high" });
    expect(route().querySelector(".dmr-line").textContent).toBe("Starts the scratch main chat");
    expect(draftRouteTarget(config)).toBeNull();
    flip(false);
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false, effort: "low" });
  });

  it("an open scratch main chat never takes a plain draft's message, and takes it once the switch is on", () => {
    setProjectMainChatsForTest([{ id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: "scratch" }]);
    adoptSubchatsOn("scratch");
    state.sessions = [inst()];
    draft(VAULT, { plainChat: true, subchatsOn: false });
    expect(draftRouteTarget(config)).toBeNull();
    expect(routeInput().checked).toBe(false);

    flip(true);
    expect(draftRouteTarget(config)?.chat.session_id).toBe("scratch");
    expect(route().querySelector(".dmr-line").textContent).toBe("Goes to Scratch pad");
    expect(routeInput().checked).toBe(true);
    expect(route().classList.contains("is-on")).toBe(true);
  });

  it("names a put-away scratch main chat as a reopen when the switch is on", () => {
    setProjectMainChatsForTest([{ id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: "scratch" }]);
    adoptSubchatsOn("scratch");
    state.sessions = [inst({ hidden_at: "2026-11-21T11:00:00Z" })];
    draft(VAULT, { plainChat: true, subchatsOn: false });
    flip(true);
    expect(route().querySelector(".dmr-line").textContent).toContain("Reopens Scratch pad");
  });

  it("an API-credit account cannot switch it on when no scratch chat is open to send to", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false, accountId: "api" });
    expect(routeInput().disabled).toBe(true);
    expect(route().title).toContain("API-credit");
    config.accountId = "sub";
    syncDraftSubchats(pane, config);
    expect(routeInput().disabled).toBe(false);
  });

  it("an account that moves to API credit under an on switch turns it back off", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false });
    flip(true);
    config.accountId = "api";
    syncDraftSubchats(pane, config);
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false });
    expect(routeInput().checked).toBe(false);
  });

  it("a card chat (third-party text in hand) gets no switch and stays plain", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false, initialMessage: "do the card" });
    expect(route().hidden).toBe(true);
    expect(useRow().hidden).toBe(true);
  });
});

describe("a draft anywhere else", () => {
  it("still routes to the project's main chat by default, with the Plain chat instead switch", () => {
    setProjectMainChatsForTest([{ id: "p-cv", path: OTHER, name: "cv-site", mainChatId: "main" }]);
    adoptSubchatsOn("main");
    state.sessions = [inst({ session_id: "main", cwd: OTHER, project_id: "p-cv", name: "CV redesign" })];
    draft(OTHER, { subchatsOn: true });
    expect(draftRouteTarget(config)?.chat.session_id).toBe("main");
    expect(route().hidden).toBe(false);
    expect(route().querySelector(".dmr-switch-label").textContent).toBe("Plain chat instead");
    expect(routeInput().checked).toBe(false);
    expect(route().querySelector(".dmr-line").textContent).toContain("cv-site's main chat");
    expect(useRow().hidden).toBe(true);
  });

  it("a project with no main chat keeps the Use subchats row and hides the route", () => {
    draft(OTHER, { subchatsOn: true });
    expect(route().hidden).toBe(true);
    expect(useRow().hidden).toBe(false);
  });
});
