package com.sirbepy.conductor.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatDelegate
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

// Returns "true" only once the daemon-served SPA has installed its hook
// (src/shared/back-button.ts); the bundled setup page never does.
private const val BACK_HOOK_JS =
  "(function(){try{return !!(window.__ccHandleBack && window.__ccHandleBack() === true)}catch(e){return false}})()"

private const val LOCK_BACKGROUND = "#0f1117"

class MainActivity : TauriActivity() {
  // The WebView keeps loading (and connecting to the PC) underneath an opaque
  // lock screen, so unlocking shows a ready app instead of starting the load.
  // The lock screen eats every touch, and dispatchKeyEvent eats every key, so
  // nothing reaches the app until the phone's own fingerprint/PIN passes.
  private var locked = true
  private var promptShowing = false
  private var disablePromptShowing = false
  private var backgroundedAt: Long? = null
  // When the app itself started another activity (the WebView's file or camera
  // picker), so a stop right after it is not a trip away from the app. A time,
  // not a flag: a launch that never stops this activity must not leave a grace
  // armed for a later real trip away.
  private var ownLaunchedAt: Long? = null
  private var askShowing = false
  private lateinit var lockScreen: View
  private var webView: WebView? = null
  private var pendingChatId: String? = null

  // The result is ignored: a denial just means no banners, and Android stops
  // re-showing the dialog on its own after repeated denials.
  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    // App always renders dark (frontend forces color-scheme: dark via CSS); lock
    // night-mode so native chrome (status/nav bar via enableEdgeToEdge's auto style)
    // doesn't leak the phone's system light/dark setting.
    AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    lockScreen = buildLockScreen()
    attachLockScreen()
    PushRelay.ensureRegistered(this)
    pendingChatId = intent?.getStringExtra(EXTRA_CHAT_ID)
  }

  // singleTask: a notification tap while the app is open arrives here, not onCreate.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // A launcher re-open carries no chat; it must not drop a tap held while locked.
    intent.getStringExtra(EXTRA_CHAT_ID)?.let { pendingChatId = it }
    deliverPendingChat()
  }

  // Held while locked so a tap never shows a chat behind the lock screen. The SPA
  // may not have installed __ccOpenChat yet right after launch, so a miss retries;
  // `attempt` is per call chain so overlapping chains do not eat each other's budget.
  // A chain sticks to the chat it started with: once a newer tap replaces
  // `pendingChatId`, the old chain stops, so its give-up never clears the new one.
  private fun deliverPendingChat(attempt: Int = 0, chainId: String? = null) {
    val id = pendingChatId ?: return
    if (chainId != null && chainId != id) return
    val view = webView ?: return
    if (locked) return
    val js = "(function(id){if(window.__ccOpenChat){window.__ccOpenChat(id);return true}return false})(${JSONObject.quote(id)})"
    view.evaluateJavascript(js) { result ->
      if (result == "true" || !PushPolicy.shouldRetryOpenChat(attempt + 1)) {
        if (pendingChatId == id) pendingChatId = null
      } else {
        view.postDelayed({ deliverPendingChat(attempt + 1, id) }, 1000)
      }
    }
  }

  // Wry hands the WebView over with setContentView, which drops every view
  // already in the content frame, the lock screen included. Re-adding it on
  // top here keeps it covering the WebView however late that arrives.
  override fun setContentView(view: View?) {
    super.setContentView(view)
    attachLockScreen()
  }

  override fun setContentView(view: View?, params: ViewGroup.LayoutParams?) {
    super.setContentView(view, params)
    attachLockScreen()
  }

  private fun attachLockScreen() {
    if (!this::lockScreen.isInitialized) return
    (lockScreen.parent as? ViewGroup)?.removeView(lockScreen)
    addContentView(lockScreen, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  // The WebView's file and camera pickers launch through here with a real
  // request code. A plain startActivity (an external link, the share sheet)
  // also lands here, with requestCode -1, and leaves the app like any other
  // trip away, so it gets no grace. The notification permission dialog is a
  // translucent overlay that pauses the app but never stops it.
  override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
    if (requestCode >= 0) ownLaunchedAt = SystemClock.elapsedRealtime()
    super.startActivityForResult(intent, requestCode, options)
  }

  // Reached without a stop (an overlay that only paused the app) or after
  // onStart already consumed the launch: either way the launch is spent.
  override fun onResume() {
    super.onResume()
    ownLaunchedAt = null
  }

  override fun onStart() {
    super.onStart()
    val ownStop = AppLockPolicy.isOwnActivityStop(ownLaunchedAt, backgroundedAt)
    ownLaunchedAt = null
    when (AppLockPolicy.startAction(AppLockSettings.lockEnabled(this), phoneHasScreenLock(this))) {
      AppLockPolicy.StartAction.ASK -> {
        backgroundedAt = null
        askToLock()
      }
      AppLockPolicy.StartAction.OPEN -> {
        backgroundedAt = null
        if (locked) unlock() else showApp()
      }
      AppLockPolicy.StartAction.LOCK -> {
        val relockMinutes = AppLockSettings.relockMinutes(this)
        if (!locked && AppLockPolicy.shouldRelock(backgroundedAt, SystemClock.elapsedRealtime(), relockMinutes, ownStop)) lock()
        backgroundedAt = null
        // Posted: BiometricPrompt needs the activity resumed, which onStart isn't yet.
        if (locked) lockScreen.post { promptUnlock() } else showApp()
      }
    }
  }

  // Shown over the lock screen before the unlock prompt, on the first launch
  // with a screen lock set. The answer is saved and never asked again.
  private fun askToLock() {
    if (askShowing || isFinishing) return
    askShowing = true
    AlertDialog.Builder(this)
      .setTitle("Lock Conductor?")
      .setMessage("This phone can control your PC's chats, so we recommend locking the app with your fingerprint or screen lock. You can change this later in Settings > Remote access > App lock.")
      .setCancelable(false)
      .setPositiveButton("Lock it (recommended)") { _, _ ->
        askShowing = false
        AppLockSettings.setLockEnabled(this, true)
        // The app is already open when the screen lock was added after first
        // launch, and promptUnlock does nothing unless the app is locked.
        lock()
        promptUnlock()
      }
      .setNegativeButton("Not now") { _, _ ->
        askShowing = false
        AppLockSettings.setLockEnabled(this, false)
        unlock()
      }
      .show()
  }

  override fun onStop() {
    super.onStop()
    OnScreen.appVisible = false
    if (!locked) backgroundedAt = SystemClock.elapsedRealtime()
  }

  // Coming back to an open chat counts as viewing it.
  private fun showApp() {
    OnScreen.appVisible = true
    OnScreen.clearShownChat(this)
  }

  // A hardware keyboard would otherwise type into the focused composer behind
  // the lock screen. Back still runs, and installBackHook sends it home.
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (locked && event.keyCode != KeyEvent.KEYCODE_BACK) return true
    return super.dispatchKeyEvent(event)
  }

  private fun lock() {
    locked = true
    OnScreen.appVisible = false
    lockScreen.visibility = View.VISIBLE
    lockScreen.bringToFront()
  }

  private fun unlock() {
    locked = false
    lockScreen.visibility = View.GONE
    showApp()
    askNotificationPermissionOnce()
    deliverPendingChat()
  }

  // After unlock, so the dialog never covers the app-lock prompt.
  private fun askNotificationPermissionOnce() {
    if (Build.VERSION.SDK_INT < 33) return
    val prefs = getSharedPreferences("conductor_push", MODE_PRIVATE)
    if (prefs.getBoolean("asked_notifications", false)) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    prefs.edit().putBoolean("asked_notifications", true).apply()
    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
  }

  private fun promptUnlock() {
    if (!locked || promptShowing || isFinishing) return
    if (!phoneHasScreenLock(this)) {
      // No fingerprint, PIN, pattern or password on the phone at all: there is
      // nothing to check against, and the phone itself is open to anyone.
      Log.w("AppLock", "no screen lock set on this phone; app lock skipped")
      unlock()
      return
    }
    val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        promptShowing = false
        unlock()
      }

      // Cancel, too many tries, or the prompt closed by leaving the app: send
      // the app to the background, still locked. Re-prompting in place would
      // trap the user in the prompt; the next return asks again (onStart).
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        promptShowing = false
        moveTaskToBack(true)
      }
    })
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Unlock Conductor")
      .setSubtitle("This phone can control your PC's chats")
      .setAllowedAuthenticators(UNLOCK_AUTHENTICATORS)
      .build()
    promptShowing = true
    prompt.authenticate(info)
  }

  // Switching the lock off from Settings: the same prompt as the unlock, so a
  // script that calls the bridge cannot drop the lock without the phone's owner.
  // Declined while locked or while another prompt is up, never queued.
  private fun confirmUnlockForDisable(onDone: (Boolean) -> Unit) {
    runOnUiThread {
      if (locked || promptShowing || disablePromptShowing || isFinishing) {
        onDone(false)
        return@runOnUiThread
      }
      val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          disablePromptShowing = false
          onDone(true)
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          disablePromptShowing = false
          onDone(false)
        }
      })
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Turn off app lock")
        .setSubtitle("Confirm it's you")
        .setAllowedAuthenticators(UNLOCK_AUTHENTICATORS)
        .build()
      disablePromptShowing = true
      prompt.authenticate(info)
    }
  }

  // A bare cover, nothing to press: the prompt is the only way in, and it
  // opens on its own every time the app comes to the front.
  private fun buildLockScreen(): View {
    return View(this).apply {
      setBackgroundColor(Color.parseColor(LOCK_BACKGROUND))
      isClickable = true
      isFocusable = true
    }
  }

  // Chromium's algorithmic darkening would otherwise re-darken the already-dark
  // page CSS now that we're always in night mode - opt out explicitly.
  override fun onWebViewCreate(webView: WebView) {
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
      WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
    }
    installBackHook(webView)
    this.webView = webView
    webView.addJavascriptInterface(PushBridge(this), "ConductorPush")
    webView.addJavascriptInterface(ExternalLinkBridge(this), "ConductorLinks")
    webView.addJavascriptInterface(
      AppLockBridge(this, ::confirmUnlockForDisable) { js -> runOnUiThread { webView.evaluateJavascript(js, null) } },
      "ConductorLock",
    )
    PushRelay.onHandleReady = {
      webView.evaluateJavascript("window.__ccPushHandleReady && window.__ccPushHandleReady()", null)
    }
    deliverPendingChat()
  }

  // Tauri's AppPlugin answers back with WebView.goBack(), which only works if the
  // SPA's pushState history trap survives - and Chromium skips entries pushed
  // without a user gesture, so back walked past it and closed the app. Hand the
  // press to the SPA instead. The dispatcher runs the newest callback first, so
  // this relies on AppPlugin registering its own before the WebView is created.
  private fun installBackHook(webView: WebView) {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // Locked: the SPA must not act on it, so back just leaves the app.
        if (locked) {
          moveTaskToBack(true)
          return
        }
        webView.evaluateJavascript(BACK_HOOK_JS) { result ->
          if (result == "true") return@evaluateJavascript
          // No SPA hook (setup screen, page still loading): AppPlugin's default.
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        }
      }
    })
  }
}
