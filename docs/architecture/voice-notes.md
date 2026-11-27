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

## Tests

`gradlew :app:testArm64DebugUnitTest` from `android/src-tauri/gen/android` (JDK 21, after `scripts/bootstrap-worktree.ps1`; see android-build.md): `RecordingFilesTest`, `RecordingStoreTest` (state walk, crash recovery, `.bad` index, adoption, atomic write), `VoiceBridgePolicyTest`. The unit-test classpath adds the real `org.json` (`testImplementation`), because the host JVM's `android.jar` copy is a stub. `cargo test --manifest-path android/src-tauri/Cargo.toml` is unaffected.

Cannot be tested without the Pixel 7 (todo pc-1852 acceptance): 60 minutes with the screen off and no signal and a correct duration; force-stopping the app mid-recording and playing the `.part`-recovered file (Ogg readable after a hard kill is UNVERIFIED); battery-management kills on multi-hour recordings; the error listeners on a real mic takeover or full storage; audio-focus pause on a real call; the system permission dialog and the notification layout.

## Rounds (pc-1852, refined 2026-11-27)

- R1 design (done): entry points, offline home, list states.
- R2 (this): recorder service, `ConductorVoice` bridge, local store.
- R3: bundled offline voice home in the Tauri shell (`android/src/`), replacing the endless "Reaching your PC" spinner; the handoff never pulls Joe off the voice screens.
- R4: upload. A native Rust uploader over the existing iroh tunnel (runs in the background, clear of the "Waiting for your PC" strip rules), daemon resumable chunked endpoint idempotent by (device id, recording id, sha256), `TRANSPORT_TABLE` rows. Needs a reviewer (tunnel). UNVERIFIED: where the daemon checks `rc_token` on REST routes, which the native uploader needs.
- R5: batch transcription on the stt-sidecar engine, vault note export (port `vault_export.rs`), and the one-time import of `/storage/emulated/0/VoiceNotes`.
- R6: SPA entry (mic head under "+"), Quick Settings tile, notification Start action, route to the recordings list.
- R7: the split-and-draft pass (periodic agent over unprocessed vault notes).
