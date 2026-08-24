// @vitest-environment jsdom
//
// Todo 302: `setSessionCharacterLocal` must resolve the new session id
// synchronously, without waiting for the async settings-changed reload.

import { describe, it, expect, vi } from "vitest";

const { listSessionCharacters } = vi.hoisted(() => ({ listSessionCharacters: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({
  api: { listSessionCharacters: (...a) => listSessionCharacters(...a) },
}));

vi.mock("../src/shared/character-icon.ts", () => ({
  getCharacterIconUrl: vi.fn().mockResolvedValue(null),
  cachedCharacterIconUrl: vi.fn().mockReturnValue(null),
}));

const { characterForSessionId, setSessionCharacterLocal, loadSessionCharacters } = await import(
  "../src/views/sessions/session-characters.ts"
);

describe("setSessionCharacterLocal", () => {
  it("resolves the new session id synchronously, with no await", () => {
    setSessionCharacterLocal("new-session", "raynor");
    expect(characterForSessionId("new-session")).toBe("raynor");
  });

  it("survives a subsequent loadSessionCharacters() reload once the daemon catches up", async () => {
    setSessionCharacterLocal("new-session-2", "tyrael");
    listSessionCharacters.mockResolvedValueOnce({ "new-session-2": "tyrael" });
    await loadSessionCharacters();
    expect(characterForSessionId("new-session-2")).toBe("tyrael");
  });
});
