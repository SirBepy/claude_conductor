// Keyed list patcher for the account rows: a row that did not change is left
// alone (no animation replays, a hovered row never twitches), a new row opens
// into place, a removed row folds away while its neighbours slide up, and an
// open kebab menu is never clipped. Height animates through
// grid-template-rows 0fr -> 1fr (models-providers.css `.mp-li`).

export interface KeyedItem {
  key: string;
  html: string;
}

export interface KeyedListHooks {
  /** A row was created or its markup replaced: wire its menu and buttons. */
  onRow?: (row: HTMLElement) => void;
  /** A row is going away (or being replaced): undo what `onRow` wired. */
  onGone?: (row: HTMLElement) => void;
}

/** Longest a leaving row is kept when `transitionend` never fires (hidden tab, reduced-motion engines). */
const LEAVE_FALLBACK_MS = 420;

const signatures = new WeakMap<HTMLElement, string>();

const inner = (li: HTMLElement): HTMLElement => li.firstElementChild as HTMLElement;

/** Brings `host` in line with `items`. `animate: false` for the first paint, so a page load does not play every row's entrance. */
export function patchKeyedList(host: HTMLElement, items: readonly KeyedItem[], hooks: KeyedListHooks = {}, animate = true): void {
  const live = new Map<string, HTMLElement>();
  for (const li of Array.from(host.children) as HTMLElement[]) {
    if (li.classList.contains("is-leaving") || !li.dataset["key"]) continue;
    live.set(li.dataset["key"], li);
  }
  const wanted = new Set(items.map((i) => i.key));

  for (const [key, li] of live) {
    if (wanted.has(key)) continue;
    hooks.onGone?.(inner(li).firstElementChild as HTMLElement);
    if (!animate) { li.remove(); continue; }
    li.classList.add("is-leaving");
    let done = false;
    const finish = (): void => { if (!done) { done = true; li.remove(); } };
    li.addEventListener("transitionend", (e) => { if (e.target === li) finish(); });
    setTimeout(finish, LEAVE_FALLBACK_MS);
  }

  let cursor: Element | null = Array.from(host.children).find((c) => !c.classList.contains("is-leaving")) ?? null;
  for (const item of items) {
    let li = live.get(item.key);
    let fresh = false;
    if (!li) {
      li = document.createElement("div");
      li.className = "mp-li";
      li.dataset["key"] = item.key;
      li.innerHTML = `<div class="mp-li-in">${item.html}</div>`;
      signatures.set(li, item.html);
      fresh = true;
    } else if (signatures.get(li) !== item.html) {
      hooks.onGone?.(inner(li).firstElementChild as HTMLElement);
      inner(li).innerHTML = item.html;
      signatures.set(li, item.html);
      fresh = true;
    }
    if (li !== cursor) host.insertBefore(li, cursor);
    else cursor = nextLive(li);
    if (!fresh) continue;
    hooks.onRow?.(inner(li).firstElementChild as HTMLElement);
    if (!live.has(item.key) && animate) {
      // Starts folded, opens one frame later so the transition has a start value.
      li.classList.add("is-entering");
      requestAnimationFrame(() => requestAnimationFrame(() => li!.classList.remove("is-entering")));
    }
  }
}

function nextLive(li: Element): Element | null {
  let n = li.nextElementSibling;
  while (n?.classList.contains("is-leaving")) n = n.nextElementSibling;
  return n;
}
