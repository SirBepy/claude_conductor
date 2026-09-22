---
name: Claude Conductor
description: Companion cockpit for Claude Code - usage, live sessions, and remote control
colors:
  primary: "#9d7dfc"
  secondary: "#6e8fff"
  background: "#16151f"
  surface: "#1e1d2b"
  surface-alt: "#242334"
  text: "#e2e0f0"
  text-muted: "#6b6990"
  border: "#2d2c44"
  success: "#7af0c0"
  danger: "#e05252"
  info: "#6e8fff"
typography:
  display:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    letterSpacing: "-0.01em"
  title:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.08em"
rounded:
  badge: "6px"
  card: "10px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    rounded: "8px"
    padding: "7px 16px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "8px"
    padding: "7px 16px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "0.65rem 1rem"
---

# Design System: Claude Conductor

## Overview

**Creative North Star: "The Cockpit Console"** (assumed - a synthesized metaphor,
not confirmed with the dev; the description below is grounded in observed code,
the name itself is a label for it)

A dark-first, information-dense control surface: flat cards on a near-black
ground, one saturated accent used sparingly for state (active nav, focus, live
data), and a monospace register reserved for anything that is literally a
number or a path. Density favors more visible state over generous whitespace -
stat cards, tables, and rings all pack multiple data points into a small
footprint, consistent with a tool built for someone who checks it often rather
than a landing page meant to be read once.

The app ships four selectable theme palettes (Void, Nebula, Glacier, Cosmo,
each with a dark and light mode - src/views/settings/subviews/appearance/
appearance.ts:24-27) built on the same structural system documented here. Void
dark is the shipped default (src/index.html:2, `html[data-theme="void"]
[data-mode="dark"]`) and is what this document treats as canonical; the other
three swap the accent hue, a couple of font families, and card radius, but
share every layout, motion, and component rule below.

**Key Characteristics:**
- Flat surfaces, ambient (not directional) drop shadows for elevation.
- One accent color per theme, used for primary actions, active/hover states,
  and focus rings - never as a large fill.
- Numbers and paths render in Fira Code; everything else in DM Sans (body) or
  Manrope (headings).
- Every view shares one header shape: burger-or-back, centered `h2`,
  kebab-or-spacer.

## Colors

Each theme defines one accent plus a dark/light neutral pair; there is no
secondary or tertiary accent role in the current system - only Primary and
Neutral are populated, so Secondary/Tertiary are omitted below rather than
invented.

### Primary
- **Void Violet** (`#9d7dfc` dark / `#7c5ce7` light,
  `vendor/tauri_kit/frontend/styleguide/themes/theme-void.css:3,27`): the sole
  accent - primary buttons, active nav/tab state, focus rings, hover borders on
  cards, and the "live" pulse glow on the usage ring when a limit is near.

### Neutral
- **Void Ink** (`#16151f` dark / `#f0eff6` light, background): page background,
  and the inner "hole" of ring/donut components.
- **Void Panel** (`#1e1d2b` dark / `#f8f7fc` light, surface): card, section,
  modal, and table backgrounds.
- **Void Panel Raised** (`#242334` dark / `#eeecf5` light, surface-alt):
  hovered rows, input fields, ring track background.
- **Void Text** (`#e2e0f0` dark / `#1a1830` light): primary text.
- **Void Text Muted** (`#6b6990` dark / `#7876a0` light, `--color-text-muted`):
  secondary text and icons - see the Named Rule below, this value is never used
  directly for small text.
- **Void Border** (`#2d2c44` dark / `#d8d6ea` light): all hairline dividers,
  card borders, and table row separators.

### Status
- **Success** `#7af0c0` dark / `#2db87a` light, **Danger** `#e05252` dark /
  `#d43f3f` light, **Info** `#6e8fff` dark / `#5a75e0` light (same hue as
  Secondary in every theme) - used for tags (`.card-tag.live/.remote`), the
  danger button variant, and the usage-ring "hot" pulse
  (`src/views/dashboard/dashboard.css:126-130` uses a hardcoded `#e05252` glow
  rather than the `--color-danger` token - a drift worth reconciling, not a
  deliberate second red).

