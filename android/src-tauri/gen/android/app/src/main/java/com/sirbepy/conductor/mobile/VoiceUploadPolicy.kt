package com.sirbepy.conductor.mobile

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

// What the Rust uploader (android/src-tauri/src/voice_upload/) asks of the index.
// The index stays Kotlin's: RecordingStore is its one writer, so the uploader
// never touches the file, it claims work and reports back through these.
// Pure over a RecordingStore, so it is unit-tested without Android.
object VoiceUploadPolicy {
  // Recordings that still have to reach the PC, oldest first. A SAVED row is
  // queued here: every recording uploads by itself, there is no manual step. An
  // UPLOADING row found at claim time is one a killed process left, and the
  // uploader resumes it from the PC's own offset.
  fun claim(store: RecordingStore, dir: File): JSONObject {
    for (row in store.list()) {
      if (row.state == RecordingState.SAVED && row.sizeBytes > 0) store.transition(row.id, RecordingState.QUEUED)
    }
    val jobs = JSONArray()
    store.list()
      .filter { (it.state == RecordingState.QUEUED || it.state == RecordingState.UPLOADING) && it.sizeBytes > 0 }
      .sortedBy { it.recordedAtMs }
      .forEach {
        jobs.put(
          JSONObject()
            .put("id", it.id)
            .put("path", File(dir, it.file).absolutePath)
            .put("sizeBytes", it.sizeBytes)
            .put("sha256", it.sha256 ?: JSONObject.NULL)
            .put("recordedAtMs", it.recordedAtMs)
            .put("durationMs", it.durationMs),
        )
      }
    return JSONObject().put("jobs", jobs)
  }

  // Uploaded recordings the phone has not yet heard a transcript of. A row with
  // no hash cannot be asked about (the PC files a recording by its hash).
  fun awaiting(store: RecordingStore): JSONObject {
    val rows = JSONArray()
    store.list()
      .filter { it.state == RecordingState.UPLOADED && !it.sha256.isNullOrEmpty() }
      .sortedBy { it.recordedAtMs }
      .forEach { rows.put(JSONObject().put("id", it.id).put("sha256", it.sha256)) }
    return JSONObject().put("rows", rows)
  }

  // One step the uploader reports. Returns whether the index now says what the
  // uploader reported (a repeat of a state already reached counts as applied).
  fun mark(store: RecordingStore, id: String, state: String?, bytes: Long, error: String?): Boolean {
    val row = store.get(id) ?: return false
    return when (state) {
      "uploading" -> {
        if (row.state == RecordingState.QUEUED && store.transition(id, RecordingState.UPLOADING) == null) return false
        if (store.get(id)?.state != RecordingState.UPLOADING) return false
        store.setProgress(id, bytes)
        true
      }
      // The PC could not be reached: waiting, nothing lost, progress kept.
      "queued" -> row.state == RecordingState.QUEUED || store.transition(id, RecordingState.QUEUED) != null
      "uploaded" -> row.state == RecordingState.UPLOADED || row.state == RecordingState.TRANSCRIBED ||
        store.transition(id, RecordingState.UPLOADED) != null
      // The PC wrote the transcript to the vault. Only an uploaded row moves on.
      "transcribed" -> row.state == RecordingState.TRANSCRIBED ||
        store.transition(id, RecordingState.TRANSCRIBED) != null
      "failed" -> row.state == RecordingState.FAILED ||
        store.transition(id, RecordingState.FAILED, error ?: "Upload failed") != null
      else -> false
    }
  }
}

// The login the uploader presents to the PC: the bearer token the daemon-served
// page keeps in localStorage for the tunnel's loopback origin. The uploader runs
// in native code and cannot read the page's storage, so this reads it from the
// WebView while that page is loaded and keeps the last good copy.
class UploadAuth(val token: String, val port: Int)

object UploadAuthPolicy {
  // Runs in the loaded page; null when storage is unavailable. The host check is
  // done on the result, not here, so a page cannot talk its way past it.
  const val CAPTURE_JS =
    "(function(){try{return JSON.stringify({token:localStorage.getItem('rc_token'),port:location.port,host:location.hostname});}catch(e){return null;}})()"

  // The tunnel serves its page on 127.0.0.1 only. Any other origin (the bundled
  // shell, an https page) holds no login for the PC and is ignored.
  fun parseCapture(result: String?): UploadAuth? {
    if (result == null || result == "null") return null
    return try {
      // evaluateJavascript hands back the JS value as JSON: here a string holding JSON.
      val inner = JSONTokener(result).nextValue() as? String ?: return null
      val o = JSONObject(inner)
      val token = if (o.isNull("token")) "" else o.optString("token")
      val port = o.optString("port").toIntOrNull() ?: return null
      if (o.optString("host") != "127.0.0.1" || token.isBlank() || port !in 1..65535) return null
      UploadAuth(token, port)
    } catch (e: JSONException) {
      null
    }
  }

  fun toJson(auth: UploadAuth?): JSONObject =
    if (auth == null) JSONObject() else JSONObject().put("token", auth.token).put("port", auth.port)
}

// The last captured login, private to the app (the same protection as the page's
// own localStorage). Atomic write, so a kill never leaves half a token.
class UploadAuthStore(private val file: File) {
  fun load(): UploadAuth? =
    try {
      val o = JSONObject(file.readText(Charsets.UTF_8))
      UploadAuth(o.getString("token"), o.getInt("port")).takeIf { it.token.isNotBlank() && it.port in 1..65535 }
    } catch (e: Exception) {
      null
    }

  // Returns false when nothing changed or the write failed.
  fun save(auth: UploadAuth): Boolean {
    val current = load()
    if (current != null && current.token == auth.token && current.port == auth.port) return false
    return try {
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, file.name + ".tmp")
      FileOutputStream(tmp).use { out ->
        out.write(UploadAuthPolicy.toJson(auth).toString().toByteArray(Charsets.UTF_8))
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
  }
}
