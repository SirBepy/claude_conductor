// Page templates for pushed previews. Every document the Preview panel (and
// the inline show_preview card) renders is a real HTML page; a template is the
// shared chrome the panel puts around it, so a preview looks like a page no
// matter which producer pushed it (/preview, /mockup, show_preview).
//
// A page picks its template with `<meta name="preview-template" content="...">`
// and gets `page` when it names none. Add a template by adding an entry here.
//
// Template rules are `:where()` (specificity 0) on purpose: anything the page
// declares itself beats them, so a page that already styles its own body never
// fights the template, and `body { margin: 0 }` alone still leaves the padding.

export interface PreviewTemplate {
  /** Head markup spliced in ahead of the page's own head content. */
  headHtml: string;
}

// Literal numbers, not tokens.css vars: the page loads into an opaque origin
// with no access to the app's custom properties.
// --pv-pad is 12px on a 390px phone and 28px from about 930px up, so a phone
// does not lose a tenth of its width to margin. The two vars are also what a
// bundled board's tail rule reads (bundle-board.mjs) to re-apply the template
// after the app's own `html, body { padding: 0 }` reset, which loads later and
// would otherwise win.
const PAGE_CSS = `:where(html){-webkit-text-size-adjust:100%;--pv-pad:clamp(12px,3vw,28px);--pv-max:1040px}
:where(body){box-sizing:border-box;max-width:var(--pv-max);margin:0 auto;padding:var(--pv-pad);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.55;overflow-wrap:break-word}
:where(img,video){max-width:100%;height:auto}`;

// The viewport meta only matters when the page is opened as a top-level
// document ("Open in browser" on a phone); inside the panel's iframe it is
// ignored.
const VIEWPORT_META = `<meta name="viewport" content="width=device-width, initial-scale=1">`;

const PAGE: PreviewTemplate = {
  headHtml: `<style data-preview-template="page">${PAGE_CSS}</style>`,
};

// `bare` is for a page that owns its whole layout (a sidebar-and-content
// markdown render, an app-shell mockup, a card that only frames another page),
// where a centered padded column would squeeze or double up its own chrome.
const BARE: PreviewTemplate = { headHtml: "" };

const TEMPLATES: Record<string, PreviewTemplate> = { page: PAGE, bare: BARE };

const DEFAULT_PREVIEW_TEMPLATE = "page";

/** Either attribute order, single or double quotes. */
const TEMPLATE_META_RES = [
  /<meta\s[^>]*\bname=["']preview-template["'][^>]*\bcontent=["']([\w-]+)["']/i,
  /<meta\s[^>]*\bcontent=["']([\w-]+)["'][^>]*\bname=["']preview-template["']/i,
];

/** The template a page names; an unknown or missing name falls back to the default. */
function previewTemplateOf(html: string): string {
  for (const re of TEMPLATE_META_RES) {
    const name = re.exec(html)?.[1]?.toLowerCase();
    if (name && name in TEMPLATES) return name;
  }
  return DEFAULT_PREVIEW_TEMPLATE;
}

/** Head markup for `html`'s template, plus a viewport meta when the page has none. */
export function previewTemplateHead(html: string): string {
  const viewport = /<meta\s[^>]*\bname=["']viewport["']/i.test(html) ? "" : VIEWPORT_META;
  return `${viewport}${TEMPLATES[previewTemplateOf(html)]!.headHtml}`;
}
