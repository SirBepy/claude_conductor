// Chip-popover click wiring + reanchor logic for SessionStatusbar, extracted
// per todo 891 (the biggest, most mechanical seam: render() re-queried and
// re-bound a click handler per popover on every single render, plus a
// matching reanchor call each). render() rebuilds the bar's innerHTML on
// every call, so all of this is re-wired fresh each time - wireChipPopovers
// takes a ctx snapshot assembled once per render() (same pattern as
// statusbar-chips.ts's ChipRenderCtx) rather than reading `this` directly.
import type { GitInfo } from "../../types/ipc.generated";
import { driftLabel } from "./statusbar-chips";
import { DrainPopover } from "./drain-popover";
import { AiTodosPopover } from "./ai-todos-popover";
import { ServersPopover } from "./servers-popover";
import { ImagesPopover } from "./images-popover";
import { EffortPopover } from "./effort-popover";
import { ModelPopover } from "./model-popover";
import { GitCard } from "./git-card";
import { OverflowPopover, type OverflowPanelData } from "./overflow-popover";

/** The popovers a single closeChipPopovers() sweep dismisses. `tally` is
 *  typed structurally (not imported as ToolTallyRow) since only its
 *  closePopover method is needed here. */
export interface StatusbarPopovers {
  drainPopover: DrainPopover;
  aiTodosPopover: AiTodosPopover;
  serversPopover: ServersPopover;
  imagesPopover: ImagesPopover;
  effortPopover: EffortPopover;
  modelPopover: ModelPopover;
  gitCard: GitCard;
  overflowPopover: OverflowPopover;
  tally: { closePopover: () => void };
}

/** Dismiss every chip popover (both statusbar-owned and the tool-tally one). */
export function closeChipPopovers(p: StatusbarPopovers): void {
  p.drainPopover.close();
  p.aiTodosPopover.close();
  p.serversPopover.close();
  p.imagesPopover.close();
  p.effortPopover.close();
  p.modelPopover.close();
  p.gitCard.close();
  p.overflowPopover.close();
  p.tally.closePopover();
}

/** Re-anchor an open popover to its freshly-rendered chip, or close it if the
 *  chip vanished. */
export function reanchorIfOpen(
  container: HTMLElement,
  pop: { isOpen: boolean; close: () => void },
  sel: string,
  rebind: (anchor: HTMLElement) => void,
): void {
  if (!pop.isOpen) return;
  const anchor = container.querySelector<HTMLElement>(sel);
  if (anchor) rebind(anchor);
  else pop.close();
}

/** Reanchor variant for the two popovers a non-chip surface can also open.
 *  A LIVE anchor outside `container` (the pane header's config text) is not
 *  rebuilt by render(), so it only needs repositioning - running the chip
 *  selector against it would miss and close a popover still in use.
 *
 *  `isConnected` is the half that must be checked first. By the time this
 *  runs, render() has already reset container.innerHTML, so a chip-opened
 *  popover's remembered anchor is detached and `contains()` reports it as
 *  external too - treating that as the header case would close the popover
 *  on every background refresh instead of re-binding it to the rebuilt chip. */
export function reanchorConfigPopover(
  container: HTMLElement,
  pop: { isOpen: boolean; close: () => void },
  anchor: HTMLElement | null,
  sel: string,
  rebind: (anchor: HTMLElement) => void,
): void {
  if (!pop.isOpen) return;
  if (anchor?.isConnected && !container.contains(anchor)) {
    rebind(anchor);
    return;
  }
  reanchorIfOpen(container, pop, sel, rebind);
}

export interface ChipPopoverWireCtx extends StatusbarPopovers {
  cwd: string | null;
  liveCwd: string | null;
  gitInfo: GitInfo;
  gitCwd: string | null;
  effortAnchor: HTMLElement | null;
  modelAnchor: HTMLElement | null;
  toggleModelPopover: (anchor: HTMLElement) => void;
  toggleEffortPopover: (anchor: HTMLElement) => void;
  refreshGitInfo: () => void;
  overflowData: () => OverflowPanelData;
}

/** Wire every chip-popover's click handler plus its reanchor-after-rerender
 *  call. Called once per render() with a fresh ctx snapshot, so `ctx.X` here
 *  is exactly what `this.X` would read at click time - a click can only ever
 *  reach the LATEST render's listeners, since the innerHTML rebuild tears
 *  down the previous ones before this runs again. */
