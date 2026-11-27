package com.sirbepy.conductor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceEntryPolicyTest {
  private val idle = RecorderState.Status.IDLE

  @Test
  fun shellUrlNamesOnlyKnownScreens() {
    assertEquals("http://tauri.localhost/#voice=recorder", VoiceEntryPolicy.shellUrl("recorder"))
    assertEquals("http://tauri.localhost/#voice=list", VoiceEntryPolicy.shellUrl("list"))
    assertEquals("http://tauri.localhost/#voice=home", VoiceEntryPolicy.shellUrl(null))
    // A name from a page is never put into the URL.
    assertEquals("http://tauri.localhost/#voice=home", VoiceEntryPolicy.shellUrl("x&evil=1"))
  }

  @Test
  fun tileStopsWhateverTheOtherConditions() {
    for (status in listOf(RecorderState.Status.RECORDING, RecorderState.Status.PAUSED)) {
      assertEquals(VoiceEntryPolicy.TileAction.STOP, VoiceEntryPolicy.tileAction(28, status, false))
    }
  }

  @Test
  fun tileStartsOnlyWithTheMicrophone() {
    assertEquals(VoiceEntryPolicy.TileAction.START, VoiceEntryPolicy.tileAction(34, idle, true))
    assertEquals(VoiceEntryPolicy.TileAction.ASK_IN_APP, VoiceEntryPolicy.tileAction(34, idle, false))
    assertEquals(VoiceEntryPolicy.TileAction.UNSUPPORTED, VoiceEntryPolicy.tileAction(28, idle, true))
  }

  @Test
  fun tileIsLitWhileRecordingOrPaused() {
    assertFalse(VoiceEntryPolicy.tileActive(idle))
    assertTrue(VoiceEntryPolicy.tileActive(RecorderState.Status.RECORDING))
    assertTrue(VoiceEntryPolicy.tileActive(RecorderState.Status.PAUSED))
  }

  @Test
  fun quickStartNotificationOnlyWhenIdleSupportedAndAllowed() {
    assertTrue(VoiceEntryPolicy.quickStartWanted(34, idle, true))
    assertFalse(VoiceEntryPolicy.quickStartWanted(34, idle, false))
    assertFalse(VoiceEntryPolicy.quickStartWanted(28, idle, true))
    assertFalse(VoiceEntryPolicy.quickStartWanted(34, RecorderState.Status.RECORDING, true))
  }

  @Test
  fun openExtraIsHeldWhileLocked() {
    assertEquals(VoiceEntryPolicy.OpenAction.NONE, VoiceEntryPolicy.openAction(null, false))
    assertEquals(VoiceEntryPolicy.OpenAction.HOLD, VoiceEntryPolicy.openAction("record", true))
    assertEquals(VoiceEntryPolicy.OpenAction.OPEN, VoiceEntryPolicy.openAction("record", false))
  }
}
