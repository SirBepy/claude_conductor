import { escapeHtml } from "../../../shared/escape-html";

export const CAPTURE_TOOL = "mcp__cc_conductor__capture_secret_from_page";

const ROWS: Array<[string, string]> = [
  ["Save", "label"],
  ["Page", "page"],
  ["Element", "found"],
  ["Length", "length"],
  ["Into file", "file"],
  ["As key", "key"],
];

/**
 * The facts Joe approves a page-to-file secret save on, drawn open on the card instead of
 * inside the collapsed "Tool input" dump: a hostile page can offer look-alike elements, so
 * the page, the element's tag and id and its text length must be seen without a click.
 * The daemon builds these fields from a read of the element that never carries its text, so
 * nothing here is the secret; every value is escaped because the page worded some of them.
 */
export function captureFactsHtml(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const rows = ROWS.filter(([, key]) => o[key] !== undefined && o[key] !== null && o[key] !== "")
    .map(([name, key]) => {
      const raw = String(o[key]);
      const text = key === "length" ? `${raw} characters` : raw;
      return `<div class="prompt-card__fact"><dt>${escapeHtml(name)}</dt><dd><code>${escapeHtml(text)}</code></dd></div>`;
    })
    .join("");
  if (!rows) return "";
  const note = o.temporary ? `<p class="prompt-card__fact-note">Temporary: removed again when this chat ends.</p>` : "";
  return `<dl class="prompt-card__facts">${rows}</dl>${note}`;
}
