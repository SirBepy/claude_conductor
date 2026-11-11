// A composer destroyed while its slash provider is still starting (the Subchats
// card builds and drops one per avatar click) must not leave the
// "slash-commands-changed" listener behind: stop() ran before the listen call
// resolved, so nothing would ever unsubscribe it.

import { describe, it, expect, vi } from "vitest";

let release;
const unlisten = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({
    listen: () => new Promise((resolve) => { release = () => resolve(unlisten); }),
  }),
}));

const { SlashProvider } = await import("../src/shared/chat/caret-popup/providers/slash.ts");

describe("SlashProvider.stop during start", () => {
  it("unsubscribes a listener that registers after stop()", async () => {
    const p = new SlashProvider();
    const started = p.start(null);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    p.stop();
    release();
    await started;
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
