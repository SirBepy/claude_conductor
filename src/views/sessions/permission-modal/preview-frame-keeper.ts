// The card rebuilds its whole host with innerHTML on every pick, which would
// throw away each option preview iframe and load a fresh one: blank for as long
// as the new frame takes to refetch the app's stylesheets, a few seconds in the
// installed app (Joe, 2026-10-29). A detached iframe always unloads, but
// moveBefore() (Chromium 133+) moves a connected node without unloading it, so
// loaded frames are parked outside the host during the rebuild and moved into
// the new markup's matching slots. Without moveBefore a move reloads anyway, so
// the rebuild's own fresh frames are left as they are.

type MovableParent = ParentNode & { moveBefore?: (node: Node, child: Node | null) => void };

// A tile or thumbnail frame matches by its document. The stage frame is born
// empty and filled by option-previews.ts's sync(), which skips the reload while
// the frame's data-label still names the shown option, so it matches by stage.
function slotKey(frame: HTMLIFrameElement): string {
  const stage = frame.closest<HTMLElement>(".prompt-stage")?.dataset.stage;
  if (frame.classList.contains("prompt-stage__frame")) return `stage:${stage}`;
  return `${frame.className}\n${frame.getAttribute("srcdoc") ?? ""}`;
}

export function rebuildKeepingFrames(host: HTMLElement, rebuild: () => void): void {
  const park = document.createElement("div");
  const old = Array.from(host.querySelectorAll("iframe"));
  if (!old.length || !host.isConnected || typeof (park as MovableParent).moveBefore !== "function") {
    rebuild();
    return;
  }
  park.hidden = true;
  document.body.append(park);
  const parked = new Map<string, HTMLIFrameElement[]>();
  for (const frame of old) {
    const key = slotKey(frame);
    (park as MovableParent).moveBefore!(frame, null);
    parked.set(key, [...(parked.get(key) ?? []), frame]);
  }
  try {
    rebuild();
    for (const slot of Array.from(host.querySelectorAll("iframe"))) {
      const kept = parked.get(slotKey(slot))?.shift();
      const parent = slot.parentNode as MovableParent | null;
      if (!kept || !parent?.moveBefore) continue;
      parent.moveBefore(kept, slot);
      slot.remove();
    }
  } finally {
    park.remove();
  }
}
