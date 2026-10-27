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

// BIOMETRIC_WEAK, not STRONG: STRONG | DEVICE_CREDENTIAL is unsupported on
// API 28-29 (minSdk is 28), and the PIN fallback is the point. One constant for
// the unlock prompt and the screen-lock probe, so "has a screen lock" and
// "the prompt can run" never disagree.
const val UNLOCK_AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL

fun phoneHasScreenLock(context: Context): Boolean =
  BiometricManager.from(context).canAuthenticate(UNLOCK_AUTHENTICATORS) !=
    BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED

// Stored on the phone, not the PC: each phone picks its own lock window.
object AppLockSettings {
  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // The lock only wrote a pref when the user changed the picker, so a stored
  // relock value alone cannot spot every install that predates the opt-in. The
  // APK's own update time can: a fresh install has lastUpdateTime close to
  // firstInstallTime (split-APK installs can stamp them apart by a few ms) and any
  // real update moves it well past. An unanswered fresh install that updates
  // before answering is also read as upgraded and locks, which is the safe direction.
  private fun upgradedInstall(context: Context, p: SharedPreferences): Boolean {
    if (p.contains(RELOCK_MINUTES)) return true
    return try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      AppLockPolicy.isUpgrade(info.firstInstallTime, info.lastUpdateTime)
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
// setting. Same reach as PushBridge: only pages the WebView loads, which is why
// switching the lock off goes through `confirmUnlock` instead of a plain save.
//
// `confirmUnlock` runs a fresh biometric/PIN prompt and reports whether it passed;
// `runJs` evaluates a script in the WebView on the main thread.
class AppLockBridge(
  private val context: Context,
  private val confirmUnlock: (onDone: (Boolean) -> Unit) -> Unit,
  private val runJs: (String) -> Unit,
) {
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

  // true = saved already. false = a prompt is up; the outcome arrives through
  // window.__ccLockSwitchResult, and only a passed prompt saves the lock off.
  @JavascriptInterface
  fun setLockEnabled(enabled: Boolean): Boolean {
    if (AppLockPolicy.switchRequest(enabled, phoneHasScreenLock(context)) == AppLockPolicy.SwitchRequest.SAVE_NOW) {
      AppLockSettings.setLockEnabled(context, enabled)
      return true
    }
    confirmUnlock { passed ->
      if (passed) AppLockSettings.setLockEnabled(context, false)
      runJs(AppLockPolicy.switchResultJs(passed))
    }
    return false
  }

  @JavascriptInterface
  fun hasScreenLock(): Boolean = phoneHasScreenLock(context)
}
