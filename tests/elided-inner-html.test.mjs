// The elided-image placeholder's icon and size label is written once
// (elidedInnerHtml) and shared by the tool_result row and the screenshot thumb,
// so the two cannot drift apart.

import { describe, it, expect } from "vitest";

const { elidedInnerHtml, elidedRowHtml } = await import("../src/shared/chat/elided-image.ts");

const REF = { toolUseId: "tu-1", seq: 7, mime: "image/png", bytes: 1572864 };

describe("elidedInnerHtml", () => {
  it("is the icon plus the escaped mime/size label", () => {
    expect(elidedInnerHtml(REF)).toBe(
      '<i class="ph ph-image"></i><span class="elided-image-label">image/png, 1.5 MB</span>',
    );
  });

  it("escapes a hostile mime", () => {
    expect(elidedInnerHtml({ ...REF, bytes: undefined, mime: "<b>x" })).toContain("&lt;b&gt;x");
  });

  it("is the body of the inline row", () => {
    expect(elidedRowHtml(REF)).toContain(`>${elidedInnerHtml(REF)}</div>`);
  });
});
