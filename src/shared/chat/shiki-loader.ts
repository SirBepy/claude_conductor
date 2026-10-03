// Shared lazy loader for the shiki "full" bundle (bundle/full, not /web - the
// web bundle lacks rust/toml/etc grammars this app's sessions edit constantly).
// That bundle pulls in the whole highlighting engine + every grammar/theme, so
// none of code-highlighter.ts / diff-enhancer.ts / file-surface.ts may import it
// statically - that would put shiki in the main bundle, loaded at boot for
// every window (including the tiny overlay HUD, which never renders code).
// All three route their first highlight call through this cached dynamic
// import instead, so shiki lands in its own chunk, fetched once on first use.
let modulePromise: Promise<typeof import("shiki/bundle/full")> | null = null;

export function loadShiki(): Promise<typeof import("shiki/bundle/full")> {
  if (!modulePromise) {
    modulePromise = import("shiki/bundle/full").catch((err) => {
      // Don't cache a rejection - a later call should retry the import
      // instead of leaving highlighting dead until window reload.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}
