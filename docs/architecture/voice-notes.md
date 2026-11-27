# Voice notes on the phone

Read before editing the Android recorder (`RecorderService.kt`, `RecordingFiles.kt`, `RecordingStore.kt`, `RecorderState.kt`, `VoiceNotes.kt`, `VoiceBridge.kt` under `android/src-tauri/gen/android/app/src/main/java/com/sirbepy/conductor/mobile/`) or anything that talks to it. Tracks todo pc-1852. The design round (entry points, offline home, list states) lives in the preview "Voice notes on the phone: design round"; this file records what is built and the rules it follows.

## Goal and decisions (settled by Joe, 2026-11-27)

Joe records long voice rambles on the phone, screen off, no signal, and the recording is safe on the phone the moment he stops. Later rounds upload it to the PC, transcribe it and write a vault note.

- A native Kotlin recorder service plus a `ConductorVoice` JS bridge. Not a Tauri plugin: the daemon-served SPA has no Tauri IPC after the handoff (`withGlobalTauri` is false, `android/src/app.js:134-137`), while a `JavascriptInterface` registered in `MainActivity.onWebViewCreate` survives it (`MainActivity.kt`, next to `ConductorPush` and `ConductorLock`).
- App-specific storage, no all-files access (Play restricts `MANAGE_EXTERNAL_STORAGE`). The old `/storage/emulated/0/VoiceNotes` folder is imported once in R5.
- The app never deletes a recording. The one exception is a `.part` with no bytes in it (a recording stopped before any audio), which holds nothing. Uninstalling the app removes app-specific storage; that is Android's rule and the one way audio can go, so R5's import and the upload (recordings stay on the phone after upload) are the safety net.
- Entry point A (a mic chat head under "+") plus a Quick Settings tile and a notification action, built in R6.
- The transcript goes to the vault only. No "Send to chat", no auto-spawned chat; a later periodic agent triages the notes.

## What R2 built

### Recorder (`RecorderService`)

Ported from `handy_scripts/android-recorder`. A foreground service of type `microphone` (manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `WAKE_LOCK`; `RECORD_AUDIO` was already declared for dictation) holds a partial wake lock for the whole recording, so a walk with the screen off keeps going. `MediaRecorder` writes Ogg/Opus, 16 kHz mono, 24 kbps (about 11 MB an hour; Whisper reads 16 kHz). It pauses on a transient audio-focus loss (a call, an alarm) and resumes on gain; a permanent loss (another app plays) does not stop it, because dropping the rest of a long note is the worse failure.

Failure handling the original lacked:

- `MediaRecorder.OnErrorListener` and `OnInfoListener` end the recording through `finishRecording(error)`: stop the encoder, then on the single IO thread rename the part and index it as SAVED with the reason in `error`, raise a separate high-importance notification ("Voice recording stopped", its own channel and id, so `stopForeground` does not remove it), and set `RecorderState.error` so the page can show it. A max-duration or max-size info code is treated the same although no limit is set.
- A start that cannot proceed (Android below 10, no microphone permission, folder not writable, under 50 MB free) raises the same notification and `RecorderState.error`; it never leaves a silent foreground service.
- Any exception in `start()` (a `SecurityException` from `startForeground` on Android 14, the `MediaRecorder` constructor) takes the same path: audio on disk is kept for the following recovery, an empty part and its row go, and the service stops.
- `onDestroy` while recording (the system took the service) finishes the file the same way.
- The ongoing notification uses a chronometer, so it needs no per-second update while the screen is off. It carries a Stop action.

Not covered by the listeners, UNVERIFIED on a device: a stalled encoder that reports nothing (a watchdog on part-file growth was left out because a false positive would end a good recording).

### Files (`RecordingFiles`)

A recording is written as `<yyyy-MM-dd_HH-mm-ss>.opus.part` and renamed to `.opus` only when complete; a name that exists gets `_2`, `_3`; `finalize` never overwrites. The folder is `getExternalFilesDir(null)/voice-notes` (visible over USB for a manual copy), falling back to `filesDir/voice-notes` when the external volume is not mounted (`VoiceNotes.dir`).

### Index (`RecordingStore`)

One JSON file, `filesDir/voice-notes-index.json` (private, apart from the audio so browsing the audio folder cannot delete the bookkeeping). One row per recording: `id` (UUID), `file` (a name, never a path), `sizeBytes`, `sha256`, `recordedAtMs`, `durationMs`, `state`, `bytesUploaded`, `error`.

