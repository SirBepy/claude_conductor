package com.sirbepy.conductor.mobile

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.view.View
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import com.google.android.material.snackbar.Snackbar
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

private const val PLAY_STORE_PACKAGE = "com.android.vending"

// Play's in-app update API only works for a build Play installed. A sideloaded or
// adb-installed build has no update source, so it skips the check silently.
object AppUpdatePolicy {
  fun shouldCheck(installerPackage: String?): Boolean = installerPackage == PLAY_STORE_PACKAGE

  // Play's update dialog is its own activity, so launching it while the app lock
  // is up would cover the unlock prompt.
  fun startNow(locked: Boolean): Boolean = !locked
}

// Flexible flow: Play downloads the new build in the background while the app
// keeps running, then one quiet snackbar offers the restart. Every Play call is
// best-effort, so a failure only logs and never reaches the user or crashes.
class InAppUpdate(
  private val activity: Activity,
  private val launcher: ActivityResultLauncher<IntentSenderRequest>,
  private val isLocked: () -> Boolean,
) {
  private var manager: AppUpdateManager? = null
  private var downloaded = false
  private var snackbar: Snackbar? = null

  // An update found while the app lock is up, started by offerRestartIfReady.
  private var pendingStart: AppUpdateInfo? = null

  private val listener = InstallStateUpdatedListener { state ->
    if (state.installStatus() == InstallStatus.DOWNLOADED) {
      downloaded = true
      offerRestart()
    }
  }

  // Paired with onStop: the listener is only attached while the app is visible.
  fun onStart() {
    if (!AppUpdatePolicy.shouldCheck(installerPackage())) return
    try {
      val m = manager ?: AppUpdateManagerFactory.create(activity).also { manager = it }
      m.registerListener(listener)
      m.appUpdateInfo
        .addOnSuccessListener { info ->
          when {
            // A download that finished while the app was in the background.
            info.installStatus() == InstallStatus.DOWNLOADED -> {
              downloaded = true
              offerRestart()
            }
            info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE &&
              info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE) -> {
              if (AppUpdatePolicy.startNow(isLocked())) startFlexible(m, info) else pendingStart = info
            }
          }
        }
        .addOnFailureListener { Log.w(TAG, "update check failed", it) }
    } catch (e: Exception) {
      Log.w(TAG, "update check could not start", e)
    }
  }

  fun onStop() {
    try {
      manager?.unregisterListener(listener)
    } catch (e: Exception) {
      Log.w(TAG, "update listener could not be removed", e)
    }
    snackbar?.dismiss()
    snackbar = null
    // The next onStart fetches fresh info, so a held one would only go stale.
    pendingStart = null
  }

  // The app lock covers the window until the owner unlocks, so a download that
  // finished meanwhile is offered then, and an update found meanwhile starts then.
  fun offerRestartIfReady() {
    if (downloaded) offerRestart()
    val info = pendingStart ?: return
    pendingStart = null
    val m = manager ?: return
    startFlexible(m, info)
  }

  private fun startFlexible(m: AppUpdateManager, info: AppUpdateInfo) {
    try {
      m.startUpdateFlowForResult(info, launcher, AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build())
    } catch (e: Exception) {
      Log.w(TAG, "update flow could not start", e)
    }
  }

  private fun offerRestart() {
    activity.runOnUiThread {
      if (activity.isFinishing || isLocked()) return@runOnUiThread
      if (snackbar?.isShownOrQueued == true) return@runOnUiThread
      val root = activity.findViewById<View>(android.R.id.content) ?: return@runOnUiThread
      snackbar = Snackbar.make(root, "Update downloaded", Snackbar.LENGTH_INDEFINITE)
        .setAction("Restart") {
          try {
            manager?.completeUpdate()
          } catch (e: Exception) {
            Log.w(TAG, "update could not be completed", e)
          }
        }
        .also { it.show() }
    }
  }

  // getInstallSourceInfo needs API 30; minSdk is 28.
  private fun installerPackage(): String? {
    return try {
      val pm = activity.packageManager
      if (Build.VERSION.SDK_INT >= 30) {
        pm.getInstallSourceInfo(activity.packageName).installingPackageName
      } else {
        @Suppress("DEPRECATION")
        pm.getInstallerPackageName(activity.packageName)
      }
    } catch (e: PackageManager.NameNotFoundException) {
      null
    }
  }

  private companion object {
    const val TAG = "InAppUpdate"
  }
}
