// @vitest-environment jsdom

// Project settings > MCP servers. Pins: listed servers render with their
// sign-in state, adding saves the whole list through api.updateProject, a bad
// name or URL is refused before any save, and remove drops just that row.

import { describe, it, expect, vi, afterEach } from "vitest";

const { listProjects, updateProject, ensureProject, mcpSignedIn, mcpSignIn, openExternal, showToast } = vi.hoisted(() => ({
  listProjects: vi.fn(),
  updateProject: vi.fn(),
  ensureProject: vi.fn(),
  mcpSignedIn: vi.fn(),
  mcpSignIn: vi.fn(),
  openExternal: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../src/shared/api.ts", () => ({
  api: {
    listProjects: (...a) => listProjects(...a),
    updateProject: (...a) => updateProject(...a),
    ensureProject: (...a) => ensureProject(...a),
    mcpSignedIn: (...a) => mcpSignedIn(...a),
    mcpSignIn: (...a) => mcpSignIn(...a),
    openExternal: (...a) => openExternal(...a),
  },
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast }));
const { renderMcpServersRow, validMcpName, validMcpUrl } = await import(
  "../src/views/sessions/project-dashboard/project-config/mcp-servers-row.ts"
);

const RODGE = { name: "rodge", url: "http://localhost:3000/mcp" };
const PROJECT = { id: "p1", path: "C:/proj/rodge", mcp_servers: [RODGE] };

afterEach(() => {
  for (const m of [listProjects, updateProject, ensureProject, mcpSignedIn, mcpSignIn, openExternal, showToast]) m.mockReset();
  document.body.innerHTML = "";
});

async function mount() {
  const root = document.createElement("div");
  root.id = "mcpServersControl";
  document.body.appendChild(root);
  await renderMcpServersRow("C:/proj/rodge");
  return root;
}

describe("mcp name and url rules", () => {
  it("mirror the daemon's check", () => {
    expect(validMcpName("rodge")).toBe(true);
    expect(validMcpName("cc_conductor")).toBe(false);
    expect(validMcpName("has space")).toBe(false);
    expect(validMcpUrl("http://localhost:3000/mcp")).toBe(true);
    expect(validMcpUrl("ftp://x/mcp")).toBe(false);
    expect(validMcpUrl("not a url")).toBe(false);
  });
});

describe("Project settings > MCP servers", () => {
  it("shows Signed in for a stored sign-in and a Sign in button otherwise", async () => {
    listProjects.mockResolvedValue([PROJECT]);
    mcpSignedIn.mockResolvedValue({ [RODGE.url]: true });
    expect((await mount()).textContent).toContain("Signed in");
    document.body.innerHTML = "";
    mcpSignedIn.mockResolvedValue({ [RODGE.url]: false });
    expect((await mount()).querySelector(".mcp-row .ps-btn")?.textContent).toBe("Sign in");
  });

  it("adds a server by saving the whole list", async () => {
    listProjects.mockResolvedValue([{ ...PROJECT, mcp_servers: [] }]);
    const root = await mount();
    root.querySelector("#mcpNewName").value = "rodge";
    root.querySelector("#mcpNewUrl").value = RODGE.url;
    root.querySelector(".mcp-add .ps-btn").click();
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledWith("p1", { mcp_servers: [RODGE] }));
  });

  it("refuses a bad name or url without saving", async () => {
    listProjects.mockResolvedValue([{ ...PROJECT, mcp_servers: [] }]);
    const root = await mount();
    root.querySelector("#mcpNewName").value = "has space";
    root.querySelector("#mcpNewUrl").value = RODGE.url;
    root.querySelector(".mcp-add .ps-btn").click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("removes only the clicked server", async () => {
    const other = { name: "other", url: "http://localhost:4000/mcp" };
    listProjects.mockResolvedValue([{ ...PROJECT, mcp_servers: [RODGE, other] }]);
    mcpSignedIn.mockResolvedValue({});
    const root = await mount();
    root.querySelector(".mcp-row-remove").click();
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalledWith("p1", { mcp_servers: [other] }));
  });
});