States: `recording`, `saved`, `queued`, `uploading`, `uploaded`, `transcribed`, `failed`. Allowed moves (`RecordingTransitions`): saved to queued; queued to uploading, uploaded (the PC already has the sha256) or failed; uploading to queued, uploaded or failed; uploaded to transcribed or failed; failed to queued (retry). `recording` leaves only through `complete`, and `transcribed` is the end. Anything else returns null and changes nothing. `setProgress` works only while uploading and clamps to the file size. A state a build does not know reads as `saved`.

Rules:

- The folder is the truth about audio, the index the truth about what happened to it, and `reconcile(active)` rebuilds either from the other. It runs on every app start (`MainActivity.onCreate` through `VoiceNotes.recover`, on the single IO thread). It finishes a part a killed process left (row still `recording`), handles a rename that happened before the row update, drops a row whose audio never reached the disk, and adopts any `.opus` or `.part` no row knows about as `saved` with an `error` note. Recordings this process is writing are `live` in the store (from `begin` until `complete`, `abandon` or `release`): reconcile skips their rows, their parts and the final name they will get. The rename and `complete` run as one job on the IO thread, the same thread as reconcile, so a recovery pass cannot split them. A rename that fails with audio in the part keeps the row (`release`) and the following app launch finishes it.
- An unreadable index is moved aside as `index.json.bad`, `.bad1`, ... (never overwritten) and rows are rebuilt from the folder; it is never read as empty and then written over.
- Writes are temp file, fsync, atomic move (`Files.move`, not `File.renameTo`, which fails over an existing file on Windows hosts). A failed write is logged and the in-memory rows stay right; the next change retries.
- The sha256 is computed off the main thread and outside the store lock. A file that cannot be hashed still gets a row (hash null).
- Retry keeps `bytesUploaded`; the uploader asks the PC where to resume, never trusts the local figure.

### Bridge (`ConductorVoice`)

Registered in `MainActivity.onWebViewCreate`; every method returns a JSON string.

| Method | Returns |
| --- | --- |
| `start()` | `{ok, result}` where result is `started`, `already_recording`, `permission_requested`, `unsupported` or `locked`. `permission_requested` shows the system dialog; a grant starts the recording, a denial sets the state's `error`. |
| `stop()` | `{ok:true}`; always allowed, locked or not. |
| `list()` | Array of index rows, newest first. |
| `state()` | `{bridgeVersion, supported, status: idle\|recording\|paused, recordingId, elapsedMs, error, micPermission}`. |
| `dismissError()` | `{ok:true}`; clears `state().error` (the next start clears it too). |

The page learns of changes through `window.__ccVoiceChanged()`, called on every recorder state change and every index change (no payload: read `state()` and `list()`). Like the other bridges it is reachable from any page the WebView loads, which is the user's own daemon; `start()` is the one method with an effect, so it refuses while the app lock is up. The decision logic is `VoiceBridgePolicy` (pure, unit-tested).

## What R3 built: bundled voice screens (`android/src/`)

`voice.js`, `voice.css` and the `#voice-screen` markup in `index.html` run in the Tauri shell page itself, so they need no PC, tunnel or network; they talk only to the `ConductorVoice` bridge. `icons.js` carries the Phosphor glyphs the screens use as bundled SVG paths (the shell cannot load the web CDN offline; `<i data-ph="name">` plus `window.phRender`). Screens: Home (big mic, connection chip, three recent rows, "All recordings"), Recorder (timer, level meter, huge start/stop button, safe-state text, dismissable error), Recordings (one row per recording with a state badge).

- The boot auto-reconnect (`runAutoRetryLoop` in `app.js`) shows Home instead of the old "Reaching your PC" spinner. The connection is one chip on Home: connecting, "PC offline, retrying in Ns", connected, or not connected. The setup screen has a "Voice notes, no PC needed" button for an unpaired phone.
- `handoff()` never pulls Joe off the voice screens. `VoiceUi.holdsHandoff()` is true while a recording runs, on Recorder or Recordings, or once he has touched anything on Home; the handoff is then parked and Home shows "Open Conductor". An untouched Home still hands off at once, so a phone with no voice use behaves as before.
- `holdsHandoff()` reads `state()` fresh and counts a recording even behind a hidden screen ("Edit connection" hides the voice screen; the recording keeps running). KNOWN GAP: a parked handoff is not re-probed, so "Open Conductor" tapped minutes later can load a dead tunnel page if the PC dropped meanwhile.
- Row states map from the index: `saved` Saved on phone, `queued` and `failed` Waiting for PC, `uploading` Uploading N% (from `bytesUploaded`), `uploaded` Uploaded, `transcribed` Transcribed.
- Home's mic opens the Recorder and starts at once (a recording is the point of the screen). Back from the Recorder never stops it; Home shows a "Recording mm:ss" banner that reopens it.
- The meter reads `ConductorVoice.level()` (`{level: 0..1}`) when a build has it. R2's bridge has no `level()`, so today the bars show a steady "recording is alive" pulse, not an audio level. A real level needs a `level()` method on the bridge (follow-up).
- Not verified on a device: the screens were drawn in a desktop browser with a mocked bridge (screenshots in `.for_bepy/screenshots/voice-r3/`); the real WebView, insets and the permission dialog flow are UNVERIFIED.

