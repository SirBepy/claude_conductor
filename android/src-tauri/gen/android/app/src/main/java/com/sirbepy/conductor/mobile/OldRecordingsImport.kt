package com.sirbepy.conductor.mobile

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

// One-time import of the stopgap recorder's folder (/storage/emulated/0/VoiceNotes)
// into the index, so those recordings upload and transcribe like new ones.
//
// Rules: the old files are only ever read, never moved or deleted; each is copied
// to a temp name and renamed into the recordings folder only once whole, so a kill
// mid-copy leaves nothing reconcile could take for a recording; a recording the
// phone already holds (same hash) is not added twice; the ledger remembers every
// file taken, so a rerun imports only what is new. Pure over its arguments (the
// folder, the store, the ledger), so it is unit-tested without Android.
object OldRecordingsImport {
  const val SOURCE_PATH = "/storage/emulated/0/VoiceNotes"
  const val TEMP_SUFFIX = ".importing"

  // A file modified this recently may still be being recorded by the old app.
  const val STILL_WRITING_MS = 60_000L

  class Result(
    // False when the folder could not be listed (missing, or no permission yet).
    val readable: Boolean,
    val found: Int,
    val imported: Int,
    val skipped: Int,
    val failed: Int,
  ) {
    fun toJson(): JSONObject = JSONObject()
      .put("readable", readable).put("found", found).put("imported", imported)
      .put("skipped", skipped).put("failed", failed)
  }

  // The old recorder named files `yyyy-MM-dd_HH-mm-ss.opus` (the same scheme
  // RecordingFiles uses); anything else falls back to the file's own time.
  fun recordedAt(name: String, zone: TimeZone, fallbackMs: Long): Long {
    val stem = name.substringBeforeLast('.')
    val format = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT)
    format.timeZone = zone
    format.isLenient = false
    val position = ParsePosition(0)
    val parsed = format.parse(stem, position)
    return if (parsed != null && position.index == stem.length) parsed.time else fallbackMs
  }

  // A file is the same file while its name, size and time agree.
  fun keyOf(file: File): String = "${file.name}|${file.length()}|${file.lastModified()}"

  fun run(
    source: File,
    dir: File,
    store: RecordingStore,
    ledger: ImportLedger,
    zone: TimeZone = TimeZone.getDefault(),
    nowMs: Long = System.currentTimeMillis(),
    log: (String, Throwable?) -> Unit = { _, _ -> },
  ): Result {
    val files = source.listFiles { f -> f.isFile && f.name.endsWith(RecordingFiles.FINAL_EXT, ignoreCase = true) }
      ?: return Result(false, 0, 0, 0, 0)
    // Copies a killed run left behind.
    dir.listFiles { f -> f.name.endsWith(TEMP_SUFFIX) }?.forEach { it.delete() }
    val before = ledger.load()
    val taken = before.keys.toMutableSet()
    var imported = 0
    var skipped = 0
    var failed = 0
    var deferred = 0
    for (file in files.sortedBy { it.name }) {
      val key = keyOf(file)
      if (key in taken) {
        skipped++
        continue
      }
      // The old app may still be writing this one: a copy now would be cut short,
      // and the grown file would later import again as a second recording.
      if (nowMs - file.lastModified() in 0 until STILL_WRITING_MS) {
        deferred++
        continue
      }
      val temp = File(dir, "import-${UUID.randomUUID()}$TEMP_SUFFIX")
      try {
        copy(file, temp)
        if (temp.length() != file.length() || temp.length() == 0L) {
          // The source changed under the copy, or holds nothing: not taken, so a
          // later run looks at it again.
          temp.delete()
          failed++
          continue
        }
        val sha = RecordingStore.sha256Of(temp)
        if (store.hasHash(sha)) {
          temp.delete()
          taken.add(key)
          skipped++
          continue
        }
        val at = recordedAt(file.name, zone, file.lastModified().takeIf { it > 0 } ?: nowMs)
        val target = File(dir, RecordingFiles.uniqueBase(dir, RecordingFiles.baseName(at, zone)) + RecordingFiles.FINAL_EXT)
        moveWhole(temp, target)
        store.addImported(target, at, sha)
        taken.add(key)
        imported++
        // Progress survives a kill: a rerun does not copy this file again.
        ledger.save(before.copy(keys = taken))
      } catch (e: IOException) {
        log("Import of ${file.name} failed", e)
        temp.delete()
        failed++
      }
    }
    // Done only when nothing failed; the folder was readable either way, but a
    // failed copy deserves another run.
    ledger.save(
      before.copy(
        keys = taken,
        done = failed == 0 && deferred == 0,
        lastFound = files.size,
        lastImported = before.lastImported + imported,
      ),
    )
    return Result(true, files.size, imported, skipped, failed)
  }

  private fun copy(from: File, to: File) {
    from.inputStream().use { input ->
      FileOutputStream(to).use { out ->
        input.copyTo(out)
        out.fd.sync()
      }
    }
  }

  // Never replaces: a taken name was already made unique, so a clash is a bug.
  private fun moveWhole(from: File, to: File) {
    try {
      Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE)
    } catch (e: AtomicMoveNotSupportedException) {
      Files.move(from.toPath(), to.toPath())
    }
  }

  // The permission that lets this app read another app's audio files: the
  // media-audio one from Android 13, the old storage one before.
  fun permissionFor(sdk: Int): String =
    if (sdk >= 33) "android.permission.READ_MEDIA_AUDIO" else "android.permission.READ_EXTERNAL_STORAGE"
}

// What the import has done, kept next to the index in the private files dir.
// `done` is the "one time": once the folder was read and nothing failed, only an
// explicit request imports again. `asked` records that the permission dialog was
// shown, so it is never raised again on its own.
data class ImportState(
  val done: Boolean = false,
  val asked: Boolean = false,
  val keys: Set<String> = emptySet(),
  val lastFound: Int = 0,
  val lastImported: Int = 0,
)

class ImportLedger(private val file: File) {
  fun load(): ImportState =
    try {
      val o = JSONObject(file.readText(Charsets.UTF_8))
      val keys = mutableSetOf<String>()
      val arr = o.optJSONArray("keys") ?: JSONArray()
      for (i in 0 until arr.length()) keys.add(arr.getString(i))
      ImportState(
        done = o.optBoolean("done", false),
        asked = o.optBoolean("asked", false),
        keys = keys,
        lastFound = o.optInt("lastFound", 0),
        lastImported = o.optInt("lastImported", 0),
      )
    } catch (e: Exception) {
      // Missing or unreadable reads as "nothing taken yet": a rerun then skips
      // anything the store already holds by hash, so no recording doubles.
      ImportState()
    }

  fun save(state: ImportState): Boolean =
    try {
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, file.name + ".tmp")
      val keys = JSONArray()
      state.keys.sorted().forEach { keys.put(it) }
      val text = JSONObject()
        .put("done", state.done).put("asked", state.asked).put("keys", keys)
        .put("lastFound", state.lastFound).put("lastImported", state.lastImported)
        .toString()
      FileOutputStream(tmp).use { out ->
        out.write(text.toByteArray(Charsets.UTF_8))
        out.fd.sync()
      }
      try {
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
      } catch (e: AtomicMoveNotSupportedException) {
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
      }
      true
    } catch (e: IOException) {
      false
    }

  // The one write that must not lose the other fields.
  fun markAsked() {
    save(load().copy(asked = true))
  }
}
