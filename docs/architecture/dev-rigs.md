# Dev daemons, verification rigs and harness scripts

Read before running a dev daemon beside the live app, `scripts/live-verify.ps1`, `phone-verify.ps1`, `wdio-sweep.ps1`, the view harness or a when-done check.

- **Dev daemon serving a phone without bouncing the live app:** build dist, `cargo build --manifest-path src-tauri/Cargo.toml`, then run the daemon binary with `CC_DAEMON_INSTANCE` set (any label) so it binds an ephemeral remote port instead of fighting the production daemon for 27183 - read the actual port from the `remote-access server listening on 127.0.0.1:<port>` log line, or set `CC_REMOTE_PORT` to pin a known one. Point the emulator at `10.0.2.2:<port>`.

- Live-verify against the real app without touching the dev's installed instance: `scripts/live-verify.ps1 up` / `eval <index> <expr>` / `shot <index> <path>` / `down` - isolated debug build, private WebView2 profile, loopback-only CDP on a random ephemeral port, teardown by PID only. Headless by default: the rig runs under server_supervisor docked headless, so neither its windows nor the ones it opens (the Code pop-out) reach Joe's screen or take his focus. `up -Visible` puts it on the desktop instead, and then his typing can land in the rig.

- Phone-path (`isRemote()` true) checks without a device: `scripts/phone-verify.ps1 up` / `status` / `down` runs an isolated daemon from a private copy of `D:\cargo-target\debug\cc-conductor-daemon.exe` (build it first; the script never runs cargo) with a dummy account and a git-initialised scratch project; `e2e/phone/open.mjs`'s `openPhonePage()` returns a logged-in Playwright Pixel 5 page on it. Opening a draft chat and typing in its composer spawns no `claude` process.

- `CC_WHEN_DONE_DRY_RUN` (any non-empty value): the when-done Firing phase runs the full state machine but skips the real sleep/shutdown, logging `when_done: dry-run, would <action>` instead - set it before a live "does when-done actually fire" check so it doesn't sleep/power off the machine.

- View harness port: `playwright.config.ts` serves on 4420 by default; set `VIEW_HARNESS_PORT=<free port>` (e.g. `VIEW_HARNESS_PORT=4431 pnpm exec playwright test <spec>`) so a second concurrent run (parallel builders, two chats) gets its own vite instead of hitting "Port 4420 is already in use".

- One-off component screenshot via `pnpm run test:view`'s browser harness, no throwaway spec: `scripts/harness-shot.ps1 -Driver <ts-file> -Out <png-path>`.

- Show Joe an existing PNG in the in-app preview panel: `scripts/show-shot.ps1 -Path <png-path> [-Title <text>] [-Slug <name>]`.

- Full wdio release-gate sweep in one call (9 free specs with daemon-lifecycle last, then chat-flow/reload-dup on a fake claude, full logs kept on disk, one-line verdict per spec): `scripts/wdio-sweep.ps1` (`-Billed` adds `question-card-live`, and `-Spec question-card-live` is refused without it; `-RealClaude` bills chat-flow/reload-dup too; `-WhatIf` prints the plan without running anything). It re-launches itself under server_supervisor with its whole process tree headless, so the app windows every spec opens stay off Joe's screen, and refuses to run if the supervisor is down; `-Visible` runs it on the desktop. Supervisors older than the `/run` `dock_headless` release can let a window through for a few seconds per spec.
