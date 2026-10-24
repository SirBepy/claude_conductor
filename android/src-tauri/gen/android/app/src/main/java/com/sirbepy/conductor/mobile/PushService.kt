package com.sirbepy.conductor.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

const val CHAT_BLOCKED_CHANNEL = "chat-blocked"
const val EXTRA_CHAT_ID = "chatId"

class PushService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    PushRelay.sync(this, token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] != "blocked") return
    val chatId = data["chatId"] ?: return
    ensureChannel()
    // Without the runtime grant (Android 13+) notify() is dropped anyway.
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return

    val id = PushPolicy.notificationId(chatId)
    val open = Intent(this, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_CHAT_ID, chatId)
    // The request code is the id so two chats' PendingIntents do not share extras.
    val tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = NotificationCompat.Builder(this, CHAT_BLOCKED_CHANNEL)
      .setSmallIcon(R.mipmap.ic_launcher_foreground)
      .setContentTitle("Claude needs your input")
      .setContentText(PushPolicy.bodyFor(data["chatName"]))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    NotificationManagerCompat.from(this).notify(chatId, id, notification)
  }

  private fun ensureChannel() {
    val channel = NotificationChannel(CHAT_BLOCKED_CHANNEL, "Chats waiting on you", NotificationManager.IMPORTANCE_HIGH)
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
  }
}
