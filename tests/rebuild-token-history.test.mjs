// @vitest-environment jsdom
//
// A backfill that worked but whose refresh failed still reports the backfill
// counts, with the refresh failure noted apart.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { api, showToast } = vi.hoisted(() => ({
  api: { backfillTranscripts: vi.fn(), getTokenHistory: vi.fn(), getStorageInfo: vi.fn(async () => []) },
  showToast: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({ api }));
vi.mock("../src/shared/toast.ts", () => ({ showToast }));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: vi.fn() }));
vi.mock("../src/shared/state.ts", () => ({ setTokenHistory: vi.fn() }));
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => false }));

const { renderDataView } = await import("../src/views/settings/subviews/data/data.ts");

async function rebuild() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  await renderDataView(root);
  root.querySelector("#dataRebuildHistory").click();
  await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
  return root.querySelector("#dataRebuildStatus").textContent;
}

beforeEach(() => { showToast.mockReset(); document.body.innerHTML = ""; });

describe("Rebuild token history", () => {
  it("backfill success then a failed refresh still reports the counts", async () => {
    api.backfillTranscripts.mockResolvedValue({ processed: 3, skipped: 1 });
    api.getTokenHistory.mockRejectedValue(new Error("refresh down"));
    const status = await rebuild();
    expect(status).toContain("3 new, 1 skipped");
    expect(status).not.toMatch(/^Error/);
    expect(status).toContain("refresh down");
  });

  it("a failed backfill reports the error", async () => {
    api.backfillTranscripts.mockRejectedValue(new Error("no go"));
    expect(await rebuild()).toBe("Error: no go");
  });
});