export function wireChipPopovers(container: HTMLElement, ctx: ChipPopoverWireCtx): void {
  const closeAll = () => closeChipPopovers(ctx);

  container.querySelector<HTMLElement>(".sb-model-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.toggleModelPopover(e.currentTarget as HTMLElement);
  });

  container.querySelector<HTMLElement>(".sb-effort-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.toggleEffortPopover(e.currentTarget as HTMLElement);
  });

  container.querySelector<HTMLElement>(".sb-ai-todos-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    const wasOpen = ctx.aiTodosPopover.isOpen;
    closeAll();
    if (!wasOpen) ctx.aiTodosPopover.open(anchor);
  });

  container.querySelector<HTMLElement>(".sb-drain-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    const wasOpen = ctx.drainPopover.isOpen;
    closeAll();
    if (!wasOpen) ctx.drainPopover.open(anchor);
  });

  container.querySelector<HTMLElement>(".sb-servers-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    const wasOpen = ctx.serversPopover.isOpen;
    closeAll();
    if (!wasOpen) ctx.serversPopover.open(anchor);
  });

  container.querySelector<HTMLElement>(".sb-images-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    const wasOpen = ctx.imagesPopover.isOpen;
    closeAll();
    if (!wasOpen) ctx.imagesPopover.open(anchor);
  });

  // The card is pinned to the SPAWN cwd, not the live one: it is always about
  // the chat's own repo, and the drift footer names wherever the AI went.
  for (const sel of [".sb-git-btn", ".sb-branch-btn", ".sb-commits-btn"]) {
    container.querySelector<HTMLElement>(sel)?.addEventListener("click", (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget as HTMLElement;
      const wasOpen = ctx.gitCard.isOpen;
      closeAll();
      if (wasOpen || !ctx.cwd) return;
      ctx.gitCard.open(anchor, {
        cwd: ctx.cwd,
        // Only attribute gitInfo.repo to the live location when the fetch
        // actually ran there - the off-repo fallback (gitCwd back on the
        // spawn cwd) would otherwise misname a non-repo folder (todo 921).
        awayLabel: driftLabel(ctx.cwd, ctx.liveCwd, ctx.gitCwd === ctx.liveCwd ? ctx.gitInfo.repo : null) || null,
        onPushed: () => ctx.refreshGitInfo(),
      });
    });
  }

  container.querySelector<HTMLElement>(".sb-overflow-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    const wasOpen = ctx.overflowPopover.isOpen;
    closeAll();
    if (!wasOpen) ctx.overflowPopover.open(anchor, ctx.overflowData());
  });

  // All popovers are body-appended and survive re-renders, but their anchor
  // chip was just replaced. Re-anchor if open so a background refresh doesn't
  // leave one bound to a detached node. Content that streams (drain, ai_todos)
  // rebuilds in place; static content just repositions.
  reanchorIfOpen(container, ctx.drainPopover, ".sb-drain-btn", (a) => ctx.drainPopover.open(a));
  reanchorIfOpen(container, ctx.aiTodosPopover, ".sb-ai-todos-btn", (a) => ctx.aiTodosPopover.open(a));
  reanchorIfOpen(container, ctx.serversPopover, ".sb-servers-btn", (a) => ctx.serversPopover.open(a));
  reanchorIfOpen(container, ctx.imagesPopover, ".sb-images-btn", (a) => ctx.imagesPopover.open(a));
  reanchorIfOpen(container, ctx.gitCard, ".sb-git-btn, .sb-branch-btn, .sb-commits-btn", (a) => ctx.gitCard.reanchor(a));
  reanchorIfOpen(container, ctx.overflowPopover, ".sb-overflow-btn", (a) => ctx.overflowPopover.open(a, ctx.overflowData()));
  reanchorConfigPopover(container, ctx.effortPopover, ctx.effortAnchor, ".sb-effort-btn", (a) => ctx.effortPopover.reanchor(a));
  reanchorConfigPopover(container, ctx.modelPopover, ctx.modelAnchor, ".sb-model-btn", (a) => ctx.modelPopover.reanchor(a));
}
