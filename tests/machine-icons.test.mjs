// Machine icon assignment (multi-machine federation): each OS's logo goes to
// one machine, a machine whose logo is taken gets a stable icon of its own,
// and every viewer (phone, PC, Mac) computes the same map.

import { describe, it, expect } from "vitest";

const { assignMachineIcons } = await import("../src/views/sessions/machine-icons.ts");

const PC = { machine_id: "a-pc", os: "windows" };
const MAC = { machine_id: "b-mac", os: "macos" };
const STUDIO = { machine_id: "c-studio", os: "macos" };

describe("assignMachineIcons", () => {
  it("gives each machine its OS logo when no two share an OS", () => {
    const icons = assignMachineIcons([PC, MAC]);
    expect(icons.get("a-pc")).toBe("ph-windows-logo");
    expect(icons.get("b-mac")).toBe("ph-apple-logo");
  });

  it("a second machine on a taken OS gets a non-logo icon, never a duplicate", () => {
    const icons = assignMachineIcons([PC, MAC, STUDIO]);
    expect(icons.get("b-mac")).toBe("ph-apple-logo");
    const studio = icons.get("c-studio");
    expect(studio).toBeTruthy();
    expect(["ph-windows-logo", "ph-apple-logo", "ph-desktop"]).not.toContain(studio);
    expect(new Set(icons.values()).size).toBe(3);
  });

  it("the lowest machine id keeps the OS logo, whatever order the list arrives in", () => {
    const a = assignMachineIcons([STUDIO, PC, MAC]);
    const b = assignMachineIcons([MAC, STUDIO, PC]);
    expect([...a].sort()).toEqual([...b].sort());
    expect(a.get("b-mac")).toBe("ph-apple-logo");
  });

  it("a phone through the PC and a phone through the Mac see the same icons", () => {
    // list_machines returns {self, peers}; each daemon has a different self.
    const viaPc = assignMachineIcons([PC, MAC, STUDIO]);
    const viaMac = assignMachineIcons([MAC, PC, STUDIO]);
    expect(viaMac).toEqual(viaPc);
  });

  it("an OS with no logo falls back to the generic desktop glyph", () => {
    expect(assignMachineIcons([{ machine_id: "x", os: "freebsd" }]).get("x")).toBe("ph-desktop");
  });

  it("13 machines on one OS exhaust the pool: the overflow shares the generic glyph, documented, not silent", () => {
    const machines = Array.from({ length: 13 }, (_, i) => ({ machine_id: `m-${String(i).padStart(2, "0")}`, os: "windows" }));
    const icons = assignMachineIcons(machines);
    const values = [...icons.values()];
    // 1 OS logo + 10 CLASH_POOL icons keep 11 machines distinct; the rest
    // share the generic desktop glyph as a 12th, documented, repeated value.
    expect(new Set(values).size).toBe(12);
    const overflow = values.filter((v) => v === "ph-desktop");
    expect(overflow.length).toBe(machines.length - 11);
  });
});
