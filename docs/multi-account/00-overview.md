# Multi-account (Claude Conductor) - implementation plan: overview

This is the anchor doc for a full multi-account feature. Milestone docs `01`..`08` in this
folder expand each phase. A future session picks this up via `/pickup` and orchestrates the
build (see the `/next-ai-prompt` handoff produced at the end of planning).

Visual spec: `.for_bepy/multi-account-mockup.html` (open it). Every screen below is mocked there.

> **REVISED 2026-07-07.** The original plan's credential primitive (`claude setup-token` +
> per-process `CLAUDE_CODE_OAUTH_TOKEN` injection) was proven broken by live testing: setup-token
> tokens repeatedly bound to the wrong account regardless of which account authorized the OAuth
> screen (verified via claude.ai/settings/usage on both accounts). The only mechanism that binds
> correctly is interactive `/login` run inside an isolated `CLAUDE_CONFIG_DIR`. This revision
> rebuilds the plan on config-dir profiles. See memory `multi-account-config-dirs` for the
> empirical history.

## What we're building

Let the app drive more than one Claude account (e.g. Personal, Work, Fibo). Each account is
isolated for chat + usage, chats route to the right account per project, and the whole thing is
built so the wrong account never touches the wrong work. Along the way the Statistics screen is
absorbed into a customizable dashboard, and the tray gains a floating multi-account overlay.

The real value is not "add a second login", it is **routing + isolation + a glanceable
which-account signal**. Adding the login is the easy part.

## Locked decisions (do not re-litigate)

- **Credential primitive: per-account `CLAUDE_CONFIG_DIR` profile dirs.** Every app account owns
  an app-created dir `~/.claude-<slug>` holding its own `.credentials.json`, minted by an
  interactive `/login` run inside that dir. Chat spawns set `CLAUDE_CONFIG_DIR` to the account's
  dir. Claude Code refreshes the access token in place on invocation, but the refresh token
  itself has a fixed lifetime anchored at `/login` and is NOT extended by those refreshes - every
  profile needs a periodic interactive re-`/login` regardless of how actively it's used. Measured
  2026-08-07/08: `~/.claude-personal` was used daily for 461 consecutive shell snapshots yet its
  `refreshTokenExpiresAt` never moved and died on schedule; `~/.claude` refreshed its access token
  overnight while its `refreshTokenExpiresAt` stayed byte-identical across the refresh.
- **`claude setup-token` is banned.** Empirically binds tokens to the wrong account. Never use it,
  never suggest it.
- **Never copy or seed `.credentials.json` between dirs.** OAuth refresh tokens are single-use and
  rotate; two dirs sharing one token silently invalidate each other's login (symptom: endless
  re-login loop). Every profile gets its own fresh `/login`. The app reads credential files but
  NEVER writes, copies, caches, or restores them.
- **`~/.claude` is the terminal's dir - observed, never owned.** The app keeps reading it
  (transcripts, hook install, slash commands, terminal-identity display) but never spawns a chat
  against it, never treats it as an account, and never deletes it. Its logged-in identity is
  volatile (every terminal `/login` flips it), which is exactly why app accounts don't live there.
- **Profile dir contents: credentials only; everything else funnels to `~/.claude`.** App-created
  dirs junction `projects/`, `todos/`, `sessions/`, `skills/`, `commands/`, `plugins/`, `refs/`,
  `code-style/`, `snippets/` and symlink `CLAUDE.md`, `settings.json`, `settings.local.json` back
  to `~/.claude`. One brain, one transcript pool, one hook config - so the daemon's existing
  `~/.claude` readers keep working unchanged, and skills/memory edits apply to every account
  instantly. Only `.credentials.json` + per-run caches are real per-profile files.
- **Identity detection is built in.** After `/login`, `<config-dir>/.claude.json` ->
  `oauthAccount` `{emailAddress, organizationUuid, organizationName, organizationType,
  profileFetchedAt}`. The wizard reads it to display "logged in as X", dedups against existing
  accounts (same `org_uuid`/email = reject), and cross-checks the web-plane email so a mismatched
  cookie/CLI pairing is caught at onboarding, not on the billing dashboard weeks later. (Note: the
  default `~/.claude` profile's state file is `~/.claude.json` in the HOME dir, not inside the
  folder.)
- **Colour / pace config stays global** (one preference applied to every account's numbers + the
  overlay). Not per-account.
- **Tray icon content is user-chosen:** glyph (rings/bars usage), number (% badge), or nothing
  (plain logo). For glyph/number the user picks WHICH account (default = the default account);
  number defaults to the 5h window. The icon stays clickable in all modes (it toggles the overlay).
