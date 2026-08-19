import { describe, it, expect } from "vitest";
import { classifyMetaTurn, META_KIND_ICONS } from "../src/shared/chat/chat-classifiers.ts";

const text = (s) => classifyMetaTurn([{ type: "text", text: s }]);

// The CLI's own no-visible-output nudge, quoted here so the ordering tests
// below prove a daemon tag beats a nudge match inside the same body.
const RETRY_NUDGE = "Your previous response had no visible output. Please continue and produce a user-visible response.";

describe("classifyMetaTurn - daemon-tagged wakes", () => {
  it("buckets a fired /schedule item as a scheduled wake", () => {
    const meta = text("[schedule] check on the deploy");
    expect(meta.kind).toBe("wake");
    expect(meta.label).toBe("Scheduled wake");
    expect(meta.detail).toContain("check on the deploy");
  });

  it("buckets a Jarvis hygiene pass in its own bucket, not the generic wake one", () => {
    const meta = text("[hygiene] sweep the backlog");
    expect(meta.kind).toBe("hygiene");
    expect(meta.label).toBe("Hygiene pass");
    expect(META_KIND_ICONS.hygiene).toBe("ph-broom");
  });

  it("prefers the daemon tag over a retry nudge quoted in the body", () => {
    expect(text(`[hygiene] ${RETRY_NUDGE}`).kind).toBe("hygiene");
    expect(text(`[schedule] ${RETRY_NUDGE}`).kind).toBe("wake");
  });

  it("leaves the existing peer, fleet, retry and untagged buckets alone", () => {
    expect(text("[repo-channel] session-b: heads up").kind).toBe("peer");
    expect(text("[fleet] worker \"Fixer\" (w1) -> done").kind).toBe("fleet");
    expect(text(RETRY_NUDGE).kind).toBe("retry");
    expect(text("continue once the agent reports back").kind).toBe("wake");
  });
});
