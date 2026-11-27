package com.sirbepy.conductor.mobile

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RecordingStoreTest {
  private lateinit var root: File
  private lateinit var dir: File
  private lateinit var indexFile: File
  private var ids = 0
  private var now = 1_000L

  @Before
  fun setUp() {
    root = Files.createTempDirectory("voicestore").toFile()
    dir = File(root, "audio").also { it.mkdirs() }
    indexFile = File(root, "index.json")
    ids = 0
    now = 1_000L
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  private fun store() = RecordingStore(dir, indexFile, clock = { now }, newId = { "id${++ids}" })

  private fun part(name: String, text: String = "audio"): File =
    File(dir, "$name.opus.part").apply { writeText(text) }

  // SHA-256 of the ASCII text "abc".
  private val abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  @Test
  fun beginWritesARecordingRowThatSurvivesAReload() {
    val p = part("2026-11-26_10-00-00")
    val row = store().begin(p, 5_000L)
    assertEquals(RecordingState.RECORDING, row.state)

    val again = store().list()
    assertEquals(1, again.size)
    assertEquals("2026-11-26_10-00-00.opus.part", again[0].file)
    assertEquals(5_000L, again[0].recordedAtMs)
  }

  @Test
  fun completeRecordsSizeAndSha256AndMovesToSaved() {
    val s = store()
    val p = part("2026-11-26_10-00-00", "abc")
    val row = s.begin(p)
    val final = RecordingFiles.finalize(p)!!
    val saved = s.complete(row.id, final, 61_000L, null)!!

    assertEquals(RecordingState.SAVED, saved.state)
    assertEquals("2026-11-26_10-00-00.opus", saved.file)
    assertEquals(3L, saved.sizeBytes)
    assertEquals(abcHash, saved.sha256)
    assertEquals(61_000L, saved.durationMs)
    assertNull(saved.error)
    assertEquals(saved, store().get(row.id))
  }

  @Test
  fun completeKeepsTheReasonARecordingEndedEarly() {
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    val saved = s.complete(row.id, RecordingFiles.finalize(p)!!, 1_000L, "Recording stopped: storage is full")!!
    assertEquals(RecordingState.SAVED, saved.state)
    assertEquals("Recording stopped: storage is full", saved.error)
  }

  @Test
  fun aRecordingWithNoAudioLeavesNoRow() {
    val s = store()
    val p = File(dir, "a.opus.part").apply { createNewFile() }
    val row = s.begin(p)
    assertNull(RecordingFiles.finalize(p))
    s.abandon(row.id)
    assertTrue(s.list().isEmpty())
    assertTrue(store().list().isEmpty())
  }

  @Test
  fun crashRecoveryFinishesALeftBehindPart() {
    val p = part("2026-11-26_10-00-00", "abc")
    store().begin(p)
    // The process died: a fresh store (a new process) sees a RECORDING row.
    val after = store()
    after.reconcile()

    val rows = after.list()
    assertEquals(1, rows.size)
    assertEquals(RecordingState.SAVED, rows[0].state)
    assertEquals("2026-11-26_10-00-00.opus", rows[0].file)
    assertEquals(abcHash, rows[0].sha256)
    assertNotNull(rows[0].error)
    assertFalse(p.exists())
    assertTrue(File(dir, "2026-11-26_10-00-00.opus").exists())
  }

  @Test
  fun crashRecoveryLeavesTheLiveRecordingAlone() {
    val s = store()
    val live = part("live", "partial")
    s.begin(live)
    s.reconcile()
    assertEquals(RecordingState.RECORDING, s.list()[0].state)
    assertTrue(live.exists())
  }

  @Test
  fun aRecordingThatFinishesAfterReconcileStartsStillCompletesOnce() {
    // finishRecording renames the part and queues complete() after reconcile ran
    // on the same thread: the rename and the row must end up as one row.
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    s.reconcile()
    val final = RecordingFiles.finalize(p)!!
    s.reconcile()
    s.complete(row.id, final, 0L, null)
    assertEquals(1, s.list().size)
    assertEquals("a.opus", s.list()[0].file)
    assertEquals(RecordingState.SAVED, s.list()[0].state)
  }

  @Test
  fun aFailedRenameKeepsTheRowAndTheAudioForNextTime() {
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    s.release(row.id)
    // The part is still on disk (rename failed): a new process recovers it.
    assertEquals(RecordingState.RECORDING, s.get(row.id)!!.state)
    val after = store()
    after.reconcile()
    assertEquals("a.opus", after.list()[0].file)
    assertEquals(RecordingState.SAVED, after.list()[0].state)
  }

  @Test
  fun crashRecoveryHandlesARenameThatHappenedBeforeTheRowUpdate() {
    val s = store()
    val p = part("a", "abc")
    s.begin(p)
    RecordingFiles.finalize(p)
    val after = store()
    after.reconcile()
    assertEquals("a.opus", after.list()[0].file)
    assertEquals(RecordingState.SAVED, after.list()[0].state)
  }

  @Test
  fun recoveryDropsARowWhoseAudioNeverReachedTheDisk() {
    val p = File(dir, "a.opus.part").apply { createNewFile() }
    store().begin(p)
    val after = store()
    after.reconcile()
    assertTrue(after.list().isEmpty())
  }

  @Test
  fun recoveryNeverDeletesRealAudio() {
    val a = part("a", "abc")
    store().begin(a)
    File(dir, "b.opus").writeText("keep")
    val after = store()
    after.reconcile()
    assertEquals(setOf("a.opus", "b.opus"), dir.listFiles()!!.map { it.name }.toSet())
    assertEquals("keep", File(dir, "b.opus").readText())
  }

  @Test
  fun audioNoRowKnowsAboutIsAdoptedAsSaved() {
    File(dir, "2026-11-20_08-00-00.opus").writeText("abc")
    part("2026-11-20_09-00-00", "abc")
    val s = store()
    s.reconcile()

    val files = s.list().map { it.file }.sorted()
    assertEquals(listOf("2026-11-20_08-00-00.opus", "2026-11-20_09-00-00.opus"), files)
    assertTrue(s.list().all { it.state == RecordingState.SAVED && it.sha256 == abcHash })
  }

  @Test
  fun reconcileTwiceAddsNothing() {
    File(dir, "x.opus").writeText("abc")
    val s = store()
    s.reconcile()
    s.reconcile()
    assertEquals(1, s.list().size)
  }

  @Test
  fun aCorruptIndexIsKeptAsBadAndRebuiltFromTheFolder() {
    File(dir, "x.opus").writeText("abc")
    indexFile.writeText("{ not json")
    val s = store()
    s.reconcile()

    assertEquals(1, s.list().size)
    assertEquals("{ not json", File(root, "index.json.bad").readText())
  }

  @Test
  fun aSecondCorruptIndexDoesNotOverwriteTheFirstBadCopy() {
    File(root, "index.json.bad").writeText("first")
    indexFile.writeText("second")
    store().list()
    assertEquals("first", File(root, "index.json.bad").readText())
    assertEquals("second", File(root, "index.json.bad1").readText())
  }

  @Test
  fun writingTheIndexLeavesNoTempFile() {
    store().begin(part("a"))
    assertFalse(File(root, "index.json.tmp").exists())
    assertTrue(indexFile.exists())
  }

  @Test
  fun listIsNewestFirst() {
    val s = store()
    s.begin(part("old"), 1_000L)
    s.begin(part("new"), 9_000L)
    assertEquals(listOf("new.opus.part", "old.opus.part"), s.list().map { it.file })
  }

  @Test
  fun uploadLifecycleWalksTheStates() {
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    s.complete(row.id, RecordingFiles.finalize(p)!!, 0L, null)

    assertEquals(RecordingState.QUEUED, s.transition(row.id, RecordingState.QUEUED)!!.state)
    assertEquals(RecordingState.UPLOADING, s.transition(row.id, RecordingState.UPLOADING)!!.state)
    assertEquals(2L, s.setProgress(row.id, 2L)!!.bytesUploaded)
    assertEquals(3L, s.setProgress(row.id, 999L)!!.bytesUploaded)
    val up = s.transition(row.id, RecordingState.UPLOADED)!!
    assertEquals(3L, up.bytesUploaded)
    assertEquals(RecordingState.TRANSCRIBED, s.transition(row.id, RecordingState.TRANSCRIBED)!!.state)
  }

  @Test
  fun illegalMovesAreRefused() {
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    // Still recording: only complete() may leave it.
    assertNull(s.transition(row.id, RecordingState.SAVED))
    s.complete(row.id, RecordingFiles.finalize(p)!!, 0L, null)
    assertNull(s.transition(row.id, RecordingState.UPLOADED))
    assertNull(s.transition(row.id, RecordingState.TRANSCRIBED))
    assertNull(s.setProgress(row.id, 1L))
    assertNull(s.transition("nope", RecordingState.QUEUED))
    assertEquals(RecordingState.SAVED, s.get(row.id)!!.state)
  }

  @Test
  fun aFailedUploadKeepsItsErrorAndCanBeRetried() {
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    s.complete(row.id, RecordingFiles.finalize(p)!!, 0L, null)
    s.transition(row.id, RecordingState.QUEUED)
    s.transition(row.id, RecordingState.UPLOADING)
    s.setProgress(row.id, 2L)
    val failed = s.transition(row.id, RecordingState.FAILED, "tunnel dropped")!!
    assertEquals("tunnel dropped", failed.error)
    // Progress stays, so the uploader can ask the PC where to resume.
    assertEquals(2L, failed.bytesUploaded)

    val retried = s.transition(row.id, RecordingState.QUEUED)!!
    assertNull(retried.error)
  }

  @Test
  fun theUploadStateSurvivesARestart() {
    val s = store()
    val p = part("a", "abc")
    val row = s.begin(p)
    s.complete(row.id, RecordingFiles.finalize(p)!!, 0L, null)
    s.transition(row.id, RecordingState.QUEUED)
    s.transition(row.id, RecordingState.UPLOADING)
    s.setProgress(row.id, 1L)

    val again = store().get(row.id)!!
    assertEquals(RecordingState.UPLOADING, again.state)
    assertEquals(1L, again.bytesUploaded)
  }

  @Test
  fun aStateThisBuildDoesNotKnowReadsAsSaved() {
    val row = JSONObject().put("id", "x").put("file", "x.opus").put("state", "archived")
    assertEquals(RecordingState.SAVED, Recording.fromJson(row).state)
  }

  @Test
  fun listenersHearEveryChange() {
    val s = store()
    var heard = 0
    s.addListener { heard++ }
    val p = part("a", "abc")
    val row = s.begin(p)
    s.complete(row.id, RecordingFiles.finalize(p)!!, 0L, null)
    s.transition(row.id, RecordingState.QUEUED)
    assertEquals(3, heard)
  }
}
