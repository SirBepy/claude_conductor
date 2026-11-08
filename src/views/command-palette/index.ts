// Ctrl+Shift+P entry point: wires the real sources into the overlay.

import { closePalette, isPaletteOpen, openPalette } from "./palette-ui";
import {
  chatCommands,
  draftCommands,
  draftRowCommands,
  projectCommands,
  settingsCommands,
  shortcutCommands,
  thisChatCommands,
  whenDoneCommands,
} from "./sources";
import { state } from "../sessions/state";
import { sessionSubtitle } from "../sessions/sessions-helpers";

export function toggleCommandPalette(): void {
  if (isPaletteOpen()) {
    closePalette();
    return;
  }
  openPalette({
    // The empty-query order: shortcuts first because they are what Ctrl+Shift+P
    // is for (see every key at a glance), the open chat's actions next. Search
    // ignores this order except to break ties.
    sync: () => [...shortcutCommands(), ...thisChatCommands(), ...draftCommands(), ...whenDoneCommands(), ...chatCommands(), ...settingsCommands()],
    later: [projectCommands],
  });
}

export type RowTarget =
  | { kind: "chat"; sessionId: string }
  | { kind: "draft"; cwd: string | null; onDiscard: () => void };

/** Right-click on a sidebar row: the palette narrowed to that one row's actions,
 *  whichever chat is open. */
export function openRowActionsPalette(target: RowTarget): void {
  if (isPaletteOpen()) return;
  if (target.kind === "draft") {
    openPalette({ sync: () => draftRowCommands(target.cwd, target.onDiscard), later: [], placeholder: "Actions for this draft" });
    return;
  }
  const sess = state.sessions.find((s) => s.session_id === target.sessionId);
  if (!sess) return;
  openPalette({
    sync: () => thisChatCommands(target.sessionId),
    later: [],
    placeholder: `Actions for "${sessionSubtitle(sess)}"`,
  });
}
