// Recently run palette commands, newest first. Persisted so the commands Joe
// reaches for most are still on top after a relaunch; in-memory would reset the
// list every time the app restarts, which is when it matters most.

const LS_KEY = "cc_palette_recents";
const MAX = 8;

export function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string): string[] {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, MAX);
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); }
  catch { /* storage full or blocked: the palette just forgets */ }
  return next;
}
