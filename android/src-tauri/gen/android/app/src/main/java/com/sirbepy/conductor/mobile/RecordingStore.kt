package com.sirbepy.conductor.mobile

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

enum class RecordingState(val wire: String) {
  RECORDING("recording"),
  SAVED("saved"),
  QUEUED("queued"),
  UPLOADING("uploading"),
  UPLOADED("uploaded"),
  TRANSCRIBED("transcribed"),
  FAILED("failed");

  companion object {
    fun fromWire(value: String?): RecordingState? = values().firstOrNull { it.wire == value }
  }
}

// The moves the upload and transcription rounds may make. RECORDING only ever
// leaves through RecordingStore.complete, and TRANSCRIBED is the end.
object RecordingTransitions {
  private val allowed = mapOf(
    RecordingState.SAVED to setOf(RecordingState.QUEUED),
    RecordingState.QUEUED to setOf(
      RecordingState.UPLOADING,
      // The PC already holds this sha256, so there is nothing to send.
      RecordingState.UPLOADED,
      RecordingState.FAILED,
    ),
    RecordingState.UPLOADING to setOf(
      RecordingState.QUEUED,
      RecordingState.UPLOADED,
      RecordingState.FAILED,
    ),
    RecordingState.UPLOADED to setOf(RecordingState.TRANSCRIBED, RecordingState.FAILED),
    RecordingState.FAILED to setOf(RecordingState.QUEUED),
  )

  fun canMove(from: RecordingState, to: RecordingState): Boolean =
    allowed[from]?.contains(to) == true
}

// One row of the index. `file` is a name inside the recordings folder, never a
// path, so the folder can move (a different storage root) without rewriting rows.
data class Recording(
  val id: String,
  val file: String,
  val sizeBytes: Long,
  val sha256: String?,
  val recordedAtMs: Long,
  val durationMs: Long,
  val state: RecordingState,
  val bytesUploaded: Long,
  // A recording that was cut short still lands as SAVED with the reason here,
  // and a FAILED upload carries its error; null otherwise.
  val error: String?,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("file", file)
    .put("sizeBytes", sizeBytes)
    .put("sha256", sha256 ?: JSONObject.NULL)
    .put("recordedAtMs", recordedAtMs)
    .put("durationMs", durationMs)
    .put("state", state.wire)
    .put("bytesUploaded", bytesUploaded)
    .put("error", error ?: JSONObject.NULL)

  companion object {
    fun fromJson(o: JSONObject): Recording = Recording(
      id = o.getString("id"),
      file = o.getString("file"),
      sizeBytes = o.optLong("sizeBytes", 0L),
      sha256 = if (o.isNull("sha256")) null else o.optString("sha256"),
      recordedAtMs = o.optLong("recordedAtMs", 0L),
      durationMs = o.optLong("durationMs", 0L),
      // A state this build does not know (written by a newer one) is treated as
      // saved: the file is on the phone, and an upload is idempotent.
      state = RecordingState.fromWire(o.optString("state")) ?: RecordingState.SAVED,
      bytesUploaded = o.optLong("bytesUploaded", 0L),
      error = if (o.isNull("error")) null else o.optString("error"),
    )
  }
}