- **Overlay** is translucent (opacity is a Settings slider) and goes opaque on hover.
- **Number format everywhere:** `usage%/safepace%` (e.g. `42%/55%`), second number dimmed, no
  "safe" word, tooltip on hover. Current number coloured under (green) / over (red) pace. Reset
  time is NOT coloured for being soon.
- **Project binding** lives on the project (Automation subview) as `ProjectConfig.preferred_account_id`,
  and is also editable from the account (a reverse "projects using this account" list). No global
  "project defaults table".
- **New-chat account picker** lives inside the existing model/effort/character modal, collapsed to
  the pre-selected account; "change" reveals chips; changing offers "remember for this project".
- **Add-account** = connect first, then auto-fill name/icon from the returned org info; icon has a
  reroll that skips icons other accounts use. Subscription (Pro/Max/Team) required; API-key
  accounts refused.
- Delete dead/legacy settings while in here: `sync` (dead), and after a no-reader confirm
  `threshold_warn`/`threshold_crit` and `display_mode` (superseded).

## The two authentications (critical, do not conflate)

An "account" here has TWO independent logins:

1. **CLI credentials** - `.credentials.json` inside the account's `CLAUDE_CONFIG_DIR`, minted by
   an interactive `/login` (the wizard spawns a terminal for it; there is no headless login).
   This is what the chat daemon spawns `claude` with.
2. **Web sessionKey cookie** - what the usage scraper sends to claude.ai's private API
   (`GET /api/organizations` then `/organizations/{id}/usage`). Captured via the existing
   CDP browser login flow, one chrome profile dir per account.

Usage CANNOT be fetched with the CLI credentials (different auth); it needs the cookie. So "add
account" is two grants. Both are one-time per account, and the wizard verifies both grants belong
to the SAME account (email/org cross-check) before saving.

## Account model

`Account { id, label, colour, icon, config_dir, chrome_profile_dir, email, org_uuid,
subscription_tier, session_key_ref, created_at }`. No CLI-token field: CLI credentials live in
the profile dir and are owned by Claude Code itself. The sessionKey stays out of plaintext
settings (per-account keyed storage, never logged, never committed). Colour + icon are the
identity carried through every screen (the glanceable "which account").

There is no "default account is special" code path: `default_account_id` is just the fallback for
unbound projects and the tray. Add and remove are uniform for every account (remove = drop record
+ delete its profile dir + its chrome profile + its cookie).

The terminal (`~/.claude`) surfaces as an **observed identity**, not an account: the Sessions
screen labels terminal sessions with whoever `~/.claude.json` says is logged in, and the accounts
UI shows it read-only ("Terminal: currently tecnomon99@gmail.com"). It is not spawnable, not
removable, not in the registry.

## Architecture by subsystem (where each phase lands)

- **Identity/creds (01):** new accounts registry (typed Rust, in app-data). `auth::session` (single
  sessionKey file) -> per-account store. Add-account wizard orchestrates: create profile dir +
  junctions -> spawned-terminal `/login` -> read `oauthAccount` -> CDP cookie grab -> cross-check
  -> auto-fill (widen `scraping::client::OrgListEntry`, which today keeps only `uuid`).
- **Chat routing (02):** inject `.env("CLAUDE_CODE_OAUTH_TOKEN", ...)` is DEAD; instead inject
  `.env("CLAUDE_CONFIG_DIR", account.config_dir)` at the spawn sites (`daemon/lifecycle.rs`,
  `channels/spawn.rs`, `news/summarizer.rs`). Thread `account_id` through `StartSessionParams` +
  the session registry. Billing gate runs against the child's injected env.
- **Usage (03):** poll loop iterates accounts (one sessionKey each). `UsageSnapshot` gains an
  account id; `AppState.current_usage` and `auth_state` become per-account maps; `usage_snapshots`
  table + capacity model gain an account column.
- **Binding (04):** `ProjectConfig.preferred_account_id` (mirror how `automation` sits there;
  carry-forward in `dedupe_projects_by_path_key`). Automation-subview row + reverse account view +
  the modal picker + `defaultAccountId`.
- **Dashboard (05):** account-selector cards drive account-scoped widgets; global widgets ignore
  selection. Widget registry {id, render, scope: global|account, dataDeps} replaces the closed
  `pinnedCards` enum. Delete the Statistics view; its widgets become dashboard-addable.
- **Tray + overlay (06):** evolve `defaultDisplay`/`iconStyle` into glyph/number/nothing + which-
  account; new floating overlay component (all accounts, 5h+7d, safe pace, opacity + hover);
  `render_tray_now` + `IconSettings`/`TooltipSettings` go per-account.
