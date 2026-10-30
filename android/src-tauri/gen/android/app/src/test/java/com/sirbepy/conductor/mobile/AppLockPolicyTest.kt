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
  fun aStopSoonAfterThePickerLaunchIsOurOwn() {
    assertTrue(AppLockPolicy.isOwnActivityStop(1_000L, 1_000L))
    assertTrue(AppLockPolicy.isOwnActivityStop(1_000L, 1_000L + AppLockPolicy.OWN_LAUNCH_STOP_WINDOW_MS))
  }

  @Test
  fun aStaleLaunchTimestampGivesNoGrace() {
    val launched = 1_000L
    val laterStop = launched + AppLockPolicy.OWN_LAUNCH_STOP_WINDOW_MS + 1
    assertFalse(AppLockPolicy.isOwnActivityStop(launched, laterStop))
    assertFalse(AppLockPolicy.isOwnActivityStop(launched, launched + 30 * minute))
    // The stale launch must not stretch an "every time" window to the 2-minute grace.
    val ownStop = AppLockPolicy.isOwnActivityStop(launched, laterStop)
    assertTrue(AppLockPolicy.shouldRelock(laterStop, laterStop + 1, 0, ownStop))
  }

  @Test
  fun noLaunchOrNoStopGivesNoGrace() {
    assertFalse(AppLockPolicy.isOwnActivityStop(null, 5_000L))
    assertFalse(AppLockPolicy.isOwnActivityStop(1_000L, null))
    assertFalse(AppLockPolicy.isOwnActivityStop(5_000L, 1_000L))
  }

  @Test
  fun aFewMillisecondsBetweenInstallAndUpdateIsNotAnUpgrade() {
    assertFalse(AppLockPolicy.isUpgrade(1_000L, 1_000L))
    assertFalse(AppLockPolicy.isUpgrade(1_000L, 1_000L + 5))
    assertFalse(AppLockPolicy.isUpgrade(1_000L, 1_000L + AppLockPolicy.UPGRADE_GAP_MS))
  }

  @Test
  fun aRealGapBetweenInstallAndUpdateIsAnUpgrade() {
    assertTrue(AppLockPolicy.isUpgrade(1_000L, 1_000L + AppLockPolicy.UPGRADE_GAP_MS + 1))
    assertTrue(AppLockPolicy.isUpgrade(1_000L, 1_000L + 24 * 60 * minute))
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

  @Test
  fun turningTheLockOffNeedsAFreshUnlock() {
    assertEquals(AppLockPolicy.SwitchRequest.UNLOCK_FIRST, AppLockPolicy.switchRequest(false, true))
  }

  @Test
  fun turningTheLockOnNeedsNoPrompt() {
    assertEquals(AppLockPolicy.SwitchRequest.SAVE_NOW, AppLockPolicy.switchRequest(true, true))
    assertEquals(AppLockPolicy.SwitchRequest.SAVE_NOW, AppLockPolicy.switchRequest(true, false))
  }

  @Test
  fun aPhoneWithNoScreenLockHasNothingToUnlockWith() {
    assertEquals(AppLockPolicy.SwitchRequest.SAVE_NOW, AppLockPolicy.switchRequest(false, false))
  }

  @Test
  fun aLongerRelockWindowWeakensTheLock() {
    assertTrue(AppLockPolicy.isWeakening(10, 30))
    assertTrue(AppLockPolicy.isWeakening(0, 1))
    assertTrue(AppLockPolicy.isWeakening(5, 60))
  }

  @Test
  fun anEqualOrShorterRelockWindowDoesNotWeakenTheLock() {
    assertFalse(AppLockPolicy.isWeakening(30, 30))
    assertFalse(AppLockPolicy.isWeakening(30, 5))
    assertFalse(AppLockPolicy.isWeakening(60, 0))
  }

  @Test
  fun aValueOffTheListIsJudgedAsTheDefaultItWouldBeSavedAs() {
    // 100_000 is saved as the 10-minute default, so it lengthens a 5-minute window...
    assertTrue(AppLockPolicy.isWeakening(5, 100_000))
    // ...and shortens a 60-minute one.
    assertFalse(AppLockPolicy.isWeakening(60, 100_000))
    // A stored off-list value reads as the default too.
    assertFalse(AppLockPolicy.isWeakening(100_000, 10))
  }

  @Test
  fun lengtheningTheRelockWindowNeedsAFreshUnlock() {
    assertEquals(AppLockPolicy.SwitchRequest.UNLOCK_FIRST, AppLockPolicy.relockRequest(10, 60, true))
  }

  @Test
  fun shorteningTheRelockWindowNeedsNoPrompt() {
    assertEquals(AppLockPolicy.SwitchRequest.SAVE_NOW, AppLockPolicy.relockRequest(60, 10, true))
    assertEquals(AppLockPolicy.SwitchRequest.SAVE_NOW, AppLockPolicy.relockRequest(10, 10, true))
  }

  @Test
  fun lengtheningWithNoScreenLockHasNothingToUnlockWith() {
    assertEquals(AppLockPolicy.SwitchRequest.SAVE_NOW, AppLockPolicy.relockRequest(10, 60, false))
  }

  @Test
  fun theSwitchResultCallsTheHandlerTheSpaRegisters() {
    assertEquals(
      "window.__ccLockSwitchResult&&window.__ccLockSwitchResult(true)",
      AppLockPolicy.switchResultJs(true),
    )
    assertEquals(
      "window.__ccLockSwitchResult&&window.__ccLockSwitchResult(false)",
      AppLockPolicy.switchResultJs(false),
    )
  }
}
