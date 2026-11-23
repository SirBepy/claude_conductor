// The ticket trackers' marks, drawn as outline line art so they sit with the Phosphor icons
// around them (one stroke weight, round caps, `currentColor`, so hover and theme colour them).
//
// Licences. Jira and Trello are the Tabler Icons brand marks, 3.52.0, MIT
// (github.com/tabler/tabler-icons, Copyright Paweł Kuna). Linear, Shortcut and ClickUp are
// HAND-REDRAWN here as line art from their brand marks (geometry reference: Simple Icons
// 16.38.1, CC0), because no permissive outline set carries them. The brand shapes belong to
// their owners (trademarks): this is how a tracker is named in the app, not a claim to the marks.

export type TrackerMark = "shortcut" | "linear" | "jira" | "trello" | "clickup";

const PATHS: Readonly<Record<TrackerMark, string>> = {
  linear: `<circle cx="12" cy="12" r="9.2"/><path d="M3.9 8 16 20.1M2.9 11.8 12.2 21.1"/>`,
  jira: `<path d="M20 4h-9v1.5a2.5 2.5 0 0 0 2.5 2.5h1.5a1 1 0 0 1 1 1v1.5a2.5 2.5 0 0 0 2.5 2.5h1.5v-9"/><path d="M15 8h-8v1.5a2.5 2.5 0 0 0 2.5 2.5h1.5a1 1 0 0 1 1 1v1.5a2.5 2.5 0 0 0 2.5 2.5h1.5v-8a1 1 0 0 0 -1 -1"/><path d="M11 12h-8v1.5a2.5 2.5 0 0 0 2.5 2.5h1.5a1 1 0 0 1 1 1v1.5a2.5 2.5 0 0 0 2.5 2.5h1.5v-8a1 1 0 0 0 -1 -1"/>`,
  trello: `<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"/><path d="M7 7h3v10h-3l0 -10"/><path d="M14 7h3v6h-3l0 -6"/>`,
  shortcut: `<path d="M8.4 3H21l-5.6 6 5.5 5.4-5.7 6.1H3l5.6-6L3.1 9Z"/><path d="M8.6 15.1 15.2 9"/>`,
  clickup: `<path d="M4 10.8 12 4l8 6.8"/><path d="M4.6 15.6c2.1 3.4 4.7 5 7.4 5s5.3-1.6 7.4-5"/>`,
};

export const TRACKER_NAME: Readonly<Record<TrackerMark, string>> = {
  shortcut: "Shortcut", linear: "Linear", jira: "Jira", trello: "Trello", clickup: "ClickUp",
};

/** The inline mark, 1em square like a Phosphor glyph. */
export function trackerSvg(mark: TrackerMark, cls = "tk-mark"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[mark]}</svg>`;
}

/** The tracker a ticket's address belongs to, or null for any other address. */
export function trackerOfUrl(url: string): TrackerMark | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  const on = (d: string): boolean => host === d || host.endsWith(`.${d}`);
  if (on("shortcut.com") || on("clubhouse.io")) return "shortcut";
  if (on("linear.app")) return "linear";
  if (on("atlassian.net")) return "jira";
  if (on("trello.com")) return "trello";
  if (on("clickup.com")) return "clickup";
  return null;
}

/** A ticket id written in a sub's name or verdict: `sc-56709` is Shortcut's own spelling, an
 *  upper-case team key (`ENG-123`) is read as Linear. A Jira key has the same shape, so only a
 *  ticket's address (`trackerOfUrl`) tells the two apart. */
export function ticketIdIn(text: string): { id: string; tracker: TrackerMark } | null {
  const sc = /(?<![A-Za-z0-9])(sc-\d{3,})(?![0-9A-Za-z])/i.exec(text);
  if (sc) return { id: sc[1]!.toLowerCase(), tracker: "shortcut" };
  const key = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-(\d{2,6})(?![0-9A-Za-z-])/.exec(text);
  return key && !NOT_TEAM_KEYS.has(key[1]!) ? { id: `${key[1]}-${key[2]}`, tracker: "linear" } : null;
}

/** Upper-case words that are followed by a number in prose and are no team key ("ISO-8601", "SHA-256"). */
const NOT_TEAM_KEYS: ReadonlySet<string> = new Set(["UTF", "GPT", "ISO", "SHA", "RFC", "CVE", "TLS", "AES", "RSA", "MD", "HTTP", "WCAG", "ES", "PNG", "IPV", "SSE", "WS"]);
