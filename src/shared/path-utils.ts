// Drops empty segments so a trailing separator ("C:/Projects/foo/") still
// resolves to the folder name ("foo") instead of "".
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
