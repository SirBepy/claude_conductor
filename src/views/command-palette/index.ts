// Ctrl+Shift+P entry point: wires the real sources into the overlay.

import { closePalette, isPaletteOpen, openPalette } from "./palette-ui";
import {
  chatCommands,
  draftCommands,
  projectCommands,
  settingsCommands,
  shortcutCommands,
  thisChatCommands,
  whenDoneCommands,
} from "./sources";

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
