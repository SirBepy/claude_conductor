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

/** The row entry (and `partId`) of the page's own controls. */
export const SHELL_ID = "shell";

/** The chips in the row: the "Page" entry (the shell's own controls) first when
 *  the page has any, then chats with controls first, in the order their first part
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
  const page: OwnerChip[] = shared.controls?.length
    ? [{ id: SHELL_ID, name: "Page", controls: shared.controls.map((control) => ({ partId: SHELL_ID, control })) }]
    : [];
  return [...page, ...all.filter((c) => c.controls.length > 0), ...all.filter((c) => c.controls.length === 0)];
}

/** Chips whose controls appeared since the last look and that are not open: they
 *  get the "new" dot. `seen` holds the chips already looked at for this page. */
export function freshChips(chips: readonly OwnerChip[], seen: ReadonlySet<string>, open: string | null): Set<string> {
  return new Set(chips.filter((c) => c.controls.length > 0 && !seen.has(c.id) && c.id !== open).map((c) => c.id));
}

export function controlKey(snapId: string, partId: string, controlId: string): string {
  return `${snapId}|${partId}|${controlId}`;
}

/** The daemon-side `view_state` key a control's value is saved under. */
export function stateKey(partId: string, controlId: string): string {
  return `ctl|${partId}|${controlId}`;
}

/** Inverse of [`stateKey`]; null for any other key (the page's own `page` state). */
export function parseStateKey(key: string): { partId: string; controlId: string } | null {
  const [tag, partId, controlId, ...rest] = key.split("|");
  if (tag !== "ctl" || !partId || !controlId || rest.length > 0) return null;
  return { partId, controlId };
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

/** Which element a page click belongs to: the region id the page reported, or
 *  "shell" for anything that is not a plain region id (the page is untrusted). */
export function elementTarget(region: unknown): string {
  return typeof region === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(region) && region !== SHELL_ID ? region : SHELL_ID;
}

/** The box's "To:" line. Joe never picks the recipient; this only names it. */
export function elementLabel(element: string): string {
  return element === SHELL_ID ? "To: page layout" : `To: ${element} region`;
}

/** Where the box opens: at the click, which the page reports relative to its own
 *  viewport, moved into panel coordinates by the frame's offset. */
export function boxOrigin(click: { x: number; y: number }, frame: { left: number; top: number }, panel: { left: number; top: number }): { x: number; y: number } {
  return { x: frame.left - panel.left + click.x, y: frame.top - panel.top + click.y };
}
