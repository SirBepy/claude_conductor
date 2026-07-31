// Shared lit-html building blocks for the settings pages. Foundation module
// only - not yet wired into any page (later tasks migrate the existing pages
// to use these instead of their own copy-pasted markup).
import { html, type TemplateResult } from "lit-html";
import { escapeHtml } from "../../shared/escape-html";

export { escapeHtml };

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function globalNav(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

// ── Header ──────────────────────────────────────────────────────────────────

export interface SettingsHeaderOpts {
  /** Root-level pages show a burger (opens the side menu) instead of a back arrow. */
  burger?: boolean;
  /** Route name the back arrow navigates to. Defaults to "settings". Ignored when burger is true. */
  backTo?: string;
}

/**
 * The standard `.view-header`: title plus either a burger icon-btn (root pages;
 * caller wires its onclick, e.g. `root.querySelector('[data-burger="true"]').onclick = () => openSidemenu()`)
 * or a back icon-btn (subviews) that navigates to `opts.backTo ?? "settings"`
 * itself via the global `navigateTo`. Keeps the `icon-btn` / `back-to-settings`
 * class names so the existing CSS applies unchanged.
 */
export function settingsHeader(title: string, opts?: SettingsHeaderOpts): TemplateResult {
  const backTo = opts?.backTo ?? "settings";
  const button = opts?.burger
    ? html`
      <button class="icon-btn burger" title="Menu" data-burger="true">
        <i class="ph ph-list"></i>
      </button>
    `
    : html`
      <button class="icon-btn back-to-settings" title="Back" @click=${() => void globalNav().navigateTo(backTo)}>
        <i class="ph ph-arrow-left"></i>
      </button>
    `;
  return html`
    <div class="view-header">
      ${button}
      <h2>${title}</h2>
      <div style="width:32px"></div>
    </div>
  `;
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** A tappable settings row that drills into another page, with a leading Phosphor icon. */
export function navRow(label: string, phIcon: string, onClick: () => void): TemplateResult {
  return html`
    <div class="kit-row kit-nav-row" @click=${onClick}>
      <i class="ph ${phIcon}"></i>
      <span class="kit-row-label">${label}</span>
      <span class="kit-nav-arrow">›</span>
    </div>
  `;
}

export interface ToggleRowOpts {
  label: string;
  inputId: string;
  checked: boolean;
  onChange?: (e: Event) => void;
  disabled?: boolean;
  /** Optional help text shown via the existing .info-wrap/.info-tooltip hover pattern (see src/styles/widgets.css). */
  tooltip?: string;
}

/**
 * A `kit-row` with a label and a `kit-toggle` checkbox. When `tooltip` is set,
 * the label gets an inline info icon reusing the `.info-wrap`/`.info-icon`/
 * `.info-tooltip` classes from src/styles/widgets.css. Those classes only
 * supply the box/positioning styling - the hover-position JS (see
 * `attachTooltips` in src/shared/row-tooltip.ts) still has to be wired by
 * the caller against the rendered root.
 */
export function toggleRow(opts: ToggleRowOpts): TemplateResult {
  const labelContent = opts.tooltip
    ? html`
      <span class="info-wrap">
        ${opts.label}
        <i class="ph ph-info info-icon"></i>
        <span class="info-tooltip">${opts.tooltip}</span>
      </span>
    `
    : opts.label;
  return html`
    <div class="kit-row">
      <span class="kit-row-label">${labelContent}</span>
      <label class="kit-toggle">
        <input
          type="checkbox"
          id=${opts.inputId}
          .checked=${opts.checked}
          ?disabled=${opts.disabled ?? false}
          @change=${opts.onChange ?? (() => {})}
        >
        <span class="kit-toggle-track"></span>
      </label>
    </div>
  `;
}

// ── String builders (innerHTML workaround) ──────────────────────────────────
// Production lit-html silently drops repeated/nested templates containing a
// <select> (confirmed via DOM probe - the list renders as a bare marker
// comment with zero rows). The native innerHTML parser handles <select>/
// <option> correctly, so call sites that render a <select> per repeated item
// (System data cards, Chat defaults preset rows, Notifications selects,
// Appearance color rows) build a plain string and assign it via `.innerHTML`
// instead of a lit `.map()`.

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectHtmlOpts {
  id?: string;
  className?: string;
  dataset?: Record<string, string>;
  options: SelectOption[];
  selected?: string;
}

/** Builds a `<select>` element as a plain HTML string for innerHTML injection. */
export function selectHtml(opts: SelectHtmlOpts): string {
  const idAttr = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const classAttr = opts.className ? ` class="${escapeHtml(opts.className)}"` : "";
  const datasetAttrs = opts.dataset
    ? Object.entries(opts.dataset)
      .map(([k, v]) => ` data-${escapeHtml(k)}="${escapeHtml(v)}"`)
      .join("")
    : "";
  const optionsHtml = opts.options
    .map((o) => {
      const sel = o.value === opts.selected ? " selected" : "";
      return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
    })
    .join("");
  return `<select${idAttr}${classAttr}${datasetAttrs}>${optionsHtml}</select>`;
}