## What R4 built: upload to the PC (2026-11-27)

Every recording reaches the PC by itself while the tunnel is up, survives a dropped tunnel and never lands twice. Nothing in the page is involved: a native Rust task in `android/src-tauri/src/voice_upload/` runs for the life of the process, so it works with the screen off, on a voice screen, or before the PC's page ever loaded, and its calls never touch the "Waiting for your PC" strip (`BACKGROUND_READS` and the page transport are not in the path).

### Daemon (`src-tauri/src/daemon/voice_upload/`)

- Two RPC methods on `/api/rpc`, both mask `P` in `TRANSPORT_TABLE` (phone only; allowlist test `voice_upload_methods_are_phone_only`): `voice_upload_begin {recording_id, sha256, size_bytes, recorded_at_ms?, duration_ms?}` and `voice_upload_chunk {recording_id, sha256, offset, data_b64}`. The device id is `ConnectionContext.device_id`, set from the bearer token by `auth_mw`, never from params; a call with no device is -32600. `recording_id` and the device id must match `[A-Za-z0-9_-]{1,64}` and `sha256` is 64 lowercase hex, so no id can name a path outside the audio folder.
- Replies carry a `status`: `partial {offset, max_chunk}` (send the next chunk at `offset`, at most `max_chunk` bytes, 2 MiB), `complete`, `offset_mismatch {offset}` (the PC holds a different number of bytes; resume from that offset), `hash_mismatch` (the file was whole but its sha256 differs; the PC dropped the partial) and `no_upload` (a chunk for an upload that was never begun; begin again).
- Storage: `<app data>/voice-notes/audio/<device>/<recording>-<sha256[..16]>.{begin.json,part,opus,json}`. The key is (device, recording, sha256), so the same recording re-sent is the same files and a same-id recording with different content is a separate set. A chunk is appended only at exactly the held length: a repeat of an applied chunk is `offset_mismatch` pointing at the true offset, and a chunk past the end is refused, so a retry after a lost reply can never duplicate bytes. `begin` on a recording the PC already holds (receipt and audio agree) answers `complete` without a write; `begin` with a changed size resets the partial. The last chunk hashes the whole `.part`, and only a match is renamed to `.opus`, after which the receipt `.json` is written atomically (`"transcription":"pending"`) and the transcription hook fires once.
- One process-wide lock serialises every upload call (a chunk is milliseconds of disk, and it makes two calls at one offset impossible); the work runs in `spawn_blocking`.
- R5 hook: `store::set_transcription_hook` (called once per verified recording, after the receipt) and `UploadStore::pending_transcriptions()` (receipts still `pending`, for a queue that starts after some recordings already arrived). Nothing installs the hook yet.

### Phone (`android/src-tauri/src/voice_upload/`)

