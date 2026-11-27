package com.sirbepy.conductor.mobile

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke

// The Kotlin half of the native voice uploader (android/src-tauri/src/voice_upload/).
// Rust drives the upload loop and calls these three commands; the decisions are
// in VoiceUploadPolicy. A command never throws to Rust: a failure is a rejected
// invoke, which the uploader treats as "try again later".
@TauriPlugin
class VoiceUploadPlugin(private val activity: Activity) : Plugin(activity) {
  // Recordings to send now (queues any that are only saved).
  @Command
  fun voiceClaim(invoke: Invoke) {
    try {
      val store = VoiceNotes.store(activity)
      invoke.resolve(JSObject(VoiceUploadPolicy.claim(store, VoiceNotes.dir(activity)).toString()))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "claim failed")
    }
  }

  // Uploaded recordings waiting to hear of their transcript.
  @Command
  fun voiceAwaiting(invoke: Invoke) {
    try {
      invoke.resolve(JSObject(VoiceUploadPolicy.awaiting(VoiceNotes.store(activity)).toString()))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "awaiting failed")
    }
  }

  // One step the uploader reports: uploading (with bytes), queued, uploaded, failed.
  @Command
  fun voiceMark(invoke: Invoke) {
    try {
      val args = invoke.getArgs()
      val applied = VoiceUploadPolicy.mark(
        VoiceNotes.store(activity),
        args.getString("id"),
        args.optString("state"),
        args.optLong("bytes", 0L),
        if (args.isNull("error")) null else args.optString("error"),
      )
      invoke.resolve(JSObject().put("applied", applied))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "mark failed")
    }
  }

  // The captured login for the PC's tunnel origin, or {} while there is none.
  @Command
  fun voiceAuth(invoke: Invoke) {
    try {
      invoke.resolve(JSObject(UploadAuthPolicy.toJson(VoiceNotes.authStore(activity).load()).toString()))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "auth failed")
    }
  }
}
