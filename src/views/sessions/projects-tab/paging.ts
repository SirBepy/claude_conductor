// Card paging. Long lists show one page at a time behind a small caret pager in
// the card header, never an "N more" row. The page lives in the dashboard
// context so a repaint (every live event) keeps the reader where they were.
import { html, nothing, type TemplateResult } from "lit-html";
import type { DashCtx } from "./dash-parts";

export const PAGE_ROWS = 4;

export interface Paged<T> {
  slice: T[];
  /** Nothing when everything fits on one page. */
  pager: TemplateResult | typeof nothing;
}

export function pageSlice<T>(c: DashCtx, key: string, items: T[], size: number = PAGE_ROWS): Paged<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  // A narrower repo filter or a finished chat can leave the stored page past the end.
  const page = Math.min(c.pages.get(key) ?? 0, pages - 1);
  const slice = items.slice(page * size, page * size + size);
  if (pages === 1) return { slice, pager: nothing };
  const pager = html`<span class="pd-pager" data-pd-pager=${key}>
    <button type="button" class="pd-pg" title="Previous" ?disabled=${page === 0}
      @click=${() => c.act.setPage(key, page - 1)}><i class="ph ph-caret-left"></i></button>
    <span class="pd-pg-n">${page + 1}/${pages}</span>
    <button type="button" class="pd-pg" title="Next" ?disabled=${page === pages - 1}
      @click=${() => c.act.setPage(key, page + 1)}><i class="ph ph-caret-right"></i></button>
  </span>`;
  return { slice, pager };
}
