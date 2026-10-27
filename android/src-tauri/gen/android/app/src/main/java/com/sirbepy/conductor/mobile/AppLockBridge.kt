package com.sirbepy.conductor.mobile

import android.content.Context
import android.content.SharedPreferences
import android.webkit.JavascriptInterface
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL

private const val PREFS = "conductor_lock"
private const val RELOCK_MINUTES = "relock_minutes"
private const val LOCK_ENABLED = "lock_enabled"

// Same authenticators the unlock prompt asks for, so "has a screen lock" and
// "the prompt can run" never disagree.
fun phoneHasScreenLock(context: Context): Boolean =
  BiometricManager.from(context).canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) !=
    BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED

// Stored on the phone, not the PC: each phone picks its own lock window.
object AppLockSettings {
  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // The lock only wrote a pref when the user changed the picker, so a stored
  // relock value alone cannot spot every install that predates the opt-in. The
  // APK's own update time can: a fresh install has lastUpdateTime == firstInstallTime
  // and any update (this release over an older one) moves it past. An unanswered
  // fresh install that updates before answering is also read as upgraded and
  // locks, which is the safe direction.
  private fun upgradedInstall(context: Context, p: SharedPreferences): Boolean {
    if (p.contains(RELOCK_MINUTES)) return true
    return try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      info.lastUpdateTime > info.firstInstallTime
    } catch (_: Exception) {
      false
    }
  }

  // Null = never answered and not an upgraded install. An upgrade's implied Yes
  // is saved so later reads never depend on the install timestamps again.
  fun lockEnabled(context: Context): Boolean? {
    val p = prefs(context)
    val stored = if (p.contains(LOCK_ENABLED)) p.getBoolean(LOCK_ENABLED, true) else null
    val resolved = AppLockPolicy.resolveEnabled(stored, stored == null && upgradedInstall(context, p))
    if (stored == null && resolved != null) p.edit().putBoolean(LOCK_ENABLED, resolved).apply()
    return resolved
  }

  fun setLockEnabled(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean(LOCK_ENABLED, enabled).apply()
  }

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

  @JavascriptInterface
  fun getRelockChoices(): String = AppLockPolicy.choicesJson()

  // Unanswered reads as off: the switch only matters after the launch question,
  // or on a phone with no screen lock where it is disabled anyway.
  @JavascriptInterface
  fun isLockEnabled(): Boolean = AppLockSettings.lockEnabled(context) == true

  @JavascriptInterface
  fun setLockEnabled(enabled: Boolean) = AppLockSettings.setLockEnabled(context, enabled)

  @JavascriptInterface
  fun hasScreenLock(): Boolean = phoneHasScreenLock(context)
}
