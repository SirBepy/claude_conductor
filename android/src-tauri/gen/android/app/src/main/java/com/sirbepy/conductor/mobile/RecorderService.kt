package com.sirbepy.conductor.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.io.File

// Records one note per start/stop into VoiceNotes.dir. A foreground service of
// type microphone is what lets a recording run for hours with the screen off and
// other apps in front. Ported from handy_scripts' android-recorder, plus the
// MediaRecorder error and info listeners it lacked: a recorder that dies mid-note
// finishes the file, says so in the index and raises a notification, instead of
// leaving "Recording" on screen over a file that stopped growing.
class RecorderService : Service() {
  private var recorder: MediaRecorder? = null
  private var partFile: File? = null
  private var recordingId: String? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var focusRequest: AudioFocusRequest? = null

  // Set only when a call or other transient focus loss paused us, so a pause the
  // service did not cause is never resumed behind the user's back.
  private var pausedByFocus = false

  override fun onBind(intent: Intent?): IBinder? = null

  // stopSelf(startId) ends the service only if no newer start is queued, so a
  // quick stop then start does not stop the service the new start needs.
  private var lastStartId = 0

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    when (intent?.action) {
      ACTION_START -> start()
      ACTION_STOP -> finishRecording(error = null)
    }
    return START_NOT_STICKY
  }

  private fun start() {
    if (recorder != null) return
    try {
      startRecording()
    } catch (e: Exception) {
      // Anything unexpected (a SecurityException from startForeground on Android
      // 14, a MediaRecorder constructor failure) must not leave a foreground
      // service with no recorder, or a row that says RECORDING.
      Log.e(TAG, "Recorder failed to start", e)
      discardFailedStart()
      failStart("The recorder could not start: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  private fun startRecording() {
    // Foreground first: startForegroundService obliges it within seconds.
    val first = notification(paused = false, startedAtMs = System.currentTimeMillis())
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, first)
    }
    // MediaRecorder's Ogg container and Opus encoder arrived in Android 10.
    if (Build.VERSION.SDK_INT < 29) return failStart("Recording needs Android 10 or newer")
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      return failStart("Microphone permission is not granted")
    }
    val dir = VoiceNotes.dir(this)
    if (!dir.isDirectory || !dir.canWrite()) return failStart("The recordings folder is not writable")
    if (dir.usableSpace < MIN_FREE_BYTES) return failStart("Not enough free storage to record")

    val now = System.currentTimeMillis()
    val part = RecordingFiles.newPartFile(dir, now)
    val row = VoiceNotes.store(this).begin(part, now)
    // Set before the encoder is configured so discardFailedStart can undo them.
    partFile = part
    recordingId = row.id
    val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
    recorder = rec
    rec.setOnErrorListener { _, what, extra ->
      Log.e(TAG, "MediaRecorder error what=$what extra=$extra")
      finishRecording(error = describeError(what))
    }
    rec.setOnInfoListener { _, what, extra ->
      Log.w(TAG, "MediaRecorder info what=$what extra=$extra")
      describeInfo(what)?.let { finishRecording(error = it) }
    }
    rec.setAudioSource(MediaRecorder.AudioSource.MIC)
    rec.setOutputFormat(MediaRecorder.OutputFormat.OGG)
    rec.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
    // Speech at 16 kHz mono matches what Whisper reads; 24 kbps is about
    // 11 MB per hour.
    rec.setAudioSamplingRate(16_000)
    rec.setAudioChannels(1)
    rec.setAudioEncodingBitRate(24_000)
    rec.setOutputFile(part.absolutePath)
    rec.prepare()
    rec.start()
    acquireWakeLock()
    requestFocus()
    RecorderState.started(row.id)
  }

  // A start that threw after the row and the part exist. Audio on disk is kept
  // for the next recovery; an empty part and its row go.
  private fun discardFailedStart() {
    val rec = recorder
    val part = partFile
    val id = recordingId
    recorder = null
    partFile = null
    recordingId = null
    try {
      rec?.release()
    } catch (e: RuntimeException) {
      Log.w(TAG, "Release after a failed start failed", e)
    }
    abandonFocus()
    if (id == null) return
    val store = VoiceNotes.store(this)
    if (part != null && part.length() > 0L) {
      store.release(id)
    } else {
      part?.delete()
      store.abandon(id)
    }
  }

  // Ends the live recording: stop the encoder, then rename the part to its final
  // name and hash and index it on the IO thread (one thread, so the rename and
  // the row update cannot interleave with a recovery pass). `error` is why it
  // ended early, or null for a normal stop.
  private fun finishRecording(error: String?) {
    val rec = recorder
    val part = partFile
    val id = recordingId
    recorder = null
    partFile = null
    recordingId = null
    abandonFocus()
    val durationMs = RecorderState.elapsedMs()
    var stopFailure: String? = null
    if (rec != null) {
      // The listeners can fire again while this runs; they find recorder null.
      rec.setOnErrorListener(null)
      rec.setOnInfoListener(null)
      try {
        rec.stop()
      } catch (e: RuntimeException) {
        // Stopping straight after starting throws; the file is still closed, and
        // finalize drops it when it is empty. With real audio in it, the
        // recording is kept and the failure is on its row.
        Log.w(TAG, "Recorder stop failed", e)
        stopFailure = "The recorder did not stop cleanly"
      }
      rec.release()
    }
    val reason = error ?: stopFailure
    if (part != null && id != null) {
      val store = VoiceNotes.store(this)
      VoiceNotes.io.execute {
        val final = RecordingFiles.finalize(part)
        when {
          final != null -> store.complete(id, final, durationMs, reason)
          part.exists() -> {
            // The rename failed with audio in the part: keep the row, and the
            // next app start finishes it.
            store.release(id)
            raiseError("The recording is saved but could not be renamed; it will be finished the next time the app opens")
          }
          // An empty part was dropped: nothing was recorded.
          else -> store.abandon(id)
        }
      }
      // A reason is worth a banner only when audio exists; stopping straight
      // after starting leaves an empty part and nothing to report.
      if (reason != null && part.length() > 0L) raiseError(reason)
    }
    shutDown(reason)
  }

  private fun failStart(message: String) {
    Log.w(TAG, "Cannot start: $message")
    raiseError(message)
    shutDown(message)
  }

  private fun shutDown(error: String?) {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    if (error != null) RecorderState.failed(error) else RecorderState.stopped()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(lastStartId)
  }

  override fun onDestroy() {
    // The system took the service down while recording: keep what was written.
    if (recorder != null) finishRecording(error = "Recording was stopped by Android")
    super.onDestroy()
  }

  private fun describeError(what: Int): String = when (what) {
    MediaRecorder.MEDIA_ERROR_SERVER_DIED -> "The phone's media service restarted, so recording stopped"
    else -> "Recording stopped: another app may have taken the microphone, or storage is full"
  }

  // The limits are never set, so these should not fire; if one does the encoder
  // has stopped writing and the note must not stay "recording".
  private fun describeInfo(what: Int): String? = when (what) {
    MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED -> "Recording stopped at its time limit"
    MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED -> "Recording stopped at its size limit"
    else -> null
  }

  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "conductor:voice-recording").apply {
      // Acquired without a timeout on purpose: a walk can last hours and
      // finishRecording always releases it.
      acquire()
    }
  }

  // Only a transient loss (a call, an alarm) pauses us. A permanent loss means
  // another app started playing; recording keeps going then, because silently
  // dropping the rest of a long walk is the worse failure.
  private fun requestFocus() {
    val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setOnAudioFocusChangeListener { change ->
        when (change) {
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> pauseForFocus()
          AudioManager.AUDIOFOCUS_GAIN -> resumeAfterFocus()
        }
      }
      .build()
    focusRequest = request
    audio.requestAudioFocus(request)
  }

  private fun abandonFocus() {
    val request = focusRequest ?: return
    (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(request)
    focusRequest = null
    pausedByFocus = false
  }

  private fun pauseForFocus() {
    val rec = recorder ?: return
    if (RecorderState.status != RecorderState.Status.RECORDING) return
    try {
      rec.pause()
      pausedByFocus = true
      RecorderState.paused()
      updateNotification(paused = true)
    } catch (e: IllegalStateException) {
      Log.w(TAG, "Pause failed", e)
    }
  }

  private fun resumeAfterFocus() {
    val rec = recorder ?: return
    if (!pausedByFocus) return
    try {
      rec.resume()
      pausedByFocus = false
      RecorderState.resumed()
      updateNotification(paused = false)
    } catch (e: IllegalStateException) {
      Log.w(TAG, "Resume failed", e)
    }
  }

  private fun updateNotification(paused: Boolean) {
    val startedAt = System.currentTimeMillis() - RecorderState.elapsedMs()
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .notify(NOTIFICATION_ID, notification(paused, startedAt))
  }

  // The chronometer counts recorded time itself, so the notification never needs
  // a per-second update (which would wake the phone) while the screen is off.
  private fun notification(paused: Boolean, startedAtMs: Long): Notification {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, getString(R.string.voice_notif_channel), NotificationManager.IMPORTANCE_LOW),
    )
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, RecorderService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_conductor)
      .setContentTitle(getString(if (paused) R.string.voice_notif_paused else R.string.voice_notif_recording))
      .setContentIntent(openApp())
      .setOngoing(true)
      .setWhen(startedAtMs)
      .setShowWhen(!paused)
      .setUsesChronometer(!paused)
      .addAction(Notification.Action.Builder(null, getString(R.string.voice_notif_stop), stop).build())
      .build()
  }

  // Its own notification, not the ongoing one: stopForeground removes that one,
  // and a failure while the phone sat in a pocket has to still be there later.
  private fun raiseError(message: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
      NotificationChannel(ERROR_CHANNEL_ID, getString(R.string.voice_notif_error_channel), NotificationManager.IMPORTANCE_HIGH),
    )
    nm.notify(
      ERROR_NOTIFICATION_ID,
      Notification.Builder(this, ERROR_CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_conductor)
        .setContentTitle(getString(R.string.voice_notif_failed))
        .setContentText(message)
        .setStyle(Notification.BigTextStyle().bigText(message))
        .setContentIntent(openApp())
        .setAutoCancel(true)
        .build(),
    )
  }

  private fun openApp(): PendingIntent {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java)
    return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
  }

  companion object {
    const val ACTION_START = "com.sirbepy.conductor.mobile.voice.START"
    const val ACTION_STOP = "com.sirbepy.conductor.mobile.voice.STOP"
    private const val TAG = "RecorderService"
    private const val CHANNEL_ID = "voice_recording"
    private const val ERROR_CHANNEL_ID = "voice_recording_error"
    private const val NOTIFICATION_ID = 7101
    private const val ERROR_NOTIFICATION_ID = 7102

    // An hour is about 11 MB; refusing under 50 MB keeps a full phone from
    // starting a note it cannot finish.
    private const val MIN_FREE_BYTES = 50L * 1024 * 1024

    fun start(context: Context) {
      context.startForegroundService(Intent(context, RecorderService::class.java).setAction(ACTION_START))
    }

    fun stop(context: Context) {
      context.startService(Intent(context, RecorderService::class.java).setAction(ACTION_STOP))
    }
  }
}
