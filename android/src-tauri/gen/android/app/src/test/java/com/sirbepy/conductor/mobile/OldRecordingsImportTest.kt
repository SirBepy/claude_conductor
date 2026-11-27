package com.sirbepy.conductor.mobile

import java.io.File
import java.nio.file.Files
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OldRecordingsImportTest {
  private lateinit var root: File
  private lateinit var source: File
  private lateinit var dir: File
  private lateinit var store: RecordingStore
  private lateinit var ledger: ImportLedger
  private val utc = TimeZone.getTimeZone("UTC")
  private var ids = 0

  @Before
  fun setUp() {
    root = Files.createTempDirectory("old-import").toFile()
    source = File(root, "VoiceNotes").also { it.mkdirs() }
    dir = File(root, "voice-notes").also { it.mkdirs() }
    store = RecordingStore(dir, File(root, "index.json"), clock = { 1_000L }, newId = { "id${++ids}" })
    ledger = ImportLedger(File(root, "ledger.json"))
  }

  private fun old(name: String, text: String, modified: Long = 1_700_000_000_000L): File =
    File(source, name).also {
      it.writeText(text)
      it.setLastModified(modified)
    }

  private fun run() = OldRecordingsImport.run(source, dir, store, ledger, utc, nowMs = 5_000L)

  @Test
  fun copiesEveryOpusFileIntoTheIndexAndLeavesTheSourceAlone() {
    old("2026-03-04_05-06-07.opus", "first")
    old("2026-03-05_05-06-07.opus", "second")
    old("notes.txt", "not audio")

    val result = run()

    assertTrue(result.readable)
    assertEquals(2, result.found)
    assertEquals(2, result.imported)
    assertEquals(0, result.failed)
    assertEquals(2, store.list().size)
    assertTrue(store.list().all { it.state == RecordingState.SAVED && !it.sha256.isNullOrEmpty() })
    // Read only: both originals are still there, byte for byte.
    assertEquals("first", File(source, "2026-03-04_05-06-07.opus").readText())
    assertEquals(3, source.listFiles()!!.size)
    // The copies sit in the recordings folder under the file's own time.
    assertTrue(File(dir, "2026-03-04_05-06-07.opus").exists())
    assertEquals(0, dir.listFiles { f -> f.name.endsWith(OldRecordingsImport.TEMP_SUFFIX) }!!.size)
  }

  @Test
  fun theRecordedTimeComesFromTheFilenameElseTheFileTime() {
    old("2026-03-04_05-06-07.opus", "dated")
    old("voice memo.opus", "undated", modified = 1_650_000_000_000L)

    run()

    val byFile = store.list().associateBy { it.file }
    val dated = byFile.getValue("2026-03-04_05-06-07.opus")
    assertEquals(
      java.text.SimpleDateFormat("yyyy-MM-dd_HH-mm-ss").also { it.timeZone = utc }.parse("2026-03-04_05-06-07")!!.time,
      dated.recordedAtMs,
    )
    val undated = store.list().first { it.file != "2026-03-04_05-06-07.opus" }
    assertEquals(1_650_000_000_000L, undated.recordedAtMs)
  }

  @Test
  fun aSecondRunAddsNothingAndANewFileIsPickedUp() {
    old("a.opus", "one")
    assertEquals(1, run().imported)

    val again = run()
    assertEquals(0, again.imported)
    assertEquals(1, again.skipped)
    assertEquals(1, store.list().size)

    old("b.opus", "two")
    assertEquals(1, run().imported)
    assertEquals(2, store.list().size)
  }

  @Test
  fun aRecordingThePhoneAlreadyHoldsIsNotAddedTwice() {
    val same = old("a.opus", "identical bytes")
    // The recorder's own copy, same bytes, other name.
    val own = File(dir, "mine.opus").also { it.writeText("identical bytes") }
    assertNotNull(store.addImported(own, 1L, RecordingStore.sha256Of(own)))

    val result = run()

    assertEquals(0, result.imported)
    assertEquals(1, result.skipped)
    assertEquals(1, store.list().size)
    assertTrue(same.exists())
  }

  @Test
  fun anOldFileNamedLikeARecordingTheAppHoldsKeepsBothCopies() {
    val mine = File(dir, "2026-03-04_05-06-07.opus").also { it.writeText("recorded here") }
    store.addImported(mine, 1L, RecordingStore.sha256Of(mine))
    old("2026-03-04_05-06-07.opus", "recorded elsewhere")

    val result = run()

    assertEquals(1, result.imported)
    assertEquals("recorded here", mine.readText())
    assertEquals(2, store.list().map { it.file }.toSet().size)
  }

  @Test
  fun anUnlistableFolderIsNotDoneAndNothingIsRecorded() {
    val result = OldRecordingsImport.run(File(root, "missing"), dir, store, ledger, utc)

    assertFalse(result.readable)
    assertFalse(ledger.load().done)
    assertEquals(0, store.list().size)
  }

  @Test
  fun aFileTheOldAppMayStillBeWritingWaitsForALaterRun() {
    // The test clock says 5_000 ms, so a file stamped 1_000 ms was touched 4 s ago.
    old("live.opus", "growing", modified = 1_000L)
    old("old.opus", "finished", modified = 1_700_000_000_000L)

    val first = run()

    assertEquals(1, first.imported)
    assertEquals(1, store.list().size)
    assertFalse("a waiting file keeps the import open", ledger.load().done)

    // A minute later it is settled and comes in.
    val later = OldRecordingsImport.run(source, dir, store, ledger, utc, nowMs = 5_000L + OldRecordingsImport.STILL_WRITING_MS)
    assertEquals(1, later.imported)
    assertTrue(ledger.load().done)
    assertEquals(2, store.list().size)
  }

  @Test
  fun anEmptyFolderIsDoneAfterOneReadableRun() {
    val result = run()

    assertTrue(result.readable)
    assertEquals(0, result.found)
    assertTrue(ledger.load().done)
  }

  @Test
  fun aFailedCopyLeavesTheRunNotDoneAndTheFileForTheNextRun() {
    old("empty.opus", "")
    old("good.opus", "audio")

    val first = run()

    // An empty source is refused (nothing to transcribe) and kept for a rerun.
    assertEquals(1, first.imported)
    assertEquals(1, first.failed)
    assertFalse(ledger.load().done)

    File(source, "empty.opus").writeText("now has audio")
    val second = run()
    assertEquals(1, second.imported)
    assertTrue(ledger.load().done)
    assertEquals(2, store.list().size)
  }

  @Test
  fun aLeftoverTempCopyFromAKilledRunIsRemovedAndNeverAdopted() {
    old("a.opus", "one")
    val stale = File(dir, "import-stale.importing").also { it.writeText("half") }

    run()

    assertFalse(stale.exists())
    assertEquals(1, store.list().size)
  }

  @Test
  fun anUnreadableLedgerIsNotAnError() {
    File(root, "ledger.json").writeText("{not json")
    old("a.opus", "one")

    assertEquals(1, run().imported)
  }

  @Test
  fun markAskedKeepsWhatTheLedgerHolds() {
    old("a.opus", "one")
    run()

    ledger.markAsked()

    val state = ledger.load()
    assertTrue(state.asked)
    assertTrue(state.done)
    assertEquals(1, state.keys.size)
    assertEquals(1, state.lastImported)
  }

  @Test
  fun theStoragePermissionFollowsTheAndroidVersion() {
    assertEquals("android.permission.READ_MEDIA_AUDIO", OldRecordingsImport.permissionFor(33))
    assertEquals("android.permission.READ_MEDIA_AUDIO", OldRecordingsImport.permissionFor(35))
    assertEquals("android.permission.READ_EXTERNAL_STORAGE", OldRecordingsImport.permissionFor(32))
    assertEquals("android.permission.READ_EXTERNAL_STORAGE", OldRecordingsImport.permissionFor(29))
  }

  @Test
  fun anImportedRowUploadsLikeAnyOther() {
    old("a.opus", "one")
    run()

    val jobs = VoiceUploadPolicy.claim(store, dir).getJSONArray("jobs")

    assertEquals(1, jobs.length())
    // The copy is named for its recorded time, not for the old file's name.
    val path = File(jobs.getJSONObject(0).getString("path"))
    assertEquals(store.list().single().file, path.name)
    assertEquals(dir, path.parentFile)
    assertEquals("one", path.readText())
  }

  @Test
  fun addImportedRefusesAFileAlreadyInTheIndex() {
    val f = File(dir, "x.opus").also { it.writeText("x") }
    assertNotNull(store.addImported(f, 1L, "abc"))
    assertNull(store.addImported(f, 1L, "abc"))
  }
}

