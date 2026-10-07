import { describe, it, expect } from "vitest";
import { basename } from "../src/shared/path-utils.ts";

describe("basename", () => {
  it("returns filename from Unix path", () => {
    expect(basename("/home/user/foo.ts")).toBe("foo.ts");
  });

  it("returns filename from Windows path", () => {
    expect(basename("C:\\Users\\joe\\bar.tsx")).toBe("bar.tsx");
  });

  it("returns bare name when no separator", () => {
    expect(basename("file.ts")).toBe("file.ts");
  });

  it("skips a trailing separator to return the folder name (todo 1105)", () => {
    expect(basename("/some/path/")).toBe("path");
    expect(basename("C:/Projects/foo/")).toBe("foo");
  });

  it("returns p for empty string (no segments)", () => {
    expect(basename("")).toBe("");
  });
});
