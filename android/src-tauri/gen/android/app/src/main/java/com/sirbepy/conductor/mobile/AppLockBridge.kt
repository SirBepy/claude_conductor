package com.sirbepy.conductor.mobile

import android.content.Context
import android.webkit.JavascriptInterface

private const val PREFS = "conductor_lock"
private const val RELOCK_MINUTES = "relock_minutes"

// Stored on the phone, not the PC: each phone picks its own lock window.
object AppLockSettings {
  fun relockMinutes(context: Context): Int =
    AppLockPolicy.normalizeMinutes(
      context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getInt(RELOCK_MINUTES, AppLockPolicy.DEFAULT_RELOCK_MINUTES)
    )

  fun setRelockMinutes(context: Context, minutes: Int) {
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putInt(RELOCK_MINUTES, AppLockPolicy.normalizeMinutes(minutes)).apply()
  }
}

// Exposed to the daemon-served SPA as window.ConductorLock, for the App lock
// setting. Same reach as PushBridge: only pages the WebView loads.
class AppLockBridge(private val context: Context) {
  @JavascriptInterface
  fun getRelockMinutes(): Int = AppLockSettings.relockMinutes(context)

  @JavascriptInterface
  fun setRelockMinutes(minutes: Int) = AppLockSettings.setRelockMinutes(context, minutes)
}
