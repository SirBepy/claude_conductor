# Product

<!-- impeccable:product-schema 1 -->

<!-- Written unattended (no interview): derived from README.md, CLAUDE.md, and
     the src/ tree. Every claim not stated verbatim in project docs is marked
     (assumed) so the dev can correct it cheaply. -->

## Platform

web

<!-- (assumed) "web" is the closest fit for init.md's four-value schema, not a
     literal repo claim. The real surface is a vanilla TS/lit-html SPA (HTML/CSS,
     no native UI toolkit) rendered inside a Tauri 2 desktop webview shell
     (Windows + Apple Silicon macOS releases; Intel macOS and Linux paused,
     build-from-source). The Android app (android/) is a thin native wrapper
     that stores a server URL and renders the SAME desktop-served SPA over the
     network - it has no separate design language, so this is not "adaptive". -->

## Users

The primary user is the app's own developer/maintainer, running Claude Code across
multiple projects on their own machine(s) and wanting one cockpit for it (assumed:
inferred from a solo MIT copyright holder, GitHub-Releases-only distribution, and
CLAUDE.md's dev-facing tone - no in-repo marketing copy, onboarding funnel, or
multi-tenant concept exists). By extension, any developer who runs Claude Code
locally and wants usage visibility plus a persistent chat hub is a fit (assumed).

Job: keep Claude Code sessions running and visible without babysitting a terminal -
know how close each account is to its usage limit, keep long-running sessions alive
across app restarts, resolve their permission prompts, and drive/monitor them from
a phone when away from the desk.

## Product Purpose

