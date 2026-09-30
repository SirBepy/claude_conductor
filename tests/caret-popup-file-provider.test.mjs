import { describe, it, expect, vi, beforeEach } from "vitest";

// FileProvider drives the @-mention autocomplete in the chat composer.
// list_project_files has no daemon RPC (todo 1007), so on the phone the popup
// used to open and sit permanently empty - shouldTrigger must refuse instead.
const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { FileProvider } = await import("../src/shared/chat/caret-popup/providers/file.ts");

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(["a.ts", "b.ts"]);
  remote = false;
});

describe("FileProvider on the phone", () => {
  it("never triggers when isRemote() is true, so there is no dead empty popup", () => {
    remote = true;
    const p = new FileProvider();
    p.start("/repo");
    expect(p.shouldTrigger({ textBefore: "hello @f", caretPos: 8 })).toBe(false);
  });

  it("still triggers normally on desktop for the identical input", () => {
    remote = false;
    const p = new FileProvider();
    p.start("/repo");
    expect(p.shouldTrigger({ textBefore: "hello @f", caretPos: 8 })).toBe(true);
  });
});
