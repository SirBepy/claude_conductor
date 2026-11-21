// The panel sandbox has no localStorage: install an in-memory one before any app module reads it.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}
for (const name of ["localStorage", "sessionStorage"] as const) {
  try {
    void window[name].length;
  } catch {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
  }
}
// The sandbox also lacks the clipboard.
try {
  (navigator as unknown as { clipboard?: unknown }).clipboard ??= { writeText: async () => {} };
} catch { /* read-only */ }
export {};
