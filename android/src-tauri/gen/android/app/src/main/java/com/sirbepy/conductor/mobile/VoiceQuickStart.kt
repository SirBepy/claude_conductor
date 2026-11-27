package com.sirbepy.conductor.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

// The quiet idle notification whose Record action starts a voice note without
// opening the app. It is not ongoing (swipe it away; Android's channel settings
// switch it off for good), it never makes a sound or a status-bar icon, and it
// is posted when the app opens and again each time a recording ends. While a
// recording runs the service's own notification replaces it.
object VoiceQuickStart {
  private const val CHANNEL_ID = "voice_quick_start"
  private const val NOTIFICATION_ID = 7103

  fun refresh(context: Context) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val notificationsAllowed = Build.VERSION.SDK_INT < 33 ||
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    if (!VoiceEntryPolicy.quickStartWanted(Build.VERSION.SDK_INT, RecorderState.status, notificationsAllowed)) {
      nm.cancel(NOTIFICATION_ID)
      return
    }
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, context.getString(R.string.voice_quick_channel), NotificationManager.IMPORTANCE_MIN),
    )
    val micGranted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val openApp = Intent(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(VoiceEntryPolicy.EXTRA_VOICE_OPEN, "record")
    // Without the microphone permission only an activity can ask for it, so the
    // action opens the recorder; with it the action starts the service directly
    // (a notification action is an allowed start for a microphone service).
    val record = if (micGranted) {
      PendingIntent.getForegroundService(
        context, 3, Intent(context, RecorderService::class.java).setAction(RecorderService.ACTION_START), PendingIntent.FLAG_IMMUTABLE,
      )
    } else {
      PendingIntent.getActivity(context, 4, openApp, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val open = PendingIntent.getActivity(
      context, 5, Intent(openApp).putExtra(VoiceEntryPolicy.EXTRA_VOICE_OPEN, "home"),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    nm.notify(
      NOTIFICATION_ID,
      Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_conductor)
        .setContentTitle(context.getString(R.string.voice_quick_title))
        .setContentIntent(open)
        .setOngoing(false)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .addAction(Notification.Action.Builder(null, context.getString(R.string.voice_quick_record), record).build())
        .build(),
    )
  }

  fun cancel(context: Context) {
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID)
  }
}
