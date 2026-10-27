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
  fun choicesJsonCarriesTheListAndTheDefault() {
    assertEquals("{\"default\":10,\"choices\":[0,1,5,10,30,60]}", AppLockPolicy.choicesJson())
  }

  @Test
  fun anOwnActivityStopGetsAGraceOnEveryTime() {
    val away = 1_000L
    assertTrue(AppLockPolicy.shouldRelock(away, away + 1, 0))
    assertFalse(AppLockPolicy.shouldRelock(away, away + 1, 0, ownActivityStop = true))
    assertTrue(AppLockPolicy.shouldRelock(away, away + 2 * minute, 0, ownActivityStop = true))
  }

  @Test
  fun anOwnActivityStopNeverShortensALongerWindow() {
    val away = 1_000L
    assertFalse(AppLockPolicy.shouldRelock(away, away + 10 * minute - 1, 10, ownActivityStop = true))
    assertTrue(AppLockPolicy.shouldRelock(away, away + 10 * minute, 10, ownActivityStop = true))
  }

  @Test
  fun anUpgradedInstallWithNoAnswerCountsAsLockedOn() {
    assertEquals(true, AppLockPolicy.resolveEnabled(null, true))
  }

  @Test
  fun aFreshInstallWithNoAnswerIsUnanswered() {
    assertEquals(null, AppLockPolicy.resolveEnabled(null, false))
  }

  @Test
  fun aStoredAnswerBeatsTheUpgradeSignal() {
    assertEquals(false, AppLockPolicy.resolveEnabled(false, true))
    assertEquals(true, AppLockPolicy.resolveEnabled(true, false))
  }

  @Test
  fun unansweredWithAScreenLockAsks() {
    assertEquals(AppLockPolicy.StartAction.ASK, AppLockPolicy.startAction(null, true))
  }

  @Test
  fun unansweredWithoutAScreenLockOpensWithoutAsking() {
    assertEquals(AppLockPolicy.StartAction.OPEN, AppLockPolicy.startAction(null, false))
  }

  @Test
  fun lockOffNeverLocksEvenWithAScreenLock() {
    assertEquals(AppLockPolicy.StartAction.OPEN, AppLockPolicy.startAction(false, true))
    assertEquals(AppLockPolicy.StartAction.OPEN, AppLockPolicy.startAction(false, false))
  }

  @Test
  fun lockOnLocks() {
    assertEquals(AppLockPolicy.StartAction.LOCK, AppLockPolicy.startAction(true, true))
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