class VoiceTranscriptSyncTest {
  private lateinit var root: File
  private lateinit var dir: File
  private lateinit var store: RecordingStore
  private var ids = 0

  @Before
  fun setUp() {
    root = Files.createTempDirectory("transcribed").toFile()
    dir = File(root, "voice-notes").also { it.mkdirs() }
    store = RecordingStore(dir, File(root, "index.json"), clock = { 1_000L }, newId = { "id${++ids}" })
  }

  private fun uploaded(name: String, sha: String?, at: Long): Recording {
    val f = File(dir, name).also { it.writeText(name) }
    val row = store.addImported(f, at, sha)!!
    store.transition(row.id, RecordingState.QUEUED)
    store.transition(row.id, RecordingState.UPLOADED)
    return store.get(row.id)!!
  }

  @Test
  fun awaitingListsUploadedRowsWithAHashOldestFirst() {
    val newer = uploaded("b.opus", "bbb", 20)
    val older = uploaded("a.opus", "aaa", 10)
    uploaded("c.opus", null, 5)
    val saved = File(dir, "d.opus").also { it.writeText("d") }
    store.addImported(saved, 1L, "ddd")

    val rows = VoiceUploadPolicy.awaiting(store).getJSONArray("rows")

    assertEquals(2, rows.length())
    assertEquals(older.id, rows.getJSONObject(0).getString("id"))
    assertEquals("aaa", rows.getJSONObject(0).getString("sha256"))
    assertEquals(newer.id, rows.getJSONObject(1).getString("id"))
  }

