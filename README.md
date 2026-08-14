# claude-conductor

Tauri 2.x companion app for Claude Code. Combines:

- **Usage monitoring** (5h session + 7d weekly windows) polled from the `claude.ai` usage API with your session cookie - no browser involved after the one-time Chrome login flow.
- **Sessions** - a chat hub for live Claude Code sessions across all your projects. A background daemon runs a persistent `claude` process per session (sessions keep running when the app is closed); the app renders the streamed JSON output as a proper chat with markdown, syntax-highlighted code blocks, and clipboard image paste. Pop any session into its own window.
- **Sleep / shutdown when done** - from the chat window's more-options menu, arm "Sleep when done" or "Shutdown when done". The app waits for every active session to go idle, runs `/close` in each, then counts down (cancellable) before sleeping or shutting down the PC. Sessions blocked on a prompt are auto-resolved so the machine never hangs waiting on you.
- **Scheduling** - schedule a message into any chat, or schedule a brand-new chat that spawns and runs its prompt at a set time (one-shot or recurring: daily, weekly, every N days). The daemon fires items even with the app window closed. Trigger from the composer's Send ▾ chevron; manage everything in the Schedule view (upcoming by day, missed/failed flagged with retry, read-only rows for external Task Scheduler one-shots). Items missed while the PC slept fire on wake if less than the grace window late (default 1h, configurable), otherwise you get a popup to fire or reschedule them.
- **History** - read-only browser of past Claude sessions from `~/.claude/sessions/`.
- **Channel management** for headless Claude Code automation (`--remote-control`).
- **Manual session takeover** - reach into a Claude process running in your terminal and resume it inside this app.
- **Voice dictation** in the composer, transcribed locally by a Python `faster-whisper` sidecar. Not bundled into the installer today - it only works if this repo's `stt-sidecar/` folder (with its `.venv` set up per `stt-sidecar/requirements.txt`) is reachable from the running app, which in practice means building/running from a source checkout. An installer-only install with no repo nearby has no working dictation.

Windows, macOS, and Linux (x86_64) supported.

## Install

Grab the latest build from the [Releases](https://github.com/SirBepy/claude_usage_in_taskbar/releases) page.

All assets follow `Claude-Conductor_<version>_<os>_<arch>.<ext>`. Pick the row matching your machine.

### Windows

Download `Claude-Conductor_<version>_windows_x64.exe` and run it. The NSIS installer handles autostart and desktop shortcuts.

### macOS

Download the `.dmg` matching your architecture:

- Apple Silicon (M1/M2/M3/M4): `Claude-Conductor_<version>_macos_arm64.dmg`
- Intel: `Claude-Conductor_<version>_macos_x64.dmg`

Mount the DMG and drag **Claude Conductor** to Applications.

**First launch (unsigned build workaround):** The app is not signed with an Apple Developer ID, so Gatekeeper refuses the normal double-click-open. Right-click **Claude Conductor** in Applications, choose **Open**, then confirm the "unidentified developer" prompt. Only needed once; subsequent launches and auto-updates work normally.

### Linux

Two options on x86_64:

**DEB (Debian/Ubuntu):**

Download `Claude-Conductor_<version>_linux_x64.deb` and install:

```bash
sudo apt install ./Claude-Conductor_<version>_linux_x64.deb
```

**AppImage (any distro):**

Download `Claude-Conductor_<version>_linux_x64.AppImage`, mark it executable, and run:

```bash
chmod +x Claude-Conductor_<version>_linux_x64.AppImage
./Claude-Conductor_<version>_linux_x64.AppImage
```

The app needs a Chromium-based browser (Google Chrome, Chromium, or Brave) installed for the one-time login flow.

Note: channel automation (running Claude Code remote-control instances from the dashboard) is Windows + macOS only on v1.

## Dev

```bash
cd src-tauri
cargo tauri dev
```

## Build

```bash
cd src-tauri
cargo tauri build
```

On Windows produces an NSIS installer in `src-tauri/target/release/bundle/nsis/`; on macOS produces a DMG in `src-tauri/target/<triple>/release/bundle/dmg/`.

## Multi-account

The app can drive more than one Claude account (e.g. Personal, Work) side by side, each fully isolated for chats and usage tracking.

- **Add an account** from Settings > Accounts. Each account needs two one-time logins: a terminal `/login` (the wizard opens a dedicated terminal window titled "Claude login - <name>" - run `/login` there, not in another terminal) and a browser usage login (the same Chrome-tab flow used for single-account usage tracking). If the account's profile folder already holds a valid CLI login, the wizard detects it and skips the terminal step entirely. The wizard confirms both logins belong to the same account before saving, and warns if a `/login` lands in a different profile (i.e. the wrong terminal window).
- **Chats and usage are per-account.** Starting a new chat lets you pick which account it runs under (a project can remember its usual account); the dashboard, tray, and the floating usage overlay all show every account's own 5h/weekly usage side by side.
- **Your terminal's `~/.claude` is never touched by app chats.** Every account the app manages gets its own private profile folder; whatever account you're logged into in a plain terminal stays completely separate and unaffected.
- **Upgrading from a single-account install:** your existing usage history keeps working exactly as before until you add your first account. Once you add an account whose login matches the one usage was already tracking, its history carries over automatically - nothing is lost.

## Channel management

Beyond tracking Claude Code usage, this app manages Claude Code channels per project:

- See every running Claude Code instance on your machine, live.
- Configure "automated channels" per project that start at boot and stay alive.
  - **Windows:** each channel runs in a hidden terminal; click **term** on its row to bring it to the foreground and type into it directly.
  - **macOS:** channels run headless (no visible console). Stop/Restart work as on Windows; Show/Hide is not applicable.
- Copy a phone link for any remote-control session to open it in the Claude mobile app.

Replaces the previous `obsidian_claude_remote` tray app (now discontinued and archived).

## Android companion app

A thin native shell (`android/`) that connects to a running desktop Conductor instance over the
network - it does not run Claude Code itself, it just renders the same remote-control web UI the
desktop serves.

**Get the APK.** A GitHub Release carries a signed `*_android_arm64.apk` whenever that release
changed the Android shell. Releases that only touched the desktop app do not rebuild it, so if the
newest release has no APK, the most recent one that does is still current. To build it yourself
instead, see `CLAUDE.md`'s Android section.

**Prerequisite.** For the Android app, none beyond the desktop: scanning the pairing QR connects the
phone directly to your desktop, peer-to-peer, whether or not Tailscale is installed and on WiFi or
mobile data alike. Anything else - a laptop browser, say - still needs Tailscale, because only the
Android app can make that direct connection. Either way, open Settings > Remote access on the
desktop and turn it on first.

**Pair the app:**

1. On the desktop, Settings > Remote access shows a QR code and a copyable pairing link once
   remote access is enabled.
2. On the phone's first launch, tap **Scan QR code** and scan it (camera permission required). This
   is the direct path, and needs no Tailscale on either device.
3. To go over Tailscale instead, type the server's `https://` URL into the field and tap the check
   button. Both devices have to be on your Tailscale network for that address to resolve.
4. Once connected the phone drops straight into the desktop's remote-control UI, and remembers how
   it connected for future launches.

While it connects, the phone shows "Reaching your PC…" and keeps retrying on its own with a visible
countdown - tap **Edit connection** to go back and change the address.

Paired devices can be revoked any time from Settings > Remote access on the desktop.
