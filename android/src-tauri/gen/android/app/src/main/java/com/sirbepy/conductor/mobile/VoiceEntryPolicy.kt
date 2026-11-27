package com.sirbepy.conductor.mobile

// The pure half of the ways into the recorder that need no page: the Quick
// Settings tile, the notification's Record action, and the SPA's mic head
// asking the shell to open the bundled recorder. Unit-tested without Android.
object VoiceEntryPolicy {
  // The bundled shell page the voice screens live on. The daemon-served SPA has
  // no way back to it except through the native side, which loads this origin
  // (the same one app.js's health check names as the shell's own).
  const val SHELL_ORIGIN = "http://tauri.localhost/"

  // The only screens a caller may name; anything else opens Home.
  private val VIEWS = setOf("home", "recorder", "list")

  fun shellUrl(view: String?): String {
    val v = if (view != null && view in VIEWS) view else "home"
    return "$SHELL_ORIGIN#voice=$v"
  }

  // What a tap on the tile does.
  enum class TileAction { STOP, START, ASK_IN_APP, UNSUPPORTED }

  fun tileAction(sdk: Int, status: RecorderState.Status, micGranted: Boolean): TileAction = when {
    // Stopping is always allowed: it only ends a recording.
    status != RecorderState.Status.IDLE -> TileAction.STOP
    sdk < VoiceBridgePolicy.MIN_SDK -> TileAction.UNSUPPORTED
    // The system permission dialog needs an activity, so the tile opens the app.
    !micGranted -> TileAction.ASK_IN_APP
    else -> TileAction.START
  }

  // The tile's face: lit while a note is being taken.
  fun tileActive(status: RecorderState.Status): Boolean = status != RecorderState.Status.IDLE

  // The idle "Record" notification is useful only while nothing records and the
  // recorder can run at all; the ongoing recording notification replaces it.
  fun quickStartWanted(sdk: Int, status: RecorderState.Status, notificationsAllowed: Boolean): Boolean =
    sdk >= VoiceBridgePolicy.MIN_SDK && status == RecorderState.Status.IDLE && notificationsAllowed

  // Intent extra the tile and the notification set when they need the app open
  // (the microphone permission dialog) and the screen they land on.
  const val EXTRA_VOICE_OPEN = "com.sirbepy.conductor.mobile.voice.OPEN"

  // What the activity does with that extra. Held while the lock screen is up, so
  // a tap never shows the recorder behind it.
  enum class OpenAction { NONE, HOLD, OPEN }

  fun openAction(extra: String?, locked: Boolean): OpenAction = when {
    extra == null -> OpenAction.NONE
    locked -> OpenAction.HOLD
    else -> OpenAction.OPEN
  }
}
