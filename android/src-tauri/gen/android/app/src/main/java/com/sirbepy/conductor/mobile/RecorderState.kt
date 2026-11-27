package com.sirbepy.conductor.mobile

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.CopyOnWriteArrayList

// What the recorder service is doing, readable from the bridge and the activity.
// The service and the WebView share one process, so a singleton replaces a
// bound-service API.
object RecorderState {
  enum class Status { IDLE, RECORDING, PAUSED }

  @Volatile
  var status = Status.IDLE
    private set

  // The index row of the live recording, null while idle.
  @Volatile
  var recordingId: String? = null
    private set

  // Why the last recording or start failed, kept until the next start or a
  // dismiss so a failure while the screen was off is still there to read.
  @Volatile
  var error: String? = null
    private set

  // Recorded time is the sum of finished segments plus the running one, so a
  // pause for a call is not counted.
  @Volatile private var bankedMs = 0L
  @Volatile private var segmentStartedAt = 0L

  private val listeners = CopyOnWriteArrayList<() -> Unit>()
  private val main = Handler(Looper.getMainLooper())

  fun elapsedMs(): Long {
    val running = if (status == Status.RECORDING) {
      SystemClock.elapsedRealtime() - segmentStartedAt
    } else {
      0L
    }
    return bankedMs + running
  }

  fun started(id: String) {
    bankedMs = 0L
    segmentStartedAt = SystemClock.elapsedRealtime()
    recordingId = id
    error = null
    update(Status.RECORDING)
  }

  fun paused() {
    if (status != Status.RECORDING) return
    bankedMs += SystemClock.elapsedRealtime() - segmentStartedAt
    update(Status.PAUSED)
  }

  fun resumed() {
    if (status != Status.PAUSED) return
    segmentStartedAt = SystemClock.elapsedRealtime()
    update(Status.RECORDING)
  }

  // A recording that ended on its own (or never started) with a reason.
  fun failed(message: String) {
    error = message
    stopped()
  }

  fun dismissError() {
    if (error == null) return
    error = null
    update(status)
  }

  fun stopped() {
    bankedMs = 0L
    recordingId = null
    update(Status.IDLE)
  }

  fun addListener(listener: () -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: () -> Unit) {
    listeners.remove(listener)
  }

  private fun update(next: Status) {
    status = next
    main.post { listeners.forEach { it() } }
  }
}
