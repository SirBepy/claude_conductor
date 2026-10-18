package com.sirbepy.conductor.mobile

import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatDelegate
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

// Returns "true" only once the daemon-served SPA has installed its hook
// (src/shared/back-button.ts); the bundled setup page never does.
private const val BACK_HOOK_JS =
  "(function(){try{return !!(window.__ccHandleBack && window.__ccHandleBack() === true)}catch(e){return false}})()"

// BIOMETRIC_WEAK, not STRONG: STRONG | DEVICE_CREDENTIAL is unsupported on
// API 28-29 (minSdk is 28), and the PIN fallback is the point.
private const val UNLOCK_AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
private const val LOCK_BACKGROUND = "#0f1117"

class MainActivity : TauriActivity() {
  // The WebView keeps loading (and connecting to the PC) underneath an opaque
  // lock screen, so unlocking shows a ready app instead of starting the load.
  // The lock screen eats every touch, and dispatchKeyEvent eats every key, so
  // nothing reaches the app until the phone's own fingerprint/PIN passes.
  private var locked = true
  private var promptShowing = false
  private var backgroundedAt: Long? = null
  private lateinit var lockScreen: View

  override fun onCreate(savedInstanceState: Bundle?) {
    // App always renders dark (frontend forces color-scheme: dark via CSS); lock
    // night-mode so native chrome (status/nav bar via enableEdgeToEdge's auto style)
    // doesn't leak the phone's system light/dark setting.
    AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    lockScreen = buildLockScreen()
    attachLockScreen()
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

  override fun onStart() {
    super.onStart()
    if (!locked && AppLockPolicy.shouldRelock(backgroundedAt, SystemClock.elapsedRealtime())) lock()
    backgroundedAt = null
    // Posted: BiometricPrompt needs the activity resumed, which onStart isn't yet.
    if (locked) lockScreen.post { promptUnlock() }
  }

  override fun onStop() {
    super.onStop()
    if (!locked) backgroundedAt = SystemClock.elapsedRealtime()
  }

  // A hardware keyboard would otherwise type into the focused composer behind
  // the lock screen. Back still runs, and installBackHook sends it home.
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (locked && event.keyCode != KeyEvent.KEYCODE_BACK) return true
    return super.dispatchKeyEvent(event)
  }

  private fun lock() {
    locked = true
    lockScreen.visibility = View.VISIBLE
    lockScreen.bringToFront()
  }

  private fun unlock() {
    locked = false
    lockScreen.visibility = View.GONE
  }

  private fun promptUnlock() {
    if (!locked || promptShowing || isFinishing) return
    val canAuth = BiometricManager.from(this).canAuthenticate(UNLOCK_AUTHENTICATORS)
    if (canAuth == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) {
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
