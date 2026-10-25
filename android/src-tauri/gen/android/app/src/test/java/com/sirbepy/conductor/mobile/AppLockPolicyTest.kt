package com.sirbepy.conductor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockPolicyTest {
  private val minute = 60_000L

  @Test
  fun neverBackgroundedStaysUnlocked() {
    assertFalse(AppLockPolicy.shouldRelock(null, 10_000_000L, 10))
  }

  @Test
  fun aTripShorterThanTheWindowStaysUnlocked() {
    val away = 1_000L
    assertFalse(AppLockPolicy.shouldRelock(away, away + 10 * minute - 1, 10))
  }

  @Test
  fun theFullWindowAwayRelocks() {
    val away = 1_000L
    assertTrue(AppLockPolicy.shouldRelock(away, away + 10 * minute, 10))
  }

  @Test
  fun theDefaultWindowIsTenMinutes() {
    assertEquals(10, AppLockPolicy.DEFAULT_RELOCK_MINUTES)
    val away = 1_000L
    assertFalse(AppLockPolicy.shouldRelock(away, away + 9 * minute, AppLockPolicy.DEFAULT_RELOCK_MINUTES))
  }

  @Test
  fun zeroRelocksOnAnyTripAway() {
    assertTrue(AppLockPolicy.shouldRelock(1_000L, 1_000L, 0))
  }

  @Test
  fun aValueOffTheListFallsBackToTheDefault() {
    assertEquals(AppLockPolicy.DEFAULT_RELOCK_MINUTES, AppLockPolicy.normalizeMinutes(100_000))
    assertEquals(AppLockPolicy.DEFAULT_RELOCK_MINUTES, AppLockPolicy.normalizeMinutes(-1))
    assertEquals(30, AppLockPolicy.normalizeMinutes(30))
    val away = 1_000L
    assertTrue(AppLockPolicy.shouldRelock(away, away + 10 * minute, 100_000))
  }
}
