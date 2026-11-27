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
  // 2: openRecorder().
  const val BRIDGE_VERSION = 2

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

  enum class ImportDecision(val wire: String) {
    START("started"),
    RUNNING("already_running"),
    NEEDS_PERMISSION("permission_requested"),
    LOCKED("locked"),
  }

  // The old-folder import only ever reads, but it adds rows to the list, so it
  // too waits out the app lock.
  fun importDecision(storageGranted: Boolean, running: Boolean, appLocked: Boolean): ImportDecision = when {
    appLocked -> ImportDecision.LOCKED
    running -> ImportDecision.RUNNING
    !storageGranted -> ImportDecision.NEEDS_PERMISSION
    else -> ImportDecision.START
  }

  fun importReply(decision: ImportDecision): String = JSONObject()
    .put("ok", decision == ImportDecision.START || decision == ImportDecision.RUNNING)
    .put("result", decision.wire)
    .toString()

  fun importStatusJson(state: ImportState, running: Boolean, storageGranted: Boolean): String = JSONObject()
    .put("done", state.done)
    .put("running", running)
    .put("permission", storageGranted)
    .put("found", state.lastFound)
    .put("imported", state.lastImported)
    .toString()

  // Start-up check: what MainActivity should do about the old recordings now.
  // Asks for the permission at most once on its own (`asked` survives restarts);
  // a later ask is the page's explicit importOld().
  enum class AutoImport { NOTHING, RUN, ASK }

  fun autoImport(state: ImportState, storageGranted: Boolean, running: Boolean, appLocked: Boolean): AutoImport = when {
    state.done || running || appLocked -> AutoImport.NOTHING
    storageGranted -> AutoImport.RUN
    !state.asked -> AutoImport.ASK
    else -> AutoImport.NOTHING
  }

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
  // Asks for access to the old recorder's folder on the UI thread; the import runs
  // when it is granted.
  private val requestStorage: () -> Unit = {},
  // Loads the bundled shell page on the named voice screen (VoiceEntryPolicy.shellUrl)
  // on the UI thread; this is how the daemon-served SPA reaches the offline recorder.
  private val openShell: (String) -> Unit = {},
) {
  private fun storageGranted(): Boolean =
    context.checkSelfPermission(OldRecordingsImport.permissionFor(Build.VERSION.SDK_INT)) ==
      PackageManager.PERMISSION_GRANTED

  // Imports the stopgap app's recordings (/storage/emulated/0/VoiceNotes) into the
  // list. {"ok":bool,"result":"started"|"already_running"|"permission_requested"|"locked"}.
  @JavascriptInterface
  fun importOld(): String {
    val decision = VoiceBridgePolicy.importDecision(storageGranted(), VoiceNotes.importRunning(), isLocked())
    when (decision) {
      VoiceBridgePolicy.ImportDecision.START -> VoiceNotes.importOld(context)
      VoiceBridgePolicy.ImportDecision.NEEDS_PERMISSION -> requestStorage()
      else -> Unit
    }
    return VoiceBridgePolicy.importReply(decision)
  }

  @JavascriptInterface
  fun importStatus(): String = VoiceBridgePolicy.importStatusJson(
    VoiceNotes.importLedger(context).load(),
    VoiceNotes.importRunning(),
    storageGranted(),
  )

  // The SPA's mic head: leaves the daemon page for the bundled recorder. Refused
  // while the app lock is up (the page itself is hidden then, but a script is not).
  // `view` is one of home, recorder, list; anything else opens Home.
  @JavascriptInterface
  fun openRecorder(view: String?): String {
    if (isLocked()) return JSONObject().put("ok", false).put("result", "locked").toString()
    openShell(VoiceEntryPolicy.shellUrl(view))
    return JSONObject().put("ok", true).put("result", "opened").toString()
  }

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
