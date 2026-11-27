package com.sirbepy.conductor.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

// The pure half of the ConductorVoice bridge, so the decisions and the JSON the
// page reads are unit-tested without a WebView.
object VoiceBridgePolicy {
  // Lets a page tell an old APK from a new one when a method's meaning changes.
  const val BRIDGE_VERSION = 1

  // Ogg/Opus recording through MediaRecorder needs Android 10.
  const val MIN_SDK = 29

  // The page is told which of these happened; only START starts a service.
  enum class StartDecision(val wire: String) {
    START("started"),
    ALREADY_RECORDING("already_recording"),
    NEEDS_PERMISSION("permission_requested"),
    UNSUPPORTED("unsupported"),
    LOCKED("locked"),
  }

  fun startDecision(
    sdk: Int,
    status: RecorderState.Status,
    micGranted: Boolean,
    appLocked: Boolean,
  ): StartDecision = when {
    sdk < MIN_SDK -> StartDecision.UNSUPPORTED
    // A page loaded under the lock screen must not turn the microphone on.
    appLocked -> StartDecision.LOCKED
    status != RecorderState.Status.IDLE -> StartDecision.ALREADY_RECORDING
    !micGranted -> StartDecision.NEEDS_PERMISSION
    else -> StartDecision.START
  }

  fun startReply(decision: StartDecision): String = JSONObject()
    .put("ok", decision == StartDecision.START || decision == StartDecision.ALREADY_RECORDING)
    .put("result", decision.wire)
    .toString()

  fun stateJson(
    status: RecorderState.Status,
    recordingId: String?,
    elapsedMs: Long,
    error: String?,
    micGranted: Boolean,
    sdk: Int,
  ): String = JSONObject()
    .put("bridgeVersion", BRIDGE_VERSION)
    .put("supported", sdk >= MIN_SDK)
    .put("status", status.name.lowercase())
    .put("recordingId", recordingId ?: JSONObject.NULL)
    .put("elapsedMs", elapsedMs)
    .put("error", error ?: JSONObject.NULL)
    .put("micPermission", micGranted)
    .toString()

  fun listJson(rows: List<Recording>): String {
    val out = JSONArray()
    rows.forEach { out.put(it.toJson()) }
    return out.toString()
  }
}

// Exposed to the daemon-served SPA and to the bundled offline pages as
// window.ConductorVoice. Tauri IPC is unreachable from the daemon-served SPA, but
// a registered JavascriptInterface survives the handoff to it (the same reason
// ConductorPush and ConductorLock work). Every method returns a JSON string,
// because a JavascriptInterface can return only primitives and strings.
//
// Like the other bridges it is reachable from any page the WebView loads, which
// is the user's own daemon; start() is the one method with an effect, so it
// refuses while the app lock is up.
class VoiceBridge(
  private val context: Context,
  private val isLocked: () -> Boolean,
  // Asks for the microphone on the UI thread; the recording starts when it is granted.
  private val requestMicrophone: () -> Unit,
) {
  private fun micGranted(): Boolean =
    context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  // {"ok":bool,"result":"started"|"already_recording"|"permission_requested"|"unsupported"|"locked"}.
  // After "permission_requested" the page learns the outcome from state() (the
  // page's __ccVoiceChanged hook fires when it changes).
  @JavascriptInterface
  fun start(): String {
    val decision = VoiceBridgePolicy.startDecision(
      Build.VERSION.SDK_INT,
      RecorderState.status,
      micGranted(),
      isLocked(),
    )
    when (decision) {
      VoiceBridgePolicy.StartDecision.START -> RecorderService.start(context)
      VoiceBridgePolicy.StartDecision.NEEDS_PERMISSION -> requestMicrophone()
      else -> Unit
    }
    return VoiceBridgePolicy.startReply(decision)
  }

  // Stopping is always allowed, locked or not: it only ends a recording.
  @JavascriptInterface
  fun stop(): String {
    if (RecorderState.status != RecorderState.Status.IDLE) RecorderService.stop(context)
    return JSONObject().put("ok", true).toString()
  }

  // Every recording on the phone, newest first.
  @JavascriptInterface
  fun list(): String = VoiceBridgePolicy.listJson(VoiceNotes.store(context).list())

  @JavascriptInterface
  fun state(): String = VoiceBridgePolicy.stateJson(
    RecorderState.status,
    RecorderState.recordingId,
    RecorderState.elapsedMs(),
    RecorderState.error,
    micGranted(),
    Build.VERSION.SDK_INT,
  )

  // The page has shown the failure; the next start clears it too.
  @JavascriptInterface
  fun dismissError(): String {
    RecorderState.dismissError()
    return JSONObject().put("ok", true).toString()
  }
}
