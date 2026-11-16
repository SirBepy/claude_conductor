# Release shape and CI-owned version

Read before touching `.github/workflows/`, `tauri.conf.json`'s version, or recovering from a failed release.

`src-tauri/tauri.conf.json`'s committed `version` is intentionally stale locally, CI-owned: the "Sync version" step in `.github/workflows/desktop-build.yml` jq-rewrites it (and Cargo.toml, package.json) to the real version before every release build, and also sets the CI copy's `beforeBuildCommand` to `npm run build --ignore-scripts` so the release skips the npm `prebuild` hook (a ~10 min debug cargo compile that only writes `ipc.generated.ts`, which the bundle does not read).

**Release shape: Windows publishes first.** `tauri-release.yml` builds Windows and macOS as separate calls of `desktop-build.yml`. `tag` and `publish-windows` wait on the Windows build and `test` only; `publish-macos` adds the macOS assets and its `latest.json` entry afterwards, and `upload-android` attaches the APK. Until `publish-macos` lands, `latest.json` has no `darwin-aarch64` entry and a Mac client's update check ERRORS (tauri-plugin-updater `TargetsNotFound`), it does not report "no update". If macOS fails after Windows shipped, rerun with `gh run rerun <run-id> --failed` within 30 days of the run (GitHub's rerun limit; the artifacts last 90 days but an older run cannot be rerun; the rerun semantics for reusable-workflow jobs are unconfirmed until the first real red macOS run, so check what it reran), never a full rerun or a same-version push: `check` skips once the tag exists, so everything is skipped and macOS never publishes. A code fix for macOS needs a version bump, and until one ships every Mac client keeps getting that update-check error (an "On startup" Mac user only rechecks on launch or Retry). `auto-fix-release.yml` only acts on failures before the tag exists (`check`, `build-windows`, `tag`) for the same reason. `publish-macos` and `upload-android` add assets to an already-published release, so GitHub's "immutable releases" setting must stay off (it is off now).

## What's new (the visual changelog on the empty session screen)

Read before editing `src/changelog/`, `src/views/sessions/whats-new/`, the "Updated to vX" toast (`src/shared/update-toast.ts`), or when writing a release's entry. Each release that changes something Joe can see gets a hand-written entry, committed BEFORE the `VERSION:` bump commit; a release with no entry is simply not announced.

### What Joe sees

The pane that says "Select or create a session" also carries a **What's new** button. Pressed, it opens an inline panel under the line: a grid of cards, each a real screenshot with a Phosphor icon, a title of a few words and ONE caption line. Version pills switch to earlier releases, Close puts the panel away. On the **first launch after an update** the panel is already open, once; the next launch shows the button again.

### Where the content comes from (decided 2026-11-16, todo pc-1739)

A **committed data file**, `src/changelog/entries.ts`: one entry per release, newest first, pictures in `src/changelog/img/<version>/` imported as vite assets (so they ship inside `dist/`, and the daemon-served page has them too). Nothing is generated in CI and nothing is fetched at runtime: a changelog that needs the network is blank offline, and a CI-written one would make `/release` depend on a screenshot rig.

The entry is **written by hand at release time, from `git log`**:

1. `git log --format='%h %s' tauri-v<previous>..HEAD` and keep only what Joe can see or feel in the UI. Commit subjects start `FEAT:` or `FIX:`; backend, daemon, refactor, test, docs and guard work is never an item.
2. One item per change, not per commit. Two to four items per release is plenty; a release with no visible change gets no entry (and so no auto-open).
3. Title: a few words in the words Joe would say. Caption: one short line. No jargon, no ids, no em dash.
4. Picture: a screenshot of the REAL UI through the view harness, never a mockup. Add a case to `e2e/view-harness/changelog-assets.view.spec.ts` that mounts the surface and calls `shoot(...)` (it crops to the cards' 16:10 ratio), then run it:

   ```powershell
   $env:CC_CHANGELOG_SHOTS=1; $env:VIEW_HARNESS_PORT=4437; pnpm exec playwright test changelog-assets --workers=1
   ```

   It writes straight into `src/changelog/img/<version>/`. Hide the app behind the surface with the `body { visibility: hidden }` trick the existing cases use, so the picture is only the thing the caption is about.
5. Add the entry at the TOP of `ENTRIES`, with `version` equal to the version being shipped (no "v"), and commit the PNGs with it.

The release step: `/release` bumps the version in its own commit, so the entry goes in the commit BEFORE that bump (the feature commits' own commit, or a `DOCS:`/`FEAT:` commit right ahead of it).

### When the panel opens by itself

`setupUpdateToast` already compares the stored `lastSeenAppVersion` with the running version for the "Updated to vX" toast. When they differ it also calls `markUpdatedTo(running)`, which stores `whatsNewPendingVersion` (localStorage; the behaviour it preserves: a launch that never reached the empty screen still shows the panel on the next draw, across restarts) and fires `whats-new-pending` so an empty screen that already drew opens.

- The panel opens only when the pending version **equals the newest entry's version**. An update to a version with no entry opens nothing (never a panel about some other version); the button still works.
- Drawing the panel open spends the flag (`clearPending`).
- A **fresh install** (nothing stored) records the version and marks nothing, so nobody sees "what changed" for a version they never had.
- The "Updated to vX" toast stays: it appears on every surface, the panel only on the empty one.
- Per machine, not synced: the stored version is the machine's own.

### Phone

The phone-served page imports the same module, so a surface that draws the empty state gets the button. But at phone width the empty pane sits off-screen behind the chats list until a chat is raised, so the phone does not show this screen in practice, and its toast and auto-open are skipped (`setupUpdateToast` returns on `isRemote()`: the version there is the PC's). A narrow desktop window does show it, one card per row (`whats-new.view.spec.ts` covers that).

### Where it lives

- `src/changelog/entries.ts`, `src/changelog/img/`: the content.
- `src/views/sessions/whats-new/whats-new-state.ts`: the pending flag.
- `src/views/sessions/whats-new/whats-new.ts` and `.css`: the block. `paneEmptyStateHtml` (`sessions-helpers.ts`) embeds it; the click listener is installed on import, once, on `document`, because the pane's markup is replaced whole on every daemon-state change (the open/closed state is module state for the same reason).
- Tests: `tests/whats-new.test.mjs`, `e2e/view-harness/whats-new.view.spec.ts` (screenshots with `CC_SHOTS=1`), `e2e/view-harness/changelog-assets.view.spec.ts` (regenerates the pictures).
