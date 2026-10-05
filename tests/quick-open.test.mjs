// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Ctrl+P is Go to file, never the WebView's print dialog: the picker lists the
// chat's repo files and hands the pick to Code mode; Escape picks nothing.
const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};

const { openQuickOpen, isQuickOpenOpen } = await import("../src/views/sessions/code-mode/quick-open.ts");
const { installPrintBlock } = await import("../src/shared/print-block.ts");
const { findConflict } = await import("../src/shared/shortcuts.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (k, opts = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};
const input = () => document.querySelector(".qo-input");
const type = (text) => {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset().mockResolvedValue(["README.md", "src\\main.ts", "src/views/app.ts"]);
});

afterEach(() => {
  if (isQuickOpenOpen()) key("Escape");
});

describe("Ctrl+P", () => {
  it("is bound to Go to file", () => {
    expect(findConflict("ctrl+p")?.id).toBe("quick-open");
  });

  it("never reaches the print dialog", () => {
    installPrintBlock();
    expect(key("p", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(key("P", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(key("o", { ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

describe("Go to file picker", () => {
  it("lists the chat's project files and picks the best match on Enter", async () => {
    const picked = [];
    openQuickOpen("/repo", (p) => picked.push(p));
    expect(invokeMock).toHaveBeenCalledWith("list_project_files", { projectDir: "/repo" });
    expect(document.activeElement).toBe(input());
    await flush();

    type("main");
    key("Enter");

    expect(picked).toEqual(["src/main.ts"]);
    expect(isQuickOpenOpen()).toBe(false);
    expect(document.querySelector(".quick-open-overlay")).toBeNull();
  });

  it("moves the selection with the arrow keys", async () => {
    const picked = [];
    openQuickOpen("/repo", (p) => picked.push(p));
    await flush();

    key("ArrowDown");
    key("ArrowDown");
    key("Enter");

    expect(picked).toEqual(["src/views/app.ts"]);
  });

  it("closes on Escape without picking, and the Escape doesn't also leave Code mode", async () => {
    const picked = [];
    const codeModeSaw = [];
    const codeModeKeys = (e) => codeModeSaw.push(e.key);
    document.addEventListener("keydown", codeModeKeys, true);
    openQuickOpen("/repo", (p) => picked.push(p));
    await flush();

    key("Escape");
    document.removeEventListener("keydown", codeModeKeys, true);

    expect(picked).toEqual([]);
    expect(isQuickOpenOpen()).toBe(false);
    expect(codeModeSaw).not.toContain("Escape");
  });

  it("closes on a backdrop click without picking", async () => {
    const picked = [];
    openQuickOpen("/repo", (p) => picked.push(p));
    await flush();

    document.querySelector(".quick-open-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(picked).toEqual([]);
    expect(isQuickOpenOpen()).toBe(false);
  });
});
