// A palette row. `run` and `stage` are mutually exclusive: `run` does the thing
// and closes the palette, `stage` swaps the list for a second pick (switch
// branch) without closing it. Neither set means the row is shown but inert,
// with `disabledReason` saying why.

export interface PaletteStage {
  placeholder: string;
  load: () => Promise<PaletteCommand[]>;
}

export interface PaletteCommand {
  /** Stable across launches: it is the key the recents list stores. */
  id: string;
  title: string;
  /** Shown muted at the row's right edge ("Chat", "Settings"). */
  group: string;
  /** Phosphor icon name without the `ph-` prefix. */
  icon: string;
  /** Muted text after the title: the project a chat belongs to, the page a setting lives on. */
  detail?: string;
  /** Normalized binding ("ctrl+shift+d"), drawn as a keycap. */
  keys?: string;
  /** Extra words the search matches but the row does not show. */
  keywords?: string[];
  disabledReason?: string;
  run?: () => void | Promise<void>;
  stage?: PaletteStage;
}

export function isRunnable(c: PaletteCommand): boolean {
  return !c.disabledReason && (c.run !== undefined || c.stage !== undefined);
}
