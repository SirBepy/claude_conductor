package com.sirbepy.conductor.mobile

import java.io.File
import java.nio.file.Files
import java.util.TimeZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RecordingFilesTest {
  private lateinit var dir: File
  private val utc = TimeZone.getTimeZone("UTC")

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("voicenotes").toFile()
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun baseNameIsSortableAndWindowsSafe() {
    // 2026-11-26 18:05:09 UTC
    val name = RecordingFiles.baseName(1_795_716_309_000L, utc)
    assertEquals("2026-11-26_18-05-09", name)
    assertFalse(name.any { it in "<>:\"/\\|?*" })
  }

  @Test
  fun newRecordingStartsAsPartFile() {
    val part = RecordingFiles.newPartFile(dir, 1_795_716_309_000L, utc)
    assertEquals("2026-11-26_18-05-09.opus.part", part.name)
    assertTrue(RecordingFiles.isPart(part))
  }

  @Test
  fun sameSecondGetsDistinctNames() {
    val first = RecordingFiles.newPartFile(dir, 1_795_716_309_000L, utc)
    first.writeText("x")
    val second = RecordingFiles.newPartFile(dir, 1_795_716_309_000L, utc)
    assertEquals("2026-11-26_18-05-09_2.opus.part", second.name)
  }

  @Test
  fun finalizeRenamesPartAndLeavesNoPartBehind() {
    val part = RecordingFiles.newPartFile(dir, 1_795_716_309_000L, utc)
    part.writeText("audio")
    val done = RecordingFiles.finalize(part)
    assertNotNull(done)
    assertEquals("2026-11-26_18-05-09.opus", done!!.name)
    assertEquals("audio", done.readText())
    assertFalse(part.exists())
  }

  @Test
  fun finalizeNeverOverwritesAnExistingRecording() {
    File(dir, "2026-11-26_18-05-09.opus").writeText("old")
    val part = File(dir, "2026-11-26_18-05-09.opus.part")
    part.writeText("new")
    val done = RecordingFiles.finalize(part)!!
    assertEquals("2026-11-26_18-05-09_2.opus", done.name)
    assertEquals("old", File(dir, "2026-11-26_18-05-09.opus").readText())
  }

  @Test
  fun emptyPartIsDroppedNotKept() {
    val part = File(dir, "a.opus.part")
    part.createNewFile()
    assertNull(RecordingFiles.finalize(part))
    assertFalse(part.exists())
  }

  @Test
  fun orphansAreFinishedButTheActivePartIsLeftAlone() {
    val orphan = File(dir, "2026-11-26_10-00-00.opus.part").apply { writeText("a") }
    val active = File(dir, "2026-11-26_11-00-00.opus.part").apply { writeText("b") }
    val recovered = RecordingFiles.recoverOrphans(dir, active)
    assertEquals(listOf("2026-11-26_10-00-00.opus"), recovered.map { it.name })
    assertFalse(orphan.exists())
    assertTrue(active.exists())
  }

  @Test
  fun finishedListsNewestFirstAndSkipsParts() {
    File(dir, "2026-11-26_10-00-00.opus").writeText("a")
    File(dir, "2026-11-27_09-00-00.opus").writeText("b")
    File(dir, "2026-11-28_09-00-00.opus.part").writeText("c")
    assertEquals(
      listOf("2026-11-27_09-00-00.opus", "2026-11-26_10-00-00.opus"),
      RecordingFiles.finished(dir).map { it.name },
    )
  }

  @Test
  fun finalNameOfStripsOnlyThePartSuffix() {
    assertEquals("2026-11-26_18-05-09.opus", RecordingFiles.finalNameOf("2026-11-26_18-05-09.opus.part"))
  }
}
