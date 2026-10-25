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
  fun shouldRelock(backgroundedAt: Long?, now: Long, relockMinutes: Int): Boolean =
    backgroundedAt != null && now - backgroundedAt >= normalizeMinutes(relockMinutes) * 60_000L
}
