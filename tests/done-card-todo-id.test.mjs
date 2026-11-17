// asserts: src/shared/chat/dashboard/dashboard-model.ts

// pc-1771 item 11: a todo id is a device label (`pc`, `mac`, `pc2`, ... per ai-todos-format.md)
// plus a number. Any other word with 4 digits (`port-3000`, `iso-8601`) is a name, and a real id
// followed by a short suffix (`pc-0031-2`) is still that id.

import { describe, it, expect } from "vitest";

const { todoIdOf, taskTitle } = await import("../src/shared/chat/dashboard/dashboard-model.ts");

describe("todoIdOf", () => {
  it("does not read a word with four digits as a todo id", () => {
    expect(todoIdOf("port-3000", "")).toBeNull();
    expect(todoIdOf("fix port-3000 clash", "")).toBeNull();
    expect(todoIdOf("iso-8601 dates", "")).toBeNull();
    expect(todoIdOf("polish", "port-3000: moved the dev server")).toBeNull();
  });

  it("keeps a real id that carries a short numeric suffix", () => {
    expect(todoIdOf("pc-0031-2", "")).toBe("pc-0031");
    expect(todoIdOf("pc-0031-12-retry", "")).toBe("pc-0031");
    expect(todoIdOf("mac2-0007-3", "")).toBe("mac2-0007");
  });

  it("still reads the ids it always did", () => {
    expect(todoIdOf("pc-0031-build-chip", "")).toBe("pc-0031");
    expect(todoIdOf("Mac2-0007 sync", "")).toBe("mac2-0007");
    expect(todoIdOf("polish", "pc-1771: items 9-12")).toBe("pc-1771");
    expect(todoIdOf("audit-2026-11-16", "")).toBeNull();
    expect(todoIdOf("xpc-0031", "")).toBeNull();
  });

  it("leaves a port name whole in a title", () => {
    expect(taskTitle("port-3000")).toBe("Port 3000");
  });
});
