package com.sirbepy.conductor.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockPolicyTest {
  @Test
  fun neverBackgroundedStaysUnlocked() {
    assertFalse(AppLockPolicy.shouldRelock(null, 10_000_000L))
  }

  @Test
  fun aShortTripAwayStaysUnlocked() {
    val away = 1_000L
    assertFalse(AppLockPolicy.shouldRelock(away, away + AppLockPolicy.RELOCK_AFTER_MS - 1))
  }

  @Test
  fun fiveMinutesAwayRelocks() {
    val away = 1_000L
    assertTrue(AppLockPolicy.shouldRelock(away, away + AppLockPolicy.RELOCK_AFTER_MS))
  }
}
