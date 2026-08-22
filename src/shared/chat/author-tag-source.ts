// Lookup seam for the AI-authored tag (todo 682). chat-transforms is imported
// by ~20 modules, so any view-state or IPC dependency it takes lands in all of
// their graphs; main.ts registers the real resolver per window realm instead.

export interface AuthorTag {
  charId: string | null;
  cwd: string | null;
}

type AuthorTagResolver = (sessionId: string) => AuthorTag;

let resolve: AuthorTagResolver | null = null;

export function setAuthorTagResolver(fn: AuthorTagResolver | null): void {
  resolve = fn;
}

/** Nulls when unregistered - the tag falls back to its generic icons. */
export function authorTagFor(sessionId: string): AuthorTag {
  return resolve?.(sessionId) ?? { charId: null, cwd: null };
}
