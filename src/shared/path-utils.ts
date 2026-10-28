// Drops empty segments so a trailing separator ("C:/Projects/foo/") still
// resolves to the folder name ("foo") instead of "".
/** A drive-letter path with Windows separators, the form Explorer, `code`
 *  and the clipboard expect. Anything else passes through untouched. */
export function winPath(p: string): string {
  return /^[a-z]:\//i.test(p) ? p.replace(/\//g, "\\") : p;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
