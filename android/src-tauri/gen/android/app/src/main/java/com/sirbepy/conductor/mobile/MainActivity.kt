package com.sirbepy.conductor.mobile

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatDelegate
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

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
  }
}
