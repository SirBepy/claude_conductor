/** A sub's tier as a short quiet label: "Sonnet high". The family without its
 *  version, because the three tiers a main chat picks from are families at an
 *  effort, and the version only adds noise to a row. A foreign id (an Endpoint
 *  account's model, e.g. "k3.1-pro") keeps its exact spelling: modelLabel's
 *  version pretty-printing would mangle it ("K3.1.pro"). An empty model gives
 *  no label at all. */
export function tierLabel(model: string | null | undefined, effort: string | null | undefined): string {
  const m = (model ?? "").trim();
  if (!m) return "";
  const family = /opus|sonnet|haiku/i.exec(m)?.[0];
  const name = family ? family.charAt(0).toUpperCase() + family.slice(1).toLowerCase() : m;
  const e = (effort ?? "").trim().toLowerCase();
  return e ? `${name} ${e}` : name;
}

/** "claude-opus-5" -> "Opus 5"; a foreign endpoint id ("k3.1-pro") stays
 *  verbatim: modelLabel's version pretty-printing would mangle it
 *  ("K3.1.pro"). Used where one model name must serve both kinds. */
export function chatModelLabel(model: string): string {
  return /opus|sonnet|haiku|fable/i.test(model) ? modelLabel(model) : model.trim();
}

/** "claude-opus-4-8" -> "Opus 4.8" (capitalized, version dotted). Used in the
 *  statusbar chips and the new-session model picker. Strips the "claude-"
 *  prefix, any trailing date stamp ("-20251001") or "[1m]" context suffix,
 *  turns the family/version split into a space and the remaining version
 *  hyphens into dots. Result matches the API's display_name minus the brand
 *  prefix (e.g. "Claude Opus 4.8" -> "Opus 4.8"). */
export function modelLabel(model: string): string {
  let m = model
    .replace(/^claude-/, "")
    .replace(/\[[^\]]*\]$/, "") // drop a "[1m]" context-window suffix
    .replace(/-\d{6,}$/, ""); // drop a trailing date stamp like "-20251001"
  m = m.replace(/-(?=\d)/, " "); // family/version boundary -> space (first only)
  m = m.replace(/-/g, "."); // remaining version hyphens -> dots
  return m.charAt(0).toUpperCase() + m.slice(1);
}