  @Test
  fun markTranscribedMovesAnUploadedRowAndRepeatsAreApplied() {
    val row = uploaded("a.opus", "aaa", 10)

    assertTrue(VoiceUploadPolicy.mark(store, row.id, "transcribed", 0, null))
    assertEquals(RecordingState.TRANSCRIBED, store.get(row.id)!!.state)
    assertTrue(VoiceUploadPolicy.mark(store, row.id, "transcribed", 0, null))
    // A transcribed row is no longer awaited, and a late "uploaded" does not undo it.
    assertTrue(VoiceUploadPolicy.mark(store, row.id, "uploaded", 0, null))
    assertEquals(RecordingState.TRANSCRIBED, store.get(row.id)!!.state)
    assertEquals(0, VoiceUploadPolicy.awaiting(store).getJSONArray("rows").length())
  }

  @Test
  fun markTranscribedIsRefusedForARowThatNeverUploaded() {
    val f = File(dir, "a.opus").also { it.writeText("a") }
    val row = store.addImported(f, 1L, "aaa")!!

    assertFalse(VoiceUploadPolicy.mark(store, row.id, "transcribed", 0, null))
    assertEquals(RecordingState.SAVED, store.get(row.id)!!.state)
    assertFalse(VoiceUploadPolicy.mark(store, "nope", "transcribed", 0, null))
  }
}

class VoiceImportBridgePolicyTest {
  private val fresh = ImportState()

  @Test
  fun importDecisionOrder() {
    val d = VoiceBridgePolicy::importDecision
    assertEquals(VoiceBridgePolicy.ImportDecision.LOCKED, d(true, false, true))
    assertEquals(VoiceBridgePolicy.ImportDecision.RUNNING, d(true, true, false))
    assertEquals(VoiceBridgePolicy.ImportDecision.NEEDS_PERMISSION, d(false, false, false))
    assertEquals(VoiceBridgePolicy.ImportDecision.START, d(true, false, false))
  }

  @Test
  fun importReplyIsOkOnlyWhenStartedOrRunning() {
    assertTrue(VoiceBridgePolicy.importReply(VoiceBridgePolicy.ImportDecision.START).contains("\"ok\":true"))
    assertTrue(VoiceBridgePolicy.importReply(VoiceBridgePolicy.ImportDecision.RUNNING).contains("\"ok\":true"))
    assertTrue(VoiceBridgePolicy.importReply(VoiceBridgePolicy.ImportDecision.NEEDS_PERMISSION).contains("\"ok\":false"))
    assertTrue(VoiceBridgePolicy.importReply(VoiceBridgePolicy.ImportDecision.LOCKED).contains("\"ok\":false"))
  }

  @Test
  fun theStartupCheckAsksOnceAndNeverAgainOnItsOwn() {
    val a = VoiceBridgePolicy::autoImport
    assertEquals(VoiceBridgePolicy.AutoImport.ASK, a(fresh, false, false, false))
    assertEquals(VoiceBridgePolicy.AutoImport.NOTHING, a(fresh.copy(asked = true), false, false, false))
    assertEquals(VoiceBridgePolicy.AutoImport.RUN, a(fresh, true, false, false))
    assertEquals(VoiceBridgePolicy.AutoImport.RUN, a(fresh.copy(asked = true), true, false, false))
  }

  @Test
  fun theStartupCheckDoesNothingWhenDoneRunningOrLocked() {
    val a = VoiceBridgePolicy::autoImport
    assertEquals(VoiceBridgePolicy.AutoImport.NOTHING, a(fresh.copy(done = true), true, false, false))
    assertEquals(VoiceBridgePolicy.AutoImport.NOTHING, a(fresh, true, true, false))
    assertEquals(VoiceBridgePolicy.AutoImport.NOTHING, a(fresh, false, false, true))
  }

  @Test
  fun importStatusJsonCarriesTheLedgerAndPermission() {
    val json = org.json.JSONObject(
      VoiceBridgePolicy.importStatusJson(ImportState(done = true, lastFound = 4, lastImported = 3), false, true),
    )
    assertTrue(json.getBoolean("done"))
    assertTrue(json.getBoolean("permission"))
    assertFalse(json.getBoolean("running"))
    assertEquals(4, json.getInt("found"))
    assertEquals(3, json.getInt("imported"))
  }
}
