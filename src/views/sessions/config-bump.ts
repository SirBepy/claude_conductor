// The motion a keyboard model/effort change plays on every surface that
// prints the value (statusline chip + pane header), so a change made without
// looking at either still reads as "went up" or "went down".

import "./config-bump.css";

export type ConfigKind = "model" | "effort";
/** 1 = up (bigger model / more effort), -1 = down, 0 = already at the end. */
export type BumpDirection = 1 | -1 | 0;

const SELECTORS: Record<ConfigKind, string> = {
  model: ".sb-model, .session-header .meta-cfg-model",
  effort: ".sb-effort, .session-header .meta-cfg-effort",
};

const CLASSES = ["cfg-bump-up", "cfg-bump-down", "cfg-bump-edge"];

export function bumpClass(dir: BumpDirection): string {
  return dir === 1 ? "cfg-bump-up" : dir === -1 ? "cfg-bump-down" : "cfg-bump-edge";
}

export function playConfigBump(kind: ConfigKind, dir: BumpDirection, root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>(SELECTORS[kind])) {
    el.classList.remove(...CLASSES);
    // Reading layout restarts the animation when the same class lands again
    // on a quick second press.
    void el.offsetWidth;
    el.classList.add(bumpClass(dir));
    el.addEventListener("animationend", () => el.classList.remove(...CLASSES), { once: true });
  }
}
