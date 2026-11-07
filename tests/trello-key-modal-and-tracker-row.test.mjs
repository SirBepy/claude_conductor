// @vitest-environment jsdom

// Two Trello UI behaviors with no other test that fails when they break:
//  1. A Trello hover card that failed on a missing secret offers "Add key" for
//     the secret the error NAMES (TRELLO_API_KEY or TRELLO_TOKEN), not the
//     first one in the registry list.
//  2. Project settings' tracker row: the Trello option, its board placeholder,
//     board-URL normalisation, refusal of an unusable id, and the field being
//     cleared when the select crosses the Trello boundary.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock, openApiKeyModal, listProjects, updateProject, ensureProject, showToast } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openApiKeyModal: vi.fn(),
  listProjects: vi.fn(),
  updateProject: vi.fn(),
  ensureProject: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/api-key-modal.ts", () => ({ openApiKeyModal }));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listProjects: (...a) => listProjects(...a),
    updateProject: (...a) => updateProject(...a),
    ensureProject: (...a) => ensureProject(...a),
  },
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast }));

const { handleTicketHover } = await import("../src/shared/chat/ticket-refs.ts");
const { renderTrackerRow } = await import("../src/views/sessions/project-dashboard/project-config/rows.ts");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Trello hover card: which key 'Add key' asks for", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openApiKeyModal.mockReset();
    openApiKeyModal.mockResolvedValue(false);
    window.matchMedia = () => ({ matches: true });
    // "Add key" is a desktop-only action (isRemote() is false inside Tauri).
    window.__TAURI__ = {};
  });

  async function hoverAndAddKey(cardId, message) {
    invokeMock.mockRejectedValue(new Error(message));
    const a = document.createElement("a");
    a.href = `https://trello.com/c/${cardId}`;
    a.textContent = "card";
    document.body.appendChild(a);
    handleTicketHover({ target: a });
    const btn = await vi.waitFor(() => {
      const b = document.querySelector(".ticket-card-add-key-btn");
      if (!b) throw new Error("no Add key button yet");
      return b;
    });
    btn.click();
    await vi.waitFor(() => expect(openApiKeyModal).toHaveBeenCalledTimes(1));
    return openApiKeyModal.mock.calls[0][0];
  }

  it("opens the modal for TRELLO_TOKEN when the error names the token", async () => {
    expect(await hoverAndAddKey("Xy12Zq90", "TRELLO_TOKEN is not set in ~/.claude/.env")).toBe("TRELLO_TOKEN");
  });

  it("opens the modal for TRELLO_API_KEY when the error names the API key", async () => {
    expect(await hoverAndAddKey("Ab34Cd56", "TRELLO_API_KEY is not set in ~/.claude/.env")).toBe("TRELLO_API_KEY");
  });

  it("offers no Add key button for an error that is not a missing secret", async () => {
    invokeMock.mockRejectedValue(new Error("Trello returned 404 Not Found"));
    const a = document.createElement("a");
    a.href = "https://trello.com/c/Zz99Yy88";
    document.body.appendChild(a);
    handleTicketHover({ target: a });
    await vi.waitFor(() => expect(document.querySelector(".ticket-card-error")).not.toBeNull());
    expect(document.querySelector(".ticket-card-add-key-btn")).toBeNull();
  });
});

describe("Project settings tracker row: Trello", () => {
  const PATH = "C:/proj/alpha";
  const select = () => document.getElementById("trackerKind");
  const input = () => document.getElementById("trackerWorkspace");

  beforeEach(() => {
    for (const m of [invokeMock, listProjects, updateProject, ensureProject, showToast]) m.mockReset();
    invokeMock.mockResolvedValue(null);
    updateProject.mockResolvedValue(undefined);
    document.body.innerHTML = `<div id="trackerControl"></div>`;
  });

  const change = (el) => el.dispatchEvent(new Event("change"));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("lists Trello and shows the board placeholder when Trello is stored", async () => {
    listProjects.mockResolvedValue([{ id: "p1", path: PATH, tracker: { kind: "trello", workspace: "AbCd1234" } }]);
    await renderTrackerRow(PATH);
    expect([...select().options].map((o) => o.value)).toContain("trello");
    expect(select().value).toBe("trello");
    expect(input().placeholder).toBe("board id (trello.com/b/<id>)");
    expect(input().value).toBe("AbCd1234");
  });

  it("saves a pasted board URL as the bare board id", async () => {
    listProjects.mockResolvedValue([{ id: "p1", path: PATH, tracker: null }]);
    await renderTrackerRow(PATH);
    select().value = "trello";
    change(select());
    input().value = " https://trello.com/b/AbCd1234/my-board ";
    change(input());
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith("p1", { tracker: { kind: "trello", workspace: "AbCd1234" } });
  });

  it("refuses an unusable board id with a toast and saves nothing", async () => {
    listProjects.mockResolvedValue([{ id: "p1", path: PATH, tracker: null }]);
    await renderTrackerRow(PATH);
    select().value = "trello";
    input().value = "my board";
    change(input());
    await flush();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Trello board id"));
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("clears the field when the select moves from Shortcut to Trello, so a workspace slug is never saved as a board", async () => {
    listProjects.mockResolvedValue([{ id: "p1", path: PATH, tracker: { kind: "shortcut", workspace: "zirtue" } }]);
    await renderTrackerRow(PATH);
    expect(input().value).toBe("zirtue");
    select().value = "trello";
    change(select());
    await flush();
    expect(input().value).toBe("");
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("keeps the field when the select moves between two non-Trello trackers", async () => {
    listProjects.mockResolvedValue([{ id: "p1", path: PATH, tracker: { kind: "shortcut", workspace: "zirtue" } }]);
    await renderTrackerRow(PATH);
    select().value = "linear";
    change(select());
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith("p1", { tracker: { kind: "linear", workspace: "zirtue" } });
  });
});
