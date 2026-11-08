// After the palette opens a Settings page, scroll to one named row and flash it.
// The page renders asynchronously (and some rows only after a fetch), so the row
// is awaited with a MutationObserver instead of looked up once.

const WAIT_MS = 4000;

/** The `.kit-row` whose label starts with `label` (case-insensitive), or null. */
export function findSettingRow(root: ParentNode, label: string): HTMLElement | null {
  const want = label.trim().toLowerCase();
  for (const el of root.querySelectorAll<HTMLElement>(".kit-row-label")) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text.startsWith(want)) return el.closest<HTMLElement>(".kit-row") ?? el;
  }
  return null;
}

function flash(row: HTMLElement): void {
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("palette-flash");
  row.addEventListener("animationend", () => row.classList.remove("palette-flash"), { once: true });
}

/** Resolves true once the row was found and flashed, false if the page never showed it. */
export function focusSettingRow(label: string, root: HTMLElement = document.body): Promise<boolean> {
  return new Promise((resolve) => {
    const tryNow = (): boolean => {
      const row = findSettingRow(root, label);
      if (!row) return false;
      flash(row);
      return true;
    };
    const observer = new MutationObserver(() => {
      if (tryNow()) { cleanup(); resolve(true); }
    });
    const timer = setTimeout(() => { cleanup(); resolve(false); }, WAIT_MS);
    // Opening the page the user is already on may change no DOM at all, so the
    // observer alone would never fire; one late look covers that.
    const recheck = setTimeout(() => {
      if (tryNow()) { cleanup(); resolve(true); }
    }, 400);
    function cleanup(): void {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(recheck);
    }
    observer.observe(root, { childList: true, subtree: true });
  });
}
