// Unit tests for pure helpers in src/shared/formatters.ts + src/shared/time.ts.
// Rewired from the deleted src/modules/formatters.js — vitest imports TS directly.

import { describe, it, expect } from "vitest";
import { pctColor, getPaceColor, fmtPct, valueColor } from "../src/shared/formatters.ts";
import { hourToMs } from "../src/shared/time.ts";

describe("pctColor", () => {
  it("returns dim for null/undefined", () => {
    expect(pctColor(null)).toBe("var(--sb-muted)");
    expect(pctColor(undefined)).toBe("var(--sb-muted)");
  });
  it("green below 50", () => {
    expect(pctColor(0)).toBe("#27ae60");
    expect(pctColor(49)).toBe("#27ae60");
  });
  it("orange at 50-79", () => {
    expect(pctColor(50)).toBe("#e67e22");
    expect(pctColor(79)).toBe("#e67e22");
  });
  it("red at 80+", () => {
    expect(pctColor(80)).toBe("#e74c3c");
    expect(pctColor(100)).toBe("#e74c3c");
  });
});

describe("fmtPct", () => {
  it("appends % for real numbers", () => {
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(42)).toBe("42%");
  });
  it("renders -- for null/undefined", () => {
    expect(fmtPct(null)).toBe("--");
    expect(fmtPct(undefined)).toBe("--");
  });
});

describe("getPaceColor", () => {
  // With paceBand 10 and safePace 50:
  //   pct <  40  → under
  //   40 <= pct <  50  → nearSafe
  //   50 <= pct <  60  → nearOver
  //   pct >= 60  → over
  const settings = {
    paceBand: 10,
    paceColors: { under: "U", nearSafe: "NS", nearOver: "NO", over: "O" },
  };
  it("classifies each band", () => {
    expect(getPaceColor(30, 50, settings)).toBe("U");
    expect(getPaceColor(45, 50, settings)).toBe("NS");
    expect(getPaceColor(55, 50, settings)).toBe("NO");
    expect(getPaceColor(70, 50, settings)).toBe("O");
  });
  it("defaults band to 10 and colors to built-ins when unset", () => {
    const c = getPaceColor(30, 50, {});
    expect(c).toBe("#27ae60");
  });
});

// Multi-account milestone 07: colorApplyTo gained an "overlay" target,
// consumed by src/views/overlay/overlay.ts.
describe("valueColor overlay target", () => {
  const settings = { paceBand: 10 };
  it("colors the overlay by pace when colorApplyTo.overlay is unset (default on)", () => {
    const c = valueColor(30, 50, settings, "overlay");
    expect(c).not.toBe("var(--color-text)");
  });
  it("colors the overlay by pace when colorApplyTo.overlay is explicitly true", () => {
    const c = valueColor(30, 50, { ...settings, colorApplyTo: { overlay: true } }, "overlay");
    expect(c).not.toBe("var(--color-text)");
  });
  it("falls back to neutral text when colorApplyTo.overlay is false", () => {
    const c = valueColor(30, 50, { ...settings, colorApplyTo: { overlay: false } }, "overlay");
    expect(c).toBe("var(--color-text)");
  });
  it("disabling overlay does not affect the dashboard target", () => {
    const c = valueColor(30, 50, { ...settings, colorApplyTo: { overlay: false } }, "dashboard");
    expect(c).not.toBe("var(--color-text)");
  });
});

describe("hourToMs", () => {
  it("parses YYYY-MM-DDTHH as local time", () => {
    const ms = hourToMs("2026-04-19T14");
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April
    expect(d.getDate()).toBe(19);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(0);
  });
  it("parses YYYY-MM-DDTHH:MM as local time", () => {
    const ms = hourToMs("2026-04-19T14:30");
    const d = new Date(ms);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});