Claude Conductor is a companion cockpit for Claude Code (README.md:1-15,
src-tauri/tauri.conf.json's `shortDescription`/`longDescription`). It exists to
solve problems that a bare `claude` terminal session doesn't:

- Usage limits are opaque until you hit them - the app polls the claude.ai usage
  API (cookie auth, one-time Chrome login) and surfaces 5h/weekly windows live in
  the tray, dashboard, and a floating overlay.
- Terminal `claude` sessions die when the terminal or app closes - the daemon hosts
  each session as a persistent background process so it survives app/window close
  and can be reattached to.
- Multiple concurrent sessions across projects are hard to track by hand - the app
  gives one chat hub, channel automation, scheduling, and history across all of them.
- Being away from the desk shouldn't mean losing the ability to answer a permission
  prompt or start a chat - phone pairing and multi-machine pairing extend the same
  cockpit off the desktop.

Success (assumed, not stated as a metric in the repo): sessions the dev cares about
keep running unattended, usage limits are never a surprise, and permission prompts
never block a session for longer than it takes to glance at a phone.

## Positioning

A neighboring product could copy "shows Claude usage" or "runs a chat UI over
Claude Code" individually - several already exist as one or the other. What this
app does differently, evidenced by the code itself:

- It combines usage monitoring, a persistent multi-session chat daemon, scheduling,
  channel automation, and cross-device (phone + peer-machine) control of the SAME
  Claude Code sessions in one tray-first app, not a web dashboard or a CLI wrapper.
- Sessions are daemon-hosted, not app-hosted: closing the window/app does not kill
  a running Claude process (README.md:6, CLAUDE.md's daemon/machines module map).
- Multi-machine federation lets one chat list show sessions running on a different
  paired computer as if local (README.md:136-174) - not just remote-viewing, but
  spawning and messaging cross-machine sessions via MCP tools.

## Operating Context

- Runs as a background tray app most of the time; the main window is opened on
  demand (tray-first, per CLAUDE.md's app description).
- Talks to `claude.ai`'s usage API over cookie-authenticated HTTPS; a Chrome/CDP
  browser is only launched for the one-time interactive login that captures the
  session cookie, never during normal polling.
- Hosts real `claude` CLI processes per session via a local daemon; permission
  prompts from those processes are relayed into the app's UI (hooks/MCP relay).
- Reads/writes the user's real `~/.claude/` tree for session history, settings,
  and hook registration (with explicit user consent for the hook, per the
  first-run modal in src/index.html) - chats run under the app's own per-account
  profile folders, never the terminal's own `~/.claude` (README.md:88).
- Cross-device operation: a paired phone (QR/Tailscale) gets a remote-control web
  UI; a paired desktop/laptop machine mirrors the other's chat list and can spawn
  or message sessions on it (README.md's Android companion + Multi-machine
  sections).
- Distribution is GitHub Releases only (NSIS installer on Windows, DMG on Apple
  Silicon macOS); Intel macOS and Linux (DEB/AppImage) build from source only,
  paused in CI as of 2026-08-12 (README.md:14,26-64).

## Capabilities and Constraints

Confirmed capabilities (README.md, CLAUDE.md):

- Usage monitoring (5h + 7-day windows), multi-account, side-by-side.
- Sessions / chat hub: persistent daemon-hosted `claude` sessions, streamed as
  rendered chat (markdown, syntax highlighting, clipboard image paste), poppable
  into their own window.
- Sleep/shutdown-when-done, with auto-resolve of blocked prompts so the machine
  doesn't hang waiting on a human.
- Scheduling: one-shot and recurring (daily/weekly/every-N-days) messages or new
  chats, fired by the daemon even with the app closed; missed-item grace window
  with popup fallback.
- History: read-only browser of past sessions from `~/.claude/sessions/`.
- Channel management for headless Claude Code automation (`--remote-control`);
  manual takeover of a `claude` process already running in a terminal.
- Voice dictation via a local Python `faster-whisper` sidecar.
- Skills and Characters management (src/views/skills, src/views/skill-detail,
  src/views/characters, src/views/characters/character-detail.ts) alongside
  Projects (+ automation/folder-mapping/sessions-list/character-pick subviews).
- Android companion (thin remote-control shell, no local Claude Code execution)
  and multi-machine peer pairing.

Confirmed constraints:

- Chat hub is subscription-only: refuses to spawn if any metered-billing env var
  (API key, Bedrock, Vertex) is set (CLAUDE.md).
- Channel automation (Plan C) is unavailable on Linux (`SpawnError::NonWindows`).
- Voice dictation is source-checkout-only today; not bundled into the installer
  (README.md:12, CLAUDE.md's STT sidecar note, todo 521).
- The app is unsigned on macOS (no Apple Developer ID) - first launch needs the
  Gatekeeper right-click-Open workaround (README.md:39).
- Windows and Apple Silicon macOS are the only currently-released platforms;
  everything else is a from-source build (README.md:14).

Undecided/not established in the repo: no stated pricing, licensing-for-users
model beyond MIT source, or growth/distribution strategy beyond GitHub Releases.

## Brand Commitments

- Name: "Claude Conductor" (product name throughout README.md, CLAUDE.md,
  src-tauri/tauri.conf.json's `productName`). Repo/binary identifier uses
  "claude_conductor" / "claude-conductor".
- Publisher: SirBepy (src-tauri/tauri.conf.json's `publisher`, LICENSE copyright).
- No stated logo, tagline, or voice guide beyond the functional descriptions in
  README.md and the bundle's `shortDescription`/`longDescription` strings quoted
  under Product Purpose above.

## Evidence on Hand

- README.md and CLAUDE.md are the only product documentation in the repo; there
  is no marketing site, pitch deck, case study, or user testimonial to draw from.
  Future design work must not fabricate testimonials, customer logos, pricing
  tiers, or usage benchmarks - none exist today.
- `assets/icon/` holds the real app icon pipeline (regenerated via
  `scripts/regen-android-icon.ps1`); no other brand asset library exists.
- `docs/` and `.for_bepy/` hold internal/dev-facing notes, not user-facing
  evidence or proof assets.

## Product Principles

1. Sessions outlive the UI. The daemon, not the window, owns a running `claude`
   process - closing the app or the window is never allowed to kill work in
   progress (README.md:6; daemon-hosted session architecture throughout CLAUDE.md).
2. Never make the human the failure mode. Auto-resolve blocked prompts before
   sleeping/shutting down; grace windows and popups catch missed schedule items
   instead of silently dropping them (README.md:7-8).
3. One account's data, one account's problem. Multi-account and multi-machine
   isolation is structural (separate profile folders, `ctx.transport`-derived
   identity, no mirroring chains past one hop), not a UI-level filter
   (CLAUDE.md's machine-federation and multi-account rules).
4. Cross-device is an extension of the same cockpit, not a separate product. Phone
   and peer-machine access reach the same sessions/settings a desktop user has,
   never a reduced or divergent feature set by design intent (README.md's Android
   companion + Multi-machine sections).
5. Ship what's real. The repo documents paused platforms, source-checkout-only
   dictation, and Linux automation gaps explicitly rather than glossing over them
   (README.md's Paused section, CLAUDE.md's STT sidecar note) - (assumed as a
   principle, generalized from these specific documented gaps).

## Accessibility & Inclusion

No product-specific accessibility requirement is stated in the repo. Observed
(not principle-level) accessibility work exists in the implementation - AA-safe
muted-text contrast fix (src/styles/base.css's `--sb-muted`), ARIA/keyboard
support on kebab menus (src/shared/kebab-menu.ts), `prefers-reduced-motion`
handling (src/styles/motion.css) - see DESIGN.md for specifics; this section is
left without an inclusion mandate because none was confirmed as a product
requirement (assumed: standard web accessibility hygiene, not a stated target
like WCAG AA/AAA compliance).
