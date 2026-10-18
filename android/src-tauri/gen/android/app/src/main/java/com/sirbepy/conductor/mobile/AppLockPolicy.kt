package com.sirbepy.conductor.mobile

// A paired phone can drive every chat on the PC, so the app asks for the
// phone's own fingerprint/PIN on launch and again after this long away.
object AppLockPolicy {
  const val RELOCK_AFTER_MS = 5 * 60 * 1000L

  // `backgroundedAt` and `now` are SystemClock.elapsedRealtime() readings,
  // which keep counting while the phone sleeps. Null: never backgrounded
  // since the last unlock.
  fun shouldRelock(backgroundedAt: Long?, now: Long): Boolean =
    backgroundedAt != null && now - backgroundedAt >= RELOCK_AFTER_MS
}