### Named Rules
**The Muted-Text Floor Rule.** `--color-text-muted` alone measures 3.53:1 on a
chip background in every theme, under the 4.5:1 AA floor for body-size text.
`src/styles/base.css:1-4` derives `--sb-muted` as
`color-mix(in srgb, var(--color-text-muted) 62%, var(--color-text))` and that
token, not the raw muted color, is what small/secondary text should use.

**The One-Accent Rule.** Every theme has exactly one accent hue (`--color-accent`
== `--color-primary` in all four theme files). Secondary and Info reuse a
near-identical blue-violet rather than introducing a second distinct hue -
there is no established multi-accent vocabulary to extend.

## Typography

**Heading Font:** Manrope (with system-ui fallback)
**Body Font:** DM Sans (with system-ui fallback)
**Mono Font:** Fira Code

Only these three families are loaded by the app itself
(`src/index.html:41`'s Google Fonts link: DM Sans 300-600, Manrope 400-700,
Fira Code 400-500). The Nebula/Glacier/Cosmo theme files declare additional
`--font-heading`/`--font-body` values (Fredoka, Inter, Plus Jakarta Sans,
Bricolage Grotesque - `theme-nebula.css:16-17`, `theme-glacier.css:16-17`,
`theme-cosmo.css:16-17`) that have no matching `<link>` anywhere in the repo;
on a machine without those fonts already installed, those three themes render
in the browser's `system-ui` fallback instead of the named font. Treat this as
a known gap, not an intentional per-theme font swap.

**Character:** Confident and technical rather than editorial - Manrope's
geometric, slightly condensed headings pair with DM Sans's plainer body text,
and Fira Code marks anything that is data rather than prose.

### Hierarchy
- **Display** (700, 1.375rem `--fs-display`, line-height 1): big standalone
  numbers - empty-state icons' sibling text, sync link codes, stat-card values.
- **Headline** (600, 1.0625rem `--fs-heading`, letter-spacing -0.01em): the
  centered `h2` in every view's shared header (`src/styles/base.css:70-78`).
- **Title** (600, 0.875rem `--fs-title`): row/option labels, nav-row labels,
  section headings inside a card.
- **Body** (400, 0.8125rem `--fs-body`): default running text, form labels,
  table cells.
- **Label** (700, 0.72rem `--fs-micro`, letter-spacing 0.08-0.1em, uppercase):
  `.section-title`, `.stat-label`, table column headers - always uppercase and
  tracked wide, never used for anything a user reads at length.

### Named Rules
**The Data-Is-Mono Rule.** Any value that is a number-with-units, a token
count, a timestamp, a file path, or a code preview renders in Fira Code
(`.stats-table .mono`, `.session-table .col-when/.col-tokens/.col-name`,
`.dash-ring` percentages via `font-variant-numeric: tabular-nums` rather than a
font swap, `.modal-preview`). Prose never does.

## Layout

There is no formalized spacing scale (no `--spacing-*` custom property exists
anywhere in `src/styles/` or the vendored theme files); spacing is ad hoc pixel
values clustered around 4/6/8/10/12/14/16px, chosen per component rather than
drawn from a shared scale. Treat 8px and 16px as the de facto base unit and
half-step when adding new components, since they recur the most
(`.view-body { padding: 16px }`, `.section { padding: 16px }`,
`.icon-btn { padding: 4px 6px }`).

