// One Phosphor icon per paired machine (multi-machine federation), shared by
// the sidebar rows and the new-chat machine chips so both always agree.
//
// `Instance.machine` carries no OS, so the icons come from `list_machines`
// (this daemon's own identity plus its peers, each with `os`), fetched once
// and re-fetched when a row names a machine the cache has never seen.

import { api } from "../../shared/api";
import type { ListMachinesResult } from "../../shared/api";
import { getTransport } from "../../shared/transport";

export const OS_LOGO: Record<string, string> = {
  windows: "ph-windows-logo",
  macos: "ph-apple-logo",
  linux: "ph-linux-logo",
};
/** An OS with no logo of its own, the last resort once the pool runs out, and
 *  a mirrored row's glyph while its machine's OS is still unknown. */
export const GENERIC_MACHINE_ICON = "ph-desktop";
const UNKNOWN_ICON = GENERIC_MACHINE_ICON;
/** Icons for a machine whose OS logo another machine already holds. */
export const CLASH_POOL = [
  "ph-planet", "ph-cube", "ph-lightning", "ph-leaf", "ph-moon-stars",
  "ph-mountains", "ph-rocket-launch", "ph-snowflake", "ph-cactus", "ph-flower",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Machine id -> icon class. Each OS's lowest machine id keeps the OS logo;
 * every other machine on that OS gets a pool icon seeded by its own id.
 * Keyed only on ids and OSes, never on which daemon is asking, so the phone,
 * the PC and the Mac all compute the same icon for the same machine.
 *
 * 1 logo + CLASH_POOL.length machines per OS get distinct icons; beyond
 * that, extra machines on the same OS share the generic desktop glyph - an
 * explicit, documented collision, since growing CLASH_POOL further isn't
 * worth it for a count of paired machines this far past what Joe pairs.
 */
export function assignMachineIcons(
  machines: ReadonlyArray<{ machine_id: string; os: string; icon?: string | null }>,
): Map<string, string> {
  const sorted = [...machines].sort((a, b) => (a.machine_id < b.machine_id ? -1 : a.machine_id > b.machine_id ? 1 : 0));
  const out = new Map<string, string>();
  const used = new Set<string>();
  const clashed: string[] = [];
  // A chosen icon wins outright and is reserved first, so the automatic
  // logic below never hands the same glyph to a machine that did not pick it.
  // Two machines may both choose the same icon; that is their call.
  for (const m of sorted) {
    if (m.icon) { out.set(m.machine_id, m.icon); used.add(m.icon); }
  }
  for (const m of sorted) {
    if (out.has(m.machine_id)) continue;
    const logo = OS_LOGO[m.os] ?? UNKNOWN_ICON;
    if (used.has(logo)) {
      clashed.push(m.machine_id);
    } else {
      out.set(m.machine_id, logo);
      used.add(logo);
    }
  }
  for (const id of clashed) {
    const start = hash(id) % CLASH_POOL.length;
    // Stays UNKNOWN_ICON only when the pool is exhausted: the documented
    // collision above, shared by every machine past the pool.
    let icon = UNKNOWN_ICON;
    for (let i = 0; i < CLASH_POOL.length; i++) {
      const candidate = CLASH_POOL[(start + i) % CLASH_POOL.length]!;
      if (!used.has(candidate)) { icon = candidate; break; }
    }
    out.set(id, icon);
    used.add(icon);
  }
  return out;
}

let icons = new Map<string, string>();
let selfId: string | null = null;
let selfLabel: string | null = null;
let peerCount = 0;
let loaded = false;
let inflight = false;
/** Ids already re-fetched for, so a row whose machine never shows up in
 *  `list_machines` (an older peer, a stale mirror) can't re-fetch every render. */
const refetchedFor = new Set<string>();

/** Replaces the cache from one `list_machines` result. Returns whether any
 *  icon or the peer count changed, i.e. whether rows need a re-render. */
export function setMachines(res: Partial<ListMachinesResult> | null | undefined): boolean {
  const self = res?.self ?? null;
  const peers = Array.isArray(res?.peers) ? res.peers : [];
  const next = assignMachineIcons([...(self ? [self] : []), ...peers]);
  const changed = next.size !== icons.size
    || [...next].some(([id, icon]) => icons.get(id) !== icon)
    || peers.length !== peerCount;
  icons = next;
  selfId = self?.machine_id ?? null;
  selfLabel = self?.label ?? null;
  peerCount = peers.length;
  loaded = true;
  return changed;
}

/**
 * Fetches `list_machines` if it never ran, or once per unseen machine id among
 * `machineIds`, then calls `onChange` if the icons moved. A transport without
 * the federation backend fails the call; the cache then stays empty and rows
 * keep the generic glyph.
 */
export function ensureMachineIcons(machineIds: Iterable<string>, onChange: () => void): void {
  if (inflight) return;
  const unseen = [...machineIds].filter((id) => !icons.has(id) && !refetchedFor.has(id));
  if (loaded && unseen.length === 0) return;
  unseen.forEach((id) => refetchedFor.add(id));
  inflight = true;
  void api.listMachines()
    .then((res) => { if (setMachines(res)) onChange(); })
    .catch(() => { loaded = true; })
    .finally(() => { inflight = false; });
}

/**
 * Re-fetches `list_machines` whenever any daemon reports a profile change
 * (name or icon), so the sidebar follows an edit made on another device
 * without a reload. Returns the unlisten function.
 */
export function initMachineProfileSync(onChange: () => void): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void getTransport()
    .listen("machines-changed", () => {
      void api.listMachines()
        .then((res) => {
          // A machine that was unseen before may be known now.
          refetchedFor.clear();
          if (setMachines(res)) onChange();
        })
        .catch(() => { /* federation backend absent: keep the cached icons */ });
    })
    .then((u) => { if (disposed) u(); else unlisten = u; })
    .catch(() => { /* no event channel: icons refresh on the next render fetch */ });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Icon for a machine id; `null` means this daemon. `null` result = not known yet. */
export function machineIcon(machineId: string | null): string | null {
  const id = machineId ?? selfId;
  return id ? icons.get(id) ?? null : null;
}

/** This daemon's own label, for the "On <label>" tip on its rows. */
export function selfMachineLabel(): string | null {
  return selfLabel;
}

/** At least one peer is paired, so marking this daemon's own rows means something. */
export function hasPairedMachines(): boolean {
  return peerCount > 0;
}

/** Test-only: forget everything, as on a fresh page load. */
export function resetMachineIconsForTests(): void {
  icons = new Map();
  selfId = null;
  selfLabel = null;
  peerCount = 0;
  loaded = false;
  inflight = false;
  refetchedFor.clear();
}
