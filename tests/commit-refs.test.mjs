// @vitest-environment jsdom

// A sha in an assistant message links to the commit only when the session's
// repo confirms it; everything sha-shaped but unconfirmed stays plain text.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { markCommitCandidates } = await import("../src/shared/chat/markdown-highlight.ts");
const { renderMarkdown } = await import("../src/shared/chat/chat-transforms.ts");
const { resolveCommitRefs } = await import("../src/shared/chat/commit-refs.ts");

const span = (sha) => `<span class="commit-ref" data-sha="${sha}">${sha}</span>`;

describe("markCommitCandidates", () => {
  it("wraps a sha in prose and in inline code", () => {
    expect(markCommitCandidates("<p>landed in 8a180b5.</p>")).toBe(`<p>landed in ${span("8a180b5")}.</p>`);
    expect(markCommitCandidates("<p><code>469a502f</code></p>")).toBe(`<p><code>${span("469a502f")}</code></p>`);
  });

  it("leaves fenced code, links and attributes alone", () => {
    const pre = '<pre><code class="language-sh">git show 8a180b5</code></pre>';
    expect(markCommitCandidates(pre)).toBe(pre);
    const a = '<a href="https://x.dev/commit/8a180b5">8a180b5</a>';
    expect(markCommitCandidates(a)).toBe(a);
    const swatch = '<span class="colour-swatch" style="--swatch:#aabbccdd">#aabbccdd</span>';
    expect(markCommitCandidates(swatch)).toBe(swatch);
  });

  it("skips hex that is part of something else", () => {
    for (const text of [
      "550e8400-e29b-41d4-a716-446655440000",
      "src/8a180b5/file",
      "8a180b5.ts",
      "sha256:8a180b5aaaa",
      "8A180B5",
      "8a180b",
      "x8a180b5",
      `${"a".repeat(41)}`,
    ]) {
      expect(markCommitCandidates(`<p>${text}</p>`), text).not.toContain("commit-ref");
    }
  });

  it("runs as part of renderMarkdown", () => {
    expect(renderMarkdown("see `8a180b5`")).toContain(span("8a180b5"));
  });
});

describe("resolveCommitRefs", () => {
  beforeEach(() => invokeMock.mockReset());

  const ref = { query: "8a180b5", sha: "8a180b5" + "0".repeat(33), subject: "FIX: thing", body: "", author: "Joe", date: "2026-09-30T10:00:00+02:00" };

  function mount(html) {
    const root = document.createElement("div");
    root.className = "msg";
    root.innerHTML = markCommitCandidates(html);
    document.body.appendChild(root);
    return root;
  }

  it("upgrades only the shas git confirms, in one call", async () => {
    invokeMock.mockResolvedValueOnce([ref]);
    const root = mount("<p>8a180b5 and deadbee and 8a180b5 again</p>");
    await resolveCommitRefs(root, "C:/repo-a");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("resolve_commit_refs", { cwd: "C:/repo-a", candidates: ["8a180b5", "deadbee"] });
    const resolved = [...root.querySelectorAll(".commit-ref.resolved")].map((e) => e.dataset.sha);
    expect(resolved).toEqual(["8a180b5", "8a180b5"]);
    expect(root.querySelector('[data-sha="deadbee"]').classList.contains("resolved")).toBe(false);
    expect(root.querySelector(".commit-ref.resolved").getAttribute("role")).toBe("button");
  });

  it("answers a rebuilt bubble from the cache, hits and misses alike", async () => {
    const root = mount("<p>8a180b5 deadbee</p>");
    await resolveCommitRefs(root, "C:/repo-a");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(root.querySelector('[data-sha="8a180b5"]').classList.contains("resolved")).toBe(true);
  });

  it("does nothing without a cwd, and keeps repos separate", async () => {
    const root = mount("<p>8a180b5</p>");
    await resolveCommitRefs(root, undefined);
    expect(invokeMock).not.toHaveBeenCalled();
    invokeMock.mockResolvedValueOnce([]);
    await resolveCommitRefs(root, "C:/repo-b");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".commit-ref.resolved")).toBeNull();
  });

  it("does not cache a failed lookup", async () => {
    invokeMock.mockRejectedValueOnce(new Error("daemon down"));
    const root = mount("<p>abcdef1</p>");
    await resolveCommitRefs(root, "C:/repo-c");
    invokeMock.mockResolvedValueOnce([]);
    await resolveCommitRefs(root, "C:/repo-c");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
