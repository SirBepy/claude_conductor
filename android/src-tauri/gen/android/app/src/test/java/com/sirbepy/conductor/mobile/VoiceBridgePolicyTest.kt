package com.sirbepy.conductor.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceBridgePolicyTest {
  private val idle = RecorderState.Status.IDLE
  private val recording = RecorderState.Status.RECORDING

  private fun decide(
    sdk: Int = 34,
    status: RecorderState.Status = idle,
    mic: Boolean = true,
    locked: Boolean = false,
  ) = VoiceBridgePolicy.startDecision(sdk, status, mic, locked)

  @Test
  fun anIdleUnlockedPhoneWithTheMicStarts() {
    assertEquals(VoiceBridgePolicy.StartDecision.START, decide())
  }

  @Test
  fun withoutTheMicTheBridgeAsksFirst() {
    assertEquals(VoiceBridgePolicy.StartDecision.NEEDS_PERMISSION, decide(mic = false))
  }

  @Test
  fun aSecondStartDuringARecordingIsHarmless() {
    assertEquals(VoiceBridgePolicy.StartDecision.ALREADY_RECORDING, decide(status = recording))
    assertEquals(VoiceBridgePolicy.StartDecision.ALREADY_RECORDING, decide(status = RecorderState.Status.PAUSED))
  }

  @Test
  fun theAppLockBlocksAStartFromAPage() {
    assertEquals(VoiceBridgePolicy.StartDecision.LOCKED, decide(locked = true))
  }

  @Test
  fun androidNineCannotRecordOgg() {
    assertEquals(VoiceBridgePolicy.StartDecision.UNSUPPORTED, decide(sdk = 28))
  }

  @Test
  fun startReplyIsOkOnlyWhenARecordingRunsOrWillRun() {
    fun ok(d: VoiceBridgePolicy.StartDecision) = JSONObject(VoiceBridgePolicy.startReply(d)).getBoolean("ok")
    assertTrue(ok(VoiceBridgePolicy.StartDecision.START))
    assertTrue(ok(VoiceBridgePolicy.StartDecision.ALREADY_RECORDING))
    assertFalse(ok(VoiceBridgePolicy.StartDecision.LOCKED))
    assertFalse(ok(VoiceBridgePolicy.StartDecision.UNSUPPORTED))
    assertEquals(
      "permission_requested",
      JSONObject(VoiceBridgePolicy.startReply(VoiceBridgePolicy.StartDecision.NEEDS_PERMISSION)).getString("result"),
    )
  }

  @Test
  fun stateJsonCarriesWhatThePageNeeds() {
    val json = JSONObject(VoiceBridgePolicy.stateJson(recording, "id1", 5_000L, null, true, 34))
    assertEquals(2, json.getInt("bridgeVersion"))
    assertEquals("recording", json.getString("status"))
    assertEquals("id1", json.getString("recordingId"))
    assertEquals(5_000L, json.getLong("elapsedMs"))
    assertTrue(json.isNull("error"))
    assertTrue(json.getBoolean("micPermission"))
    assertTrue(json.getBoolean("supported"))
  }

  @Test
  fun stateJsonShowsAFailureWhileIdle() {
    val json = JSONObject(VoiceBridgePolicy.stateJson(idle, null, 0L, "storage is full", true, 34))
    assertEquals("idle", json.getString("status"))
    assertTrue(json.isNull("recordingId"))
    assertEquals("storage is full", json.getString("error"))
  }

  @Test
  fun listJsonIsAnArrayOfRowsWithEveryIndexField() {
    val row = Recording("id1", "a.opus", 3L, "abc", 10L, 20L, RecordingState.SAVED, 0L, null)
    val arr = org.json.JSONArray(VoiceBridgePolicy.listJson(listOf(row)))
    assertEquals(1, arr.length())
    val o = arr.getJSONObject(0)
    for (key in listOf("id", "file", "sizeBytes", "sha256", "recordedAtMs", "durationMs", "state", "bytesUploaded", "error")) {
      assertTrue("missing $key", o.has(key))
    }
    assertEquals("saved", o.getString("state"))
  }
}
