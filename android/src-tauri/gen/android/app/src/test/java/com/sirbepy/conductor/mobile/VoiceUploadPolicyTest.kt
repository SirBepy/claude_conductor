package com.sirbepy.conductor.mobile

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class VoiceUploadPolicyTest {
  private lateinit var root: File
  private lateinit var dir: File
  private var ids = 0
  private var now = 1_000L

  @Before
  fun setUp() {
    root = Files.createTempDirectory("voiceupload").toFile()
    dir = File(root, "audio").also { it.mkdirs() }
    ids = 0
    now = 1_000L
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  private fun store() = RecordingStore(dir, File(root, "index.json"), clock = { now }, newId = { "id${++ids}" })

  private fun saved(s: RecordingStore, name: String, text: String = "abc", at: Long = now): Recording {
    val part = File(dir, "$name.opus.part").apply { writeText(text) }
    val row = s.begin(part, at)
    val done = File(dir, "$name.opus")
    part.renameTo(done)
    return s.complete(row.id, done, 3_000L, null)!!
  }

  @Test
  fun claimQueuesSavedRecordingsAndListsThemOldestFirst() {
    val s = store()
    val newer = saved(s, "b", at = 2_000L)
    val older = saved(s, "a", at = 1_500L)
    val jobs = VoiceUploadPolicy.claim(s, dir).getJSONArray("jobs")
    assertEquals(2, jobs.length())
    assertEquals(older.id, jobs.getJSONObject(0).getString("id"))
    assertEquals(newer.id, jobs.getJSONObject(1).getString("id"))
    assertEquals(File(dir, "a.opus").absolutePath, jobs.getJSONObject(0).getString("path"))
    assertEquals(RecordingState.QUEUED, s.get(older.id)!!.state)
    assertEquals(3L, jobs.getJSONObject(0).getLong("sizeBytes"))
  }

  @Test
  fun claimLeavesDoneAndFailedRowsAloneButResumesAnInterruptedUpload() {
    val s = store()
    val a = saved(s, "a")
    val b = saved(s, "b")
    val c = saved(s, "c")
    s.transition(a.id, RecordingState.QUEUED)
    s.transition(a.id, RecordingState.UPLOADED)
    s.transition(b.id, RecordingState.QUEUED)
    s.transition(b.id, RecordingState.FAILED, "x")
    s.transition(c.id, RecordingState.QUEUED)
    s.transition(c.id, RecordingState.UPLOADING)
    val jobs = VoiceUploadPolicy.claim(s, dir).getJSONArray("jobs")
    assertEquals(1, jobs.length())
    assertEquals(c.id, jobs.getJSONObject(0).getString("id"))
    assertEquals(RecordingState.FAILED, s.get(b.id)!!.state)
  }

  @Test
  fun aWholeUploadWalksQueuedUploadingUploaded() {
    val s = store()
    val r = saved(s, "a")
    VoiceUploadPolicy.claim(s, dir)
    assertTrue(VoiceUploadPolicy.mark(s, r.id, "uploading", 1L, null))
    assertEquals(RecordingState.UPLOADING, s.get(r.id)!!.state)
    assertEquals(1L, s.get(r.id)!!.bytesUploaded)
    // A second progress report while already uploading just moves the counter.
    assertTrue(VoiceUploadPolicy.mark(s, r.id, "uploading", 2L, null))
    assertEquals(2L, s.get(r.id)!!.bytesUploaded)
    assertTrue(VoiceUploadPolicy.mark(s, r.id, "uploaded", 0L, null))
    assertEquals(RecordingState.UPLOADED, s.get(r.id)!!.state)
    assertEquals(3L, s.get(r.id)!!.bytesUploaded)
    // A repeat of the final mark (the uploader retrying a lost reply) is not an error.
    assertTrue(VoiceUploadPolicy.mark(s, r.id, "uploaded", 0L, null))
  }

  @Test
  fun aDroppedTunnelRequeuesAndKeepsTheProgress() {
    val s = store()
    val r = saved(s, "a")
    VoiceUploadPolicy.claim(s, dir)
    VoiceUploadPolicy.mark(s, r.id, "uploading", 2L, null)
    assertTrue(VoiceUploadPolicy.mark(s, r.id, "queued", 0L, null))
    assertEquals(RecordingState.QUEUED, s.get(r.id)!!.state)
    assertEquals(2L, s.get(r.id)!!.bytesUploaded)
    assertEquals(1, VoiceUploadPolicy.claim(s, dir).getJSONArray("jobs").length())
  }

  @Test
  fun aRefusedUploadFailsWithItsReasonAndIsNotClaimedAgain() {
    val s = store()
    val r = saved(s, "a")
    VoiceUploadPolicy.claim(s, dir)
    assertTrue(VoiceUploadPolicy.mark(s, r.id, "failed", 0L, "The PC refused it"))
    assertEquals("The PC refused it", s.get(r.id)!!.error)
    assertEquals(0, VoiceUploadPolicy.claim(s, dir).getJSONArray("jobs").length())
  }

  @Test
  fun unknownRowsAndStatesAreRefused() {
    val s = store()
    val r = saved(s, "a")
    assertFalse(VoiceUploadPolicy.mark(s, "nope", "uploaded", 0L, null))
    assertFalse(VoiceUploadPolicy.mark(s, r.id, "sideways", 0L, null))
    // A progress report for a row that was never claimed does not skip the queue.
    assertFalse(VoiceUploadPolicy.mark(s, r.id, "uploading", 1L, null))
  }

  @Test
  fun captureOnlyTrustsALoopbackOriginWithATokenAndAPort() {
    // evaluateJavascript returns the JS string value JSON-encoded, so the payload is quoted and escaped.
    fun js(token: String?, port: String, host: String): String {
      val t = if (token == null) "null" else "\\\"$token\\\""
      return "\"{\\\"token\\\":$t,\\\"port\\\":\\\"$port\\\",\\\"host\\\":\\\"$host\\\"}\""
    }
    val ok = UploadAuthPolicy.parseCapture(js("tok", "40123", "127.0.0.1"))
    assertNotNull(ok)
    assertEquals("tok", ok!!.token)
    assertEquals(40123, ok.port)
    assertNull(UploadAuthPolicy.parseCapture(js("tok", "40123", "evil.example")))
    assertNull(UploadAuthPolicy.parseCapture(js(null, "40123", "127.0.0.1")))
    assertNull(UploadAuthPolicy.parseCapture(js("", "40123", "127.0.0.1")))
    assertNull(UploadAuthPolicy.parseCapture(js("tok", "", "127.0.0.1")))
    assertNull(UploadAuthPolicy.parseCapture(js("tok", "70000", "127.0.0.1")))
    assertNull(UploadAuthPolicy.parseCapture("null"))
    assertNull(UploadAuthPolicy.parseCapture(null))
    assertNull(UploadAuthPolicy.parseCapture("not json"))
  }

  @Test
  fun theStoredLoginSurvivesAReloadAndRewritingTheSameOneIsANoOp() {
    val file = File(root, "auth/voice-upload-auth.json")
    val store = UploadAuthStore(file)
    assertNull(store.load())
    assertTrue(store.save(UploadAuth("tok", 40123)))
    assertFalse(store.save(UploadAuth("tok", 40123)))
    val back = UploadAuthStore(file).load()!!
    assertEquals("tok", back.token)
    assertEquals(40123, back.port)
    assertTrue(store.save(UploadAuth("tok2", 40124)))
    assertEquals(40124, UploadAuthStore(file).load()!!.port)
    assertEquals("tok2", UploadAuthPolicy.toJson(UploadAuthStore(file).load()).getString("token"))
    assertEquals(0, UploadAuthPolicy.toJson(null).length())
  }

  @Test
  fun aCorruptLoginFileReadsAsNoLogin() {
    val file = File(root, "voice-upload-auth.json").apply { writeText("{half") }
    assertNull(UploadAuthStore(file).load())
  }
}
