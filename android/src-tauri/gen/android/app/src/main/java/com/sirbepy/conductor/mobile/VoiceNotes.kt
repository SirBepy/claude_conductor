package com.sirbepy.conductor.mobile

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

// Where voice notes live and the one store every part of the app shares. The
// service, the JS bridge and (later) the uploader are in one process, so one
// store object is the single writer of the index.
object VoiceNotes {
  private const val TAG = "VoiceNotes"

  // Hashing and recovery are disk-bound and must not run on the main thread;
  // one thread keeps index writes in order.
  val io: ExecutorService = Executors.newSingleThreadExecutor()

  @Volatile private var store: RecordingStore? = null

  // App-specific external storage: no permission, still visible over USB for a
  // manual copy, and gone only when the app is uninstalled. The app's private
  // files dir is the fallback when the external volume is not mounted.
  fun dir(context: Context): File {
    val app = context.applicationContext
    val base = app.getExternalFilesDir(null) ?: app.filesDir
    return File(base, "voice-notes").also { it.mkdirs() }
  }

  fun store(context: Context): RecordingStore {
    store?.let { return it }
    synchronized(this) {
      store?.let { return it }
      val app = context.applicationContext
      // The index sits in the private dir, apart from the audio, so a person
      // browsing the audio folder cannot delete the bookkeeping by accident.
      val created = RecordingStore(
        dir = dir(app),
        indexFile = File(app.filesDir, "voice-notes-index.json"),
        log = { message, error -> Log.w(TAG, message, error) },
      )
      store = created
      return created
    }
  }

  // Run once per process start: finishes parts a killed process left behind. A
  // recording this process is writing is marked live in the store and skipped.
  fun recover(context: Context) {
    val app = context.applicationContext
    io.execute {
      try {
        store(app).reconcile()
      } catch (e: Exception) {
        Log.e(TAG, "Recovery failed", e)
      }
    }
  }
}
