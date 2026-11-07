package com.sirbepy.conductor.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdatePolicyTest {
  @Test
  fun aPlayInstalledBuildChecksForUpdates() {
    assertTrue(AppUpdatePolicy.shouldCheck("com.android.vending"))
  }

  @Test
  fun aSideloadedBuildSkipsTheCheck() {
    assertFalse(AppUpdatePolicy.shouldCheck("com.google.android.packageinstaller"))
    assertFalse(AppUpdatePolicy.shouldCheck("com.android.shell"))
  }

  @Test
  fun anUnknownInstallerSkipsTheCheck() {
    assertFalse(AppUpdatePolicy.shouldCheck(null))
    assertFalse(AppUpdatePolicy.shouldCheck(""))
  }

  @Test
  fun anInstallerNamedLikePlayButNotPlayIsRefused() {
    assertFalse(AppUpdatePolicy.shouldCheck("com.android.vending.evil"))
    assertFalse(AppUpdatePolicy.shouldCheck("COM.ANDROID.VENDING"))
  }
}
