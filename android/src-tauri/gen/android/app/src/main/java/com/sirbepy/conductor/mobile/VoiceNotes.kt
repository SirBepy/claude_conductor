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

  // The PC login the uploader presents; private to the app, apart from the audio.
  fun authStore(context: Context): UploadAuthStore =
    UploadAuthStore(File(context.applicationContext.filesDir, "voice-upload-auth.json"))

  fun importLedger(context: Context): ImportLedger =
    ImportLedger(File(context.applicationContext.filesDir, "voice-import-ledger.json"))

  // True while an import runs, so a second request (the page and the start-up
  // check can both ask) does not copy the same files twice.
  private val importing = java.util.concurrent.atomic.AtomicBoolean(false)

  fun importRunning(): Boolean = importing.get()

  // Imports the old VoiceNotes folder on the io thread. Returns false when one is
  // already running. `onDone` gets the result on that thread.
  fun importOld(context: Context, onDone: (OldRecordingsImport.Result) -> Unit = {}): Boolean {
    if (!importing.compareAndSet(false, true)) return false
    val app = context.applicationContext
    io.execute {
      try {
        val result = OldRecordingsImport.run(
          source = File(OldRecordingsImport.SOURCE_PATH),
          dir = dir(app),
          store = store(app),
          ledger = importLedger(app),
          log = { message, error -> Log.w(TAG, message, error) },
        )
        onDone(result)
      } catch (e: Exception) {
        Log.e(TAG, "Import of the old recordings failed", e)
      } finally {
        importing.set(false)
      }
    }
    return true
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
