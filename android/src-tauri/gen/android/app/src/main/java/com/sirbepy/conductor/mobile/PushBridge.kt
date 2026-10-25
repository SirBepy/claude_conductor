package com.sirbepy.conductor.mobile

import android.content.Context
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationManagerCompat

// Which chat the SPA shows and whether the app is in front, unlocked. Written by
// the WebView's bridge thread and MainActivity, read by PushService's thread.
object OnScreen {
  @Volatile var chatId: String? = null
  @Volatile var appVisible = false

  // Viewing a chat answers its banner, so it goes once the chat is really in front.
  fun clearShownChat(context: Context) {
    val id = chatId ?: return
    if (appVisible) cancelChatNotification(context, id)
  }
}

fun cancelChatNotification(context: Context, chatId: String) {
  NotificationManagerCompat.from(context).cancel(chatId, PushPolicy.notificationId(chatId))
}

// Exposed to the daemon-served SPA as window.ConductorPush. It is only reachable
// from pages the WebView loads, which is the user's own daemon.
class PushBridge(private val context: Context) {
  @JavascriptInterface
  fun getHandle(): String = PushRelay.handleJson(context)

  // "" when no chat is on screen (another view, or none selected).
  @JavascriptInterface
  fun setOnScreenChat(chatId: String) {
    OnScreen.chatId = chatId.ifEmpty { null }
    OnScreen.clearShownChat(context)
  }
}