- **Settings (07):** removals; extend `colorApplyTo` with `overlay`; account-management UI with the
  per-account identity surface (logged in as / tier / token expiry / drift warning); overlay
  opacity. NOTE the pace/colour logic exists TWICE and is hand-synced: `src/shared/formatters.ts`
  (dashboard/webview) and `src-tauri/src/tray/threshold.rs` (tray). Any colour/pace change touches
  both.
- **Notifications + polish (08):** `notifications.thresholdCrossed` template gains an account
  token; tests (daemon e2e + WebdriverIO); legacy single-login migration; README sync.

## Settings: remove / change / new (from the settings study)

- **Remove:** `sync` (+subfields, dead); `threshold_warn`/`threshold_crit` (Rust, legacy);
  `display_mode` (Rust, superseded by `extra.iconStyle`); `pinnedCards` in its stats-card-id form.
- **Change (single -> per-account):** `AppState.current_usage`, `auth::session`,
  `AppState.auth_state`, tray render path, `notifications.thresholdCrossed` context, single Log Out
  -> per-account manage, `colorApplyTo` gains `overlay`.
- **Keep global:** `colorMode`, `paceBand` (default 10), `paceColors`, `colorThresholds`.
- **New:** accounts registry; `defaultAccountId`; `ProjectConfig.preferred_account_id`; dashboard
  widget layout + per-widget scope; `overlayOpacity` + overlay enable/behaviour; tray content mode
  (glyph/number/nothing) + tray account.

## Cross-cutting risks

- The pace/colour logic is duplicated (formatters.ts + threshold.rs), hand-synced. Every colour
  touch is two edits. Consider a shared source later, do not silently drift.
- Single -> per-account state (`current_usage`, `auth_state`, sessionKey file) is the load-bearing
  Rust change; everything downstream depends on it.
- The junction recipe is Windows-first (junctions need no admin; file symlinks need Dev Mode or
  admin - the recipe must fall back to `cmd /c mklink` for files, which is what worked on Joe's
  machine). macOS/Linux use plain symlinks. If a link step fails, abort account creation cleanly
  (delete the half-made dir) rather than leaving a broken profile.
- `/login` cannot be automated: the wizard spawns a visible terminal with `CLAUDE_CONFIG_DIR` set
  and polls for `oauthAccount` to appear. Design the wizard step to survive the user dawdling or
  abandoning (timeout -> cancel cleans up the dir).
- An existing `~/.claude-fibo` (hand-built, same layout) exists on Joe's machine. Account creation
  must handle "dir already exists": offer to adopt it as this account's dir if its `oauthAccount`
  matches the freshly verified login, else require a different slug.
- Migration: the current single scraping login (`session.txt`) keeps working until the first
  account is added; usage history re-keys to a new account when its `org_uuid` matches the legacy
  scrape target (03/08 own the details).
- New pure-frontend settings can ride in `Settings.extra` (untyped passthrough); anything Rust
  consumes (accounts, per-account usage, auth) needs typed Rust + `export_types.rs` regen.

## Success criteria

- Two accounts run concurrent chats, each spawned under its own `CLAUDE_CONFIG_DIR`, each billed to
  its own subscription (verified on both claude.ai/settings/usage dashboards), with zero
  credential-file interaction between profiles.
- Plain-terminal `claude` work is completely unaffected by anything the app does.
- New chat in a bound project auto-selects that account; changing it can be remembered.
- The accounts UI shows, per account: logged in as (email), tier, token expiry, and a red drift
  warning if the profile's `oauthAccount` no longer matches the registry record.
- Dashboard shows every account; clicking a card re-scopes the account-tied widgets; safe pace
  shows for 5h + 7d in both the dashboard and the overlay.
- Overlay lists all accounts (5h+7d, safe pace), translucent + opaque on hover.
- Tray icon honours glyph/number/nothing + the chosen account, and still opens the overlay.
- No metered billing possible (subscription-only gate holds per account, checked against the
  injected child env).
- Statistics screen removed with no lost widgets (migrated to dashboard).

## References

- Design mockup: `.for_bepy/multi-account-mockup.html`
- Empirical history of the auth saga: project memory `multi-account-config-dirs`
- Hand-built prototype of the profile layout: `~/.claude-fibo` (junction recipe reference)
- Related todo: `.for_bepy/ai_todos/138-html-preview-window.md` (previews in a sidepane; brainstorm
  mockups should target it instead of an external browser).
