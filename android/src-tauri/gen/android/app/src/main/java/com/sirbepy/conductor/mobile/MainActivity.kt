package com.sirbepy.conductor.mobile

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatDelegate
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

// Returns "true" only once the daemon-served SPA has installed its hook
// (src/shared/back-button.ts); the bundled setup page never does.
private const val BACK_HOOK_JS =
  "(function(){try{return !!(window.__ccHandleBack && window.__ccHandleBack() === true)}catch(e){return false}})()"

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // App always renders dark (frontend forces color-scheme: dark via CSS); lock
    // night-mode so native chrome (status/nav bar via enableEdgeToEdge's auto style)
    // doesn't leak the phone's system light/dark setting.
    AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