Views fill the entire window - there is no centered max-width container
(`src/styles/base.css:157-165`'s comment notes this was a deliberate removal:
"the user explicitly removed the previous max-width cap so layouts can breathe
at any window size"). Each view is a full-height flex column: a fixed
`.view-header`, then a scrolling `.view-body`. Density is desktop-first; the
one responsive breakpoint in the shared layer is `@media (max-width: 768px)`,
which enlarges `.icon-btn` to a 44px touch target (`base.css:130-138`) and adds
safe-area insets for notches/home indicators on mobile/PWA contexts
(`base.css:58-66`, `widgets.css:794-801`).

## Elevation & Depth

Flat by default, with a soft ambient drop shadow (never a hard/directional one)
as the only elevation cue: every raised surface uses a large-blur,
low-opacity black shadow rather than a shadow scale with multiple named steps.
`--shadow-card` is themed (`0 4px 16px rgba(0,0,0,.35)` in Void dark,
`0 4px 24px rgba(0,0,0,.55)` in Nebula, scaling with how saturated/dark each
theme is), but most components in `src/styles/widgets.css` hardcode their own
`box-shadow: 0 4px 16px rgba(0,0,0,.35)` rather than referencing the token,
so the two can drift per-component (see the ring "hot" glow drift noted under
Colors).

### Shadow Vocabulary
- **Card ambient** (`box-shadow: 0 4px 16px rgba(0,0,0,0.35)` dark / lighter
  tinted version in light mode): stat cards, sections, chart containers, the
  hook-registration modal body.
- **Toast/modal lift** (`0 8px 24px rgba(0,0,0,0.4)` toast, `0 20px 60px
  rgba(0,0,0,0.4)` modal): reserved for content that floats above the view,
  scaling blur/spread with how far above the surface it sits.
- **Input inset** (`inset 0 3px 10px rgba(0,0,0,0.5)` plus two thin inset
  highlight lines): every `input`/`select` uses an inset shadow instead of a
  border-only treatment to read as a recessed well, brightening to a
  primary-tinted glow ring on focus (`widgets.css:387-409`).

### Named Rules
**The Ambient-Only Rule.** No shadow in the system is directional (no
top/bottom-heavy offset beyond a flat 4px). Elevation reads as "this surface is
raised slightly", never "light is coming from one side" - consistent with the
flat, technical character described in Overview.

## Shapes

Corner radius scales with what a shape represents: circular for anything that
plots a ratio (`.dash-ring`, `.legend-dot`, `.pin-btn`'s icon slot is square but
its parent avatar is not), pill/34px radius for toggles (`.slider`), and a
tight 6-10px range for everything rectangular - cards, buttons, inputs,
avatars. The 10px `--radius-card` token exists per-theme (6px badge / 10px card
in Void and Glacier, up to 14px card in Nebula, 8px badge in Cosmo), but most
of `src/styles/widgets.css` hardcodes its own radius (7px project-card avatar,
6px sidemenu items, 8px generic button, 10px sections/inputs/modals) rather
than referencing `var(--radius-card)` - so the per-theme radius token currently
only actually varies motion.css's `.v-skeleton` fallback and a handful of
theme-aware components, not the bulk of the chrome. No hard borders/clipping
beyond the 1px hairline `--color-border` - shapes are never outlined in the
accent color except on hover/focus.

## Components

### Buttons
- **Shape:** 8px radius (hardcoded in the base `button {}` rule, not the
  per-theme `--radius-card`/`--radius-badge` tokens).
- **Primary:** `--color-primary` background, `--color-background` text (the
  page background color doubles as button text so it stays legible against the
  light accent in every theme), 7px 16px padding.
- **Hover / Focus:** `filter: brightness(1.1)` plus a 1px upward
  `translateY(-1px)` on hover; a themed glow ring
  (`0 0 0 3px rgba(157,125,252,.15)`) on input-style focus states.
- **Secondary:** transparent background, muted text, 1px border; hover swaps
  both to the accent color rather than filling the background.
- **Danger:** transparent background, `--color-danger` text and a
  40%-alpha danger border; hover adds a 10%-alpha danger fill. Always full
  width in its observed uses (destructive confirmation rows).

### Cards / Containers
- **Corner Style:** 10px (sections, stat cards, chart containers), 7px
  (project-card, its avatar).
- **Background:** `--color-surface`.
- **Shadow Strategy:** ambient card shadow (see Elevation & Depth); no border
  by default except `.project-card`, which adds a 1px `--color-border` edge
  that turns accent-colored on hover (`.v-card`/`.project-card:hover` in
  `motion.css`/`widgets.css`).
- **Internal Padding:** 16px (section), 14px 16px (stat-card), 12px 12px 8px
  (chart-container).

### Inputs / Fields
- **Style:** `--color-surface-alt` background, 10px radius (8px for
  `<select>`), inset shadow well described above, no visible border color
  distinct from the well until focus.
- **Focus:** border flips to `--color-primary` and the inset well gains an
  outer primary-tinted glow ring - no layout shift.
- **Disabled:** `.icon-btn-sq:disabled` and `.option.is-disabled` both drop to
  `opacity: 0.35-0.5` plus `pointer-events: none`; no separate disabled color.

### Navigation
- **Sidemenu** (`.sidemenu`, `src/styles/widgets.css:768-838`): a fixed
  220px-wide overlay drawer (not a persistent rail), slides in via
  `transform: translateX`, one Phosphor icon + label per row, active/hover both
  read as a lightly-tinted `--color-surface-alt` background rather than an
  accent-colored state.
- **View header** (`.view-header`, `base.css:58-78`): every view - Dashboard,
  Projects (+ project-detail subviews), Skills (+ skill-detail), Characters
  (+ character-detail), Settings (+ its many subviews) - shares one shape:
  burger-or-back icon button, centered `h2` title, kebab-or-spacer on the
  right. Confirmed present in at least the settings and legacy graph-detail
  views (`src/index.html:96-100,169-174`) and referenced as the shared
  contract in `base.css`'s `.view-header` rule.
- **Kebab menus** (`src/shared/kebab-menu.ts`): shared toggle + outside-click +
  Escape + Arrow-key wiring used by project-detail, session-detail, and
  characters (per the file's own header comment); stamps `aria-haspopup`,
  `aria-expanded`, and `role="menu"`/`"menuitem"` itself rather than requiring
  each caller to repeat that boilerplate.

### Empty States
- **Style:** `.v-empty` (`src/styles/motion.css:87-110`) - centered icon
  (2rem, muted, 0.7 opacity), a title line (`--fs-heading`, 600), and a hint
  line (`--fs-body`, muted). Used in at least 12 view files across the app
  (grep count over `src/views`), making it the one confirmed shared empty-state
  idiom rather than a per-view improvisation.

### Signature Component: Usage Ring
`src/views/dashboard/dashboard.css:104-140`. A donut-shaped ratio indicator
(84px outer circle in `--color-surface-alt`, a 66px inner "hole" in
`--color-surface` cut via `inset: 9px`, so the visible ring is the 9px gap
between them) showing 5h/weekly usage as a filled arc plus a tabular-nums
percentage and time-remaining readout inside the hole. Near a limit it gains a
`dashRingPulse` animation - a 1s ease-in-out `drop-shadow` pulse currently
hardcoded to `#e05252` rather than `var(--color-danger)` (see the Colors
section's drift note). Time readouts step through muted -> amber
(`.dash-ring-time-near`, `#e6a23c`) -> red (`.dash-ring-time-hot`, `#e05252`)
as urgency increases, both also hardcoded rather than theme-token-driven.

## Do's and Don'ts

### Do:
- **Do** use `--sb-muted` (not raw `--color-text-muted`) for any small or
  secondary text - it's the only one of the two that clears the AA contrast
  floor (`src/styles/base.css:1-4`).
- **Do** reuse `.v-empty` for a new empty state instead of hand-rolling icon +
  title + hint markup - it is already the shared idiom across 12+ views.
- **Do** route new kebab/overflow menus through `src/shared/kebab-menu.ts`
  rather than re-wiring click/Escape/arrow-key handling per view.
- **Do** keep new shadows ambient (large blur, low opacity, no strong
  directional offset) to match the Ambient-Only Rule.

### Don't:
- **Don't** hardcode `#e05252`/`#e6a23c` for danger/warning state color - use
  `var(--color-danger)` and a warning token so the color still swaps correctly
  across the four themes and light/dark modes (see the two drift notes above:
  `dashboard.css`'s ring pulse and `dash-ring-time-near/-hot`).
- **Don't** assume Nebula/Glacier/Cosmo's declared heading/body fonts
  (Fredoka, Inter, Plus Jakarta Sans, Bricolage Grotesque) are actually
  rendering as named - none are loaded by `src/index.html`, so they silently
  fall back to `system-ui` today.
- **Don't** extend the chat/Sessions surface (`src/views/sessions/`, by far the
  largest and most actively developed view folder) as a model for new views'
  visual patterns without checking first - it intentionally lags the rest of
  this system and was out of scope for the 2026-09 view-header/empty-state/
  motion-utility revamp that the rest of this document describes.
- **Don't** introduce a second accent hue. Every theme's `--color-accent`
  equals its `--color-primary`; there is no established multi-accent pattern
  to extend (the One-Accent Rule).