// The persistent index of every recording on this phone. The recordings folder
// is the truth about audio and the index the truth about what happened to it,
// so [reconcile] rebuilds either from the other. A row is only dropped when its
// audio is gone; audio is never deleted, except a part with no bytes in it.
class RecordingStore(
  private val dir: File,
  private val indexFile: File,
  private val clock: () -> Long = { System.currentTimeMillis() },
  private val newId: () -> String = { UUID.randomUUID().toString() },
  private val log: (String, Throwable?) -> Unit = { _, _ -> },
) {
  private val lock = Any()
  private var loaded: MutableList<Recording>? = null

  // Rows of recordings this process is writing right now. reconcile never
  // finishes or adopts them, so it cannot race a live recording; a row is live
  // from begin until complete, abandon or release. A new process starts with
  // none, which is exactly what makes a killed process's rows recoverable.
  private val live = mutableSetOf<String>()
  private val listeners = CopyOnWriteArrayList<() -> Unit>()

  fun addListener(listener: () -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: () -> Unit) {
    listeners.remove(listener)
  }

  // Newest first.
  fun list(): List<Recording> = synchronized(lock) {
    items().sortedWith(compareByDescending<Recording> { it.recordedAtMs }.thenByDescending { it.file })
  }

  fun get(id: String): Recording? = synchronized(lock) { items().firstOrNull { it.id == id } }

  // A new row for a recording that is about to write `part`.
  fun begin(part: File, recordedAtMs: Long = clock()): Recording {
    val row = Recording(
      id = newId(),
      file = part.name,
      sizeBytes = 0L,
      sha256 = null,
      recordedAtMs = recordedAtMs,
      durationMs = 0L,
      state = RecordingState.RECORDING,
      bytesUploaded = 0L,
      error = null,
    )
    synchronized(lock) {
      items().add(row)
      live.add(row.id)
      persist()
    }
    changed()
    return row
  }

  // The recording is no longer being written but could not be completed (its
  // rename failed), so the row stays as it is and the next reconcile retries it.
  fun release(id: String) {
    synchronized(lock) { live.remove(id) }
  }

  // The audio of `id` is finished at `file`: records its size and hash and moves
  // it to SAVED. `error` says why a recording ended early.
  fun complete(id: String, file: File, durationMs: Long, error: String?): Recording? {
    if (!file.isFile) return abandon(id)
    val facts = describe(file)
    var result: Recording? = null
    synchronized(lock) {
      val index = items().indexOfFirst { it.id == id }
      if (index < 0) return null
      val row = items()[index].copy(
        file = file.name,
        sizeBytes = facts.size,
        sha256 = facts.sha256,
        durationMs = durationMs,
        state = RecordingState.SAVED,
        error = error,
      )
      items()[index] = row
      live.remove(id)
      persist()
      result = row
    }
    changed()
    return result
  }

  // True when some row already holds audio with this hash (an import of a
  // recording the phone has under another name is the same recording).
  fun hasHash(sha256: String): Boolean = synchronized(lock) { items().any { it.sha256 == sha256 } }

  // A finished recording copied in from elsewhere (the old VoiceNotes app): a new
  // SAVED row, so it uploads and transcribes like any other. Null when a row
  // already names this file. `sha256` is passed in because the importer needed it
  // to dedupe and hashing an hour of audio twice is wasted work.
  fun addImported(file: File, recordedAtMs: Long, sha256: String?): Recording? {
    var result: Recording? = null
    synchronized(lock) {
      if (items().any { it.file == file.name }) return null
      val row = Recording(
        id = newId(),
        file = file.name,
        sizeBytes = file.length(),
        sha256 = sha256,
        recordedAtMs = recordedAtMs,
        durationMs = 0L,
        state = RecordingState.SAVED,
        bytesUploaded = 0L,
        error = null,
      )
      items().add(row)
      persist()
      result = row
    }
    changed()
    return result
  }

  // Nothing was recorded (stopped before any audio), so the row goes with it.
  fun abandon(id: String): Recording? {
    var removed: Recording? = null
    synchronized(lock) {
      val index = items().indexOfFirst { it.id == id }
      live.remove(id)
      if (index >= 0) {
        removed = items().removeAt(index)
        persist()
      }
    }
    if (removed != null) changed()
    return null
  }

  fun transition(id: String, to: RecordingState, error: String? = null): Recording? {
    var result: Recording? = null
    synchronized(lock) {
      val index = items().indexOfFirst { it.id == id }
      if (index < 0) return null
      val row = items()[index]
      if (!RecordingTransitions.canMove(row.state, to)) return null
      val next = row.copy(
        state = to,
        error = if (to == RecordingState.FAILED) error else null,
        // A fresh send starts from what the PC says it holds, so the uploader
        // sets the offset itself; a finished one is whole.
        bytesUploaded = if (to == RecordingState.UPLOADED || to == RecordingState.TRANSCRIBED) {
          row.sizeBytes
        } else {
          row.bytesUploaded
        },
      )
      items()[index] = next
      persist()
      result = next
    }
    changed()
    return result
  }

  // Only while UPLOADING; clamped to the file's size.
  fun setProgress(id: String, bytes: Long): Recording? {
    var result: Recording? = null
    synchronized(lock) {
      val index = items().indexOfFirst { it.id == id }
      if (index < 0) return null
      val row = items()[index]
      if (row.state != RecordingState.UPLOADING) return null
      val next = row.copy(bytesUploaded = bytes.coerceIn(0L, row.sizeBytes))
      items()[index] = next
      persist()
      result = next
    }
    changed()
    return result
  }

  // Brings the index and the folder back in line after a crash, a kill or a
  // corrupt index. Recordings this process is writing (see `live`) are left alone.
  fun reconcile() {
    // Rows still marked RECORDING whose process died: finish their audio.
    val stale = synchronized(lock) {
      items().filter { it.state == RecordingState.RECORDING && it.id !in live }
    }
    for (row in stale) {
      val onDisk = File(dir, row.file)
      val finished = when {
        RecordingFiles.isPart(onDisk) && onDisk.exists() -> RecordingFiles.finalize(onDisk)
        // The rename happened but the row was not updated before the kill.
        else -> File(dir, RecordingFiles.finalNameOf(row.file)).takeIf { it.isFile }
      }
      if (finished != null) {
        complete(row.id, finished, 0L, "Recovered after the app stopped")
      } else if (onDisk.exists()) {
        // A rename that failed with audio present keeps the row for next time.
        continue
      } else {
        abandon(row.id)
      }
    }
    // Parts no row knows about (an index lost with its recording), finished.
    // A part with a row (a live recording's included) is not an orphan.
    val parts = dir.listFiles { f -> f.isFile && RecordingFiles.isPart(f) } ?: emptyArray()
    for (part in parts) {
      if (synchronized(lock) { items().any { it.file == part.name } }) continue
      RecordingFiles.finalize(part)
    }
    // Finished audio no row knows about is adopted, so nothing on the phone is
    // invisible to the list.
    // A live recording's part may already be renamed while its row still names the
    // part, so the final name of every live row counts as known.
    val known = synchronized(lock) {
      items().map { it.file }.toSet() +
        items().filter { it.id in live }.map { RecordingFiles.finalNameOf(it.file) }
    }
    var adopted = false
    for (file in RecordingFiles.finished(dir)) {
      if (file.name in known) continue
      val facts = describe(file)
      synchronized(lock) {
        items().add(
          Recording(
            id = newId(),
            file = file.name,
            sizeBytes = facts.size,
            sha256 = facts.sha256,
            recordedAtMs = file.lastModified().takeIf { it > 0 } ?: clock(),
            durationMs = 0L,
            state = RecordingState.SAVED,
            bytesUploaded = 0L,
            error = "Found in the recordings folder, not in the index",
          ),
        )
        persist()
      }
      adopted = true
    }
    if (adopted) changed()
  }

  private class Facts(val size: Long, val sha256: String?)

  // Hashing a long recording is the slow part, so it runs outside the lock. A
  // file that cannot be read for its hash still gets a row (hash filled in by
  // the uploader later), because losing the row hides audio that exists.
  private fun describe(file: File): Facts =
    try {
      Facts(file.length(), sha256Of(file))
    } catch (e: IOException) {
      log("Could not hash ${file.name}", e)
      Facts(file.length(), null)
    }

  private fun changed() {
    listeners.forEach { it() }
  }

  // Callers hold the lock.
  private fun items(): MutableList<Recording> {
    loaded?.let { return it }
    val read = readIndex()
    loaded = read
    return read
  }

  private fun readIndex(): MutableList<Recording> {
    if (!indexFile.exists()) return mutableListOf()
    return try {
      val root = JSONObject(indexFile.readText(Charsets.UTF_8))
      val rows = root.getJSONArray("recordings")
      val out = mutableListOf<Recording>()
      for (i in 0 until rows.length()) out.add(Recording.fromJson(rows.getJSONObject(i)))
      out
    } catch (e: Exception) {
      // Never read an unreadable index as empty and overwrite it: keep it as
      // `.bad` for a person to look at, and rebuild rows from the folder.
      log("Index unreadable, kept as .bad", e)
      keepAsBad()
      mutableListOf()
    }
  }

  private fun keepAsBad() {
    var n = 0
    var target: File
    do {
      target = File(indexFile.parentFile, indexFile.name + (if (n == 0) ".bad" else ".bad$n"))
      n++
    } while (target.exists())
    if (!indexFile.renameTo(target)) log("Could not move the bad index aside", null)
  }

  // Temp file, fsync, rename: a kill mid-write leaves the old index whole.
  private fun persist() {
    val rows = JSONArray()
    items().forEach { rows.put(it.toJson()) }
    val text = JSONObject().put("version", 1).put("recordings", rows).toString(2)
    try {
      indexFile.parentFile?.mkdirs()
      val tmp = File(indexFile.parentFile, indexFile.name + ".tmp")
      FileOutputStream(tmp).use { out ->
        out.write(text.toByteArray(Charsets.UTF_8))
        out.fd.sync()
      }
      replaceAtomically(tmp, indexFile)
    } catch (e: IOException) {
      // The in-memory rows stay right and the next change tries again; the
      // audio is on disk either way and reconcile rebuilds rows from it.
      log("Could not write the index", e)
    }
  }

  // File.renameTo will not replace an existing file on every filesystem (it
  // fails on the Windows host the unit tests run on), so use the nio move.
  private fun replaceAtomically(from: File, to: File) {
    try {
      Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } catch (e: AtomicMoveNotSupportedException) {
      Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }
  }

  companion object {
    fun sha256Of(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      return digest.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
