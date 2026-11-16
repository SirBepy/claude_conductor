// The two-letter stand-in for a project that has no icon file of its own.

/** Two letters for a project: the initials of its first two words, else its first two letters. */
export function monogramText(name: string): string {
  const words = name.split(/[\s_\-./\\]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const first = (w: string): string => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "";
  if (words.length >= 2) return (first(words[0]!) + first(words[1]!)).toUpperCase();
  const letters = [...(words[0] ?? "").replace(/[^\p{L}\p{N}]/gu, "")];
  return (letters.slice(0, 2).join("") || "?").toUpperCase();
}

/** A hue from the project's path, so two projects of one stack never look alike. */
export function monogramHue(path: string): number {
  let h = 2166136261;
  for (const ch of path) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}

/** Inline style for a monogram face: dark enough for white letters at every hue. */
export function monogramStyle(path: string): string {
  return `background:hsl(${monogramHue(path)} 48% 34%);color:#fff`;
}