- `engine.rs` decides what to send: claim jobs from Kotlin, hash the file if the index has no sha256, `voice_upload_begin`, then chunks read at the offset the PC names. It always follows the PC's offset (never its own count), re-begins when the PC already holds every byte, restarts a hash or `no_upload` answer at most twice, and ends a recording as failed on a PC refusal while the next one still goes. A missing or resized file fails without calling the PC. Chunks start at 16 KiB and grow to 256 KiB (`Pacer`): a call slower than 10 s halves it, one faster than 2 s doubles it, because the relay measured about 20 KB/s and one call must finish well inside the 30 s QUIC idle timeout. Each call has a 45 s deadline.
- `tunnel_rpc.rs` posts one `POST /api/rpc` (HTTP/1.1, `Connection: close`) over a fresh bi-stream of the shared iroh tunnel (`IrohTunnelState::live_tunnel`); `http.rs` is the minimal client. The bearer token is only ever sent to the tunnel whose loopback port equals the port it was captured for.
- `mod.rs` loops: idle 20 s, 1 s after a pass that did work, 10 s doubling to 120 s while the PC is unreachable or the login is missing. Non-idle passes are journaled as `voice_upload` events.
- Index ownership: `RecordingStore` stays the only writer. Rust reaches it through the Kotlin plugin `VoiceUploadPlugin` (commands `voiceClaim`, `voiceMark`, `voiceAuth`; rules in `VoiceUploadPolicy`). Claim turns every `saved` row into `queued` and returns `queued` plus `uploading` rows oldest first (an `uploading` row is one a killed process left). Marks map to `queued -> uploading` (with `bytesUploaded`), `uploading -> queued` (tunnel dropped, progress kept), `uploaded` (also when the PC already held it) and `failed` with a reason; a failed row is not claimed again until a retry puts it back to `queued`.
- The login: `rc_token` is in the PC page's localStorage, which native code cannot read, and `src/` and `android/src/app.js` are untouched. `MainActivity` therefore evaluates `localStorage.rc_token`, `location.port` and `location.hostname` in the loaded page on resume, every 30 s while resumed, and on pause, and `UploadAuthStore` keeps the last good copy (`voice-upload-auth.json`, private files dir, atomic write). Only a `127.0.0.1` origin with a token and a valid port is accepted (`UploadAuthPolicy.parseCapture`). Until the page has been open once with a login there is none, and the uploader waits (backoff) rather than failing recordings.
- Tests: daemon `voice_upload/tests.rs` (whole upload, resume after a drop and after a daemon restart, duplicate and ahead chunks, already-held never duplicated, hash mismatch, per-device filing, traversal names, router-level calls with the device taken from the connection); android crate `voice_upload/*` (engine against a fake PC with the daemon's rules: dropped tunnel resumes without duplicates, lost chunk answer not resent, PC offset followed, hash mismatch capped, wire shapes, HTTP framing, a real iroh stream to a fake HTTP server proving the bearer and the port binding); Kotlin `VoiceUploadPolicyTest`.
- UNVERIFIED on a device: the plugin registration (`register_android_plugin` and the JNI class lookup for `VoiceUploadPlugin`), the token capture from a real WebView, and real relay throughput; the Kotlin and Rust sides compile and pass their host tests. Not built: a manual "retry" for a failed recording, and any upload of recordings made before the phone has ever opened the PC's page (they wait for the login).

## Tests

`gradlew :app:testArm64DebugUnitTest` from `android/src-tauri/gen/android` (JDK 21, after `scripts/bootstrap-worktree.ps1`; see android-build.md): `RecordingFilesTest`, `RecordingStoreTest` (state walk, crash recovery, `.bad` index, adoption, atomic write), `VoiceBridgePolicyTest`, `VoiceUploadPolicyTest` (R4 claim, marks, login capture and store). The unit-test classpath adds the real `org.json` (`testImplementation`), because the host JVM's `android.jar` copy is a stub. `cargo test --manifest-path android/src-tauri/Cargo.toml` is unaffected.

Cannot be tested without the Pixel 7 (todo pc-1852 acceptance): 60 minutes with the screen off and no signal and a correct duration; force-stopping the app mid-recording and playing the `.part`-recovered file (Ogg readable after a hard kill is UNVERIFIED); battery-management kills on multi-hour recordings; the error listeners on a real mic takeover or full storage; audio-focus pause on a real call; the system permission dialog and the notification layout.

## Rounds (pc-1852, refined 2026-11-27)

- R1 design (done): entry points, offline home, list states.
- R2 (this): recorder service, `ConductorVoice` bridge, local store.
- R3 (done): bundled offline voice home in the Tauri shell (`android/src/`), replacing the endless "Reaching your PC" spinner; the handoff never pulls Joe off the voice screens.
- R4 (done, 2026-11-27): upload. Native Rust uploader over the iroh tunnel, daemon resumable chunked endpoint idempotent by (device, recording, sha256), phone-only `TRANSPORT_TABLE` rows. See "What R4 built". The `rc_token` check is `auth_mw` on the daemon's protected REST router (bearer token, device id from the device registry).
- R5: batch transcription on the stt-sidecar engine, vault note export (port `vault_export.rs`), and the one-time import of `/storage/emulated/0/VoiceNotes`.
- R6: SPA entry (mic head under "+"), Quick Settings tile, notification Start action, route to the recordings list.
- R7: the split-and-draft pass (periodic agent over unprocessed vault notes).
