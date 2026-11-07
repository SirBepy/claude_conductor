/** Removes `param` from the address bar without a reload, keeping the path,
 *  every other param and the hash. No-op when the param is absent, so callers
 *  that read the value first can call it unconditionally. Swallows URL/history
 *  failures (sandboxed or opaque origins): a param left in the bar is harmless,
 *  an exception during boot is not. */
export function stripUrlParam(param: string): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(param)) return;
    url.searchParams.delete(param);
    const query = url.searchParams.toString();
    history.replaceState(null, "", url.pathname + (query ? `?${query}` : "") + url.hash);
  } catch { /* ignore */ }
}
