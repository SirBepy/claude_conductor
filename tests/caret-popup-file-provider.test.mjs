// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// FileProvider drives the @-mention autocomplete in the chat composer.
// list_project_files is a daemon RPC (todo 1022), so the phone gets the same
// popup as the desktop, fed through the same invoke call.
const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { FileProvider } = await import("../src/shared/chat/caret-popup/providers/file.ts");
const { CaretSuggestPopup } = await import("../src/shared/chat/caret-popup/popup.ts");

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(["a.ts", "b.ts"]);
  remote = false;
});

describe("FileProvider on the phone", () => {
  it("triggers when isRemote() is true, same as desktop", () => {
    remote = true;
    const p = new FileProvider();
    p.start("/repo");
    expect(p.shouldTrigger({ textBefore: "hello @f", caretPos: 8 })).toBe(true);
  });

  it("still triggers normally on desktop for the identical input", () => {
    remote = false;
    const p = new FileProvider();
    p.start("/repo");
    expect(p.shouldTrigger({ textBefore: "hello @f", caretPos: 8 })).toBe(true);
  });
});

// Reproduces todo 1037: the daemon-served (phone) client's list_project_files
// round-trip over /api/rpc is slower than the local Tauri IPC call, so the
// FileProvider.query() call that fires on the FIRST "@" keystroke returns
// synchronously against the still-empty cache (refetch() is fire-and-forget),
// and CaretSuggestPopup.handleInput() closes on the empty result. Nothing
// used to re-run handleInput() once the fetch landed, so the popup stayed
// hidden even after list_project_files resolved with real files.
describe("FileProvider + CaretSuggestPopup wiring (todo 1037)", () => {
  function mount(provider) {
    const anchor = document.createElement("div");
    const ta = document.createElement("textarea");
    anchor.appendChild(ta);
    document.body.appendChild(anchor);
    const popup = new CaretSuggestPopup({ anchor, textarea: ta, providers: [provider] });
    return { popup, ta };
  }

  it("opens once the in-flight project-file fetch resolves, even though the first keystroke found an empty cache", async () => {
    let resolveFetch;
    invokeMock.mockReset().mockImplementation(
      () => new Promise((res) => { resolveFetch = res; }),
    );
    const provider = new FileProvider();
    provider.start("/repo");
    const { popup, ta } = mount(provider);

    ta.value = "@";
    ta.selectionStart = ta.selectionEnd = 1;
    popup.handleInput();
    // The fetch is still in flight: cache is empty, so this keystroke alone
    // cannot show anything yet - that much is expected on both platforms.
    expect(popup.isOpen()).toBe(false);

    resolveFetch(["a.ts", "b.ts"]);
    // Flush the refetch() microtask chain (await invoke(...) + the cache
    // assignment) without a real timer.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(popup.isOpen()).toBe(true);
  });
});
