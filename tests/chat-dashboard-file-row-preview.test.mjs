// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/file-row-preview.ts
// A click on a Links and files row pushes the file's page to the Preview panel
// and opens it; folders, other chips and failures keep the old open.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { openFileInPreview, handleFileRowEvent } = await import("../src/views/sessions/chat-dashboard/file-row-preview.ts");

const deps = () => ({ push: vi.fn(async () => ({})), open: vi.fn(), fallback: vi.fn() });
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd) => (cmd === "read_text_file" ? { content: "# Hi\n", truncated: false } : undefined));
});

describe("openFileInPreview", () => {
  it("pushes the rendered page under a path slug and opens it", async () => {
    const d = deps();
    await openFileInPreview("C:/p/README.md", "s1", d);
    expect(d.push).toHaveBeenCalledOnce();
    const arg = d.push.mock.calls[0][0];
    expect(arg).toMatchObject({ title: "README.md", slug: "file:C:/p/README.md", session_id: "s1" });
    expect(arg.html).toContain("Hi");
    expect(d.open).toHaveBeenCalledWith("file:C:/p/README.md");
    expect(d.fallback).not.toHaveBeenCalled();
  });

  it("opens a missing or binary file the old way instead of pushing an error page", async () => {
    invokeMock.mockImplementation(async (cmd) => { if (cmd === "read_text_file") throw new Error("gone"); });
    const d = deps();
    await openFileInPreview("C:/p/gone.md", "s1", d, 7);
    expect(d.push).not.toHaveBeenCalled();
    expect(d.fallback).toHaveBeenCalledWith("C:/p/gone.md", 7);
  });

  it("ignores a second request for a file while its first is still running", async () => {
    const d = deps();
    await Promise.all([openFileInPreview("C:/p/a.md", "s1", d), openFileInPreview("C:/p/a.md", "s1", d)]);
    expect(d.push).toHaveBeenCalledOnce();
  });

  it("does not also open Code mode when only the panel open throws", async () => {
    const d = deps();
    d.open.mockImplementation(() => { throw new Error("panel"); });
    await expect(openFileInPreview("C:/p/a.md", "s1", d)).rejects.toThrow("panel");
    expect(d.fallback).not.toHaveBeenCalled();
  });

  it("falls back to the old open when the push fails", async () => {
    const d = deps();
    d.push.mockRejectedValue(new Error("no push_preview"));
    await openFileInPreview("C:/p/a.ts", null, d);
    expect(d.fallback).toHaveBeenCalledWith("C:/p/a.ts", undefined);
    expect(d.open).not.toHaveBeenCalled();
  });
});

describe("handleFileRowEvent", () => {
  const chip = (path, rowClass = "cdash-frow") => {
    document.body.innerHTML = `<div class="${rowClass}"><span class="file-ref" data-path="${path}"><span class="file-ref-name">x</span></span></div>`;
    return document.querySelector(".file-ref-name");
  };
  const click = (target) => {
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: target });
    return e;
  };

  it("takes a file row click and stops the shared handler", async () => {
    const d = deps();
    const e = click(chip("C:/p/a.md"));
    const stop = vi.spyOn(e, "stopImmediatePropagation");
    handleFileRowEvent(e, () => "s1", d);
    expect(e.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(d.open).toHaveBeenCalled());
  });

  it("leaves a chip outside a file row, and a folder row, alone", () => {
    const d = deps();
    const other = click(chip("C:/p/a.md", "cdash-change"));
    handleFileRowEvent(other, () => "s1", d);
    expect(other.defaultPrevented).toBe(false);
    const folder = click(chip("C:/p/dir/"));
    handleFileRowEvent(folder, () => "s1", d);
    expect(folder.defaultPrevented).toBe(false);
    expect(d.push).not.toHaveBeenCalled();
  });
});
