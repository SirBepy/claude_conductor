package com.sirbepy.conductor.mobile

// A paired phone can drive every chat on the PC, so the app asks for the
// phone's own fingerprint/PIN on launch and again after a while away. The
// "while" is a phone-only setting (Settings > Remote access > App lock). An app
// Android killed in the background always asks again: the unlock lives in memory.
object AppLockPolicy {
  const val DEFAULT_RELOCK_MINUTES = 10

  // 0 = every time the app leaves the screen. Capped at an hour so a page the
  // WebView loads cannot switch the lock off for good.
  val RELOCK_MINUTE_CHOICES = listOf(0, 1, 5, 10, 30, 60)

  // Anything off the list (an old value, a bad bridge call) reads as the default.
  fun normalizeMinutes(minutes: Int): Int =
    if (minutes in RELOCK_MINUTE_CHOICES) minutes else DEFAULT_RELOCK_MINUTES

  // `backgroundedAt` and `now` are SystemClock.elapsedRealtime() readings,
  // which keep counting while the phone sleeps. Null: never backgrounded
  // since the last unlock.
  //
  // `ownActivityStop`: the stop came from an activity the app launched itself
  // (the WebView's file or camera picker for a composer attachment). Relocking
  // right after the user picks a photo would be wrong, but a picker can also be
  // left for the home screen, so the window never drops below this grace.
  fun shouldRelock(
    backgroundedAt: Long?,
    now: Long,
    relockMinutes: Int,
    ownActivityStop: Boolean = false,
  ): Boolean {
    if (backgroundedAt == null) return false
    val minutes = normalizeMinutes(relockMinutes)
    val effective = if (ownActivityStop) maxOf(minutes, OWN_ACTIVITY_GRACE_MINUTES) else minutes
    return now - backgroundedAt >= effective * 60_000L
  }

  const val OWN_ACTIVITY_GRACE_MINUTES = 2

  // How soon after launching a picker the app's own stop has to land to count as
  // caused by it. A launch that never stops the activity (a translucent overlay)
  // must not leave the grace armed for a much later, real trip away.
  const val OWN_LAUNCH_STOP_WINDOW_MS = 5_000L

  // Both are SystemClock.elapsedRealtime() readings. Null: no picker launched
  // since the last start/resume, or the app never stopped.
  fun isOwnActivityStop(launchedAt: Long?, stoppedAt: Long?): Boolean {
    if (launchedAt == null || stoppedAt == null) return false
    return stoppedAt - launchedAt in 0..OWN_LAUNCH_STOP_WINDOW_MS
  }

  // PackageInfo times are epoch millis. Split-APK and Play installs can stamp
  // lastUpdateTime a few ms after firstInstallTime, so only a real gap is an update.
  const val UPGRADE_GAP_MS = 60_000L

  fun isUpgrade(firstInstallTime: Long, lastUpdateTime: Long): Boolean =
    lastUpdateTime - firstInstallTime > UPGRADE_GAP_MS

  // What the SPA's picker offers, as one JSON object so the Kotlin list stays the
  // only copy: {"default":10,"choices":[0,1,5,...]}.
  fun choicesJson(): String =
    "{\"default\":$DEFAULT_RELOCK_MINUTES,\"choices\":[${RELOCK_MINUTE_CHOICES.joinToString(",")}]}"

  // The lock is opt-in: `stored` is the saved answer (null = never answered).
  // A phone that already ran a lock-always version has been using the lock, so
  // an upgraded install without an answer starts as Yes instead of being asked.
  fun resolveEnabled(stored: Boolean?, upgradedInstall: Boolean): Boolean? =
    stored ?: if (upgradedInstall) true else null

  enum class SwitchRequest { SAVE_NOW, UNLOCK_FIRST }

  // Any script in the WebView can call the bridge, so turning the lock off needs
  // a fresh unlock; turning it on can only make the phone safer. With no screen
  // lock there is nothing to unlock with (and nothing the lock protects).
  fun switchRequest(enable: Boolean, hasScreenLock: Boolean): SwitchRequest =
    if (enable || !hasScreenLock) SwitchRequest.SAVE_NOW else SwitchRequest.UNLOCK_FIRST

  // The SPA registers window.__ccLockSwitchResult before it asks, so the answer
  // to a prompt can never arrive ahead of the handler.
  fun switchResultJs(applied: Boolean): String =
    "window.__ccLockSwitchResult&&window.__ccLockSwitchResult($applied)"

  enum class StartAction { ASK, LOCK, OPEN }

  // Unanswered with no screen lock: open without asking and without recording an
  // answer, so the question appears on the first launch after one is set up.
  fun startAction(enabled: Boolean?, hasScreenLock: Boolean): StartAction = when {
    enabled == null -> if (hasScreenLock) StartAction.ASK else StartAction.OPEN
    enabled -> StartAction.LOCK
    else -> StartAction.OPEN
  }
}
