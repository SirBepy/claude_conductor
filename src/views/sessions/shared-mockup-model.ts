// The shared mockup's logic with no DOM: which chip each sub gets in the row,
// what a control's value is, and where the controls popover may sit. The bar
// (shared-mockup-bar.ts) draws it; keeping this apart lets vitest cover it.

import type { Control, SharedMockup } from "../../types/ipc.generated";

/** A sub as the row needs it; `SubStatus` from main-chat.ts satisfies it. */
export interface RowSub {
  id: string;
  name: string;
  kind: string;
}

export interface OwnerControl {
  partId: string;
  control: Control;
}

/** One chip in the row: a chat that wrote a part, or a running sub that has not. */
export interface OwnerChip {
  id: string;
  name: string;
  controls: OwnerControl[];
}

/** The chips in the row: chats with controls first, in the order their first part
 *  was added, then dashed ones. A finished sub that never wrote anything is left
 *  out: it has nothing to add and would only be noise. */
export function ownerChips(shared: SharedMockup, subs: readonly RowSub[]): OwnerChip[] {
  const byId = new Map<string, OwnerChip>();
  for (const part of shared.parts) {
    let chip = byId.get(part.owner_session_id);
    if (!chip) {
      const sub = subs.find((s) => s.id === part.owner_session_id);
      chip = { id: part.owner_session_id, name: sub?.name ?? part.owner_name, controls: [] };
      byId.set(chip.id, chip);
    }
    for (const control of part.controls) chip.controls.push({ partId: part.id, control });
  }
  for (const sub of subs) {
    if (!byId.has(sub.id) && sub.kind !== "finished") byId.set(sub.id, { id: sub.id, name: sub.name, controls: [] });
  }
  const all = [...byId.values()];
  return [...all.filter((c) => c.controls.length > 0), ...all.filter((c) => c.controls.length === 0)];
}

/** Chips whose controls appeared since the last look and that are not open: they
 *  get the "new" dot. `seen` holds the chips already looked at for this page. */
export function freshChips(chips: readonly OwnerChip[], seen: ReadonlySet<string>, open: string | null): Set<string> {
  return new Set(chips.filter((c) => c.controls.length > 0 && !seen.has(c.id) && c.id !== open).map((c) => c.id));
}

export function controlKey(snapId: string, partId: string, controlId: string): string {
  return `${snapId}|${partId}|${controlId}`;
}

/** The value in force: what Joe set in this panel, else the control's default. */
export function controlValue(values: ReadonlyMap<string, string>, snapId: string, oc: OwnerControl): string {
  return values.get(controlKey(snapId, oc.partId, oc.control.id)) ?? oc.control.default;
}

export interface Box {
  w: number;
  h: number;
}

/** Keeps a popover of `size` fully inside `bounds`. The panel grows to fit a
 *  popover taller than itself, so the bound used for y is never below `size.h`. */
export function clampPos(pos: { x: number; y: number }, size: Box, bounds: Box): { x: number; y: number } {
  const maxY = Math.max(0, Math.max(bounds.h, size.h) - size.h);
  const maxX = Math.max(0, bounds.w - size.w);
  return { x: Math.max(0, Math.min(maxX, pos.x)), y: Math.max(0, Math.min(maxY, pos.y)) };
}
