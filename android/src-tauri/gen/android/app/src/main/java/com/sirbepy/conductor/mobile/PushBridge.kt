package com.sirbepy.conductor.mobile

import android.content.Context
import android.webkit.JavascriptInterface

// Exposed to the daemon-served SPA as window.ConductorPush. It is only reachable
// from pages the WebView loads, which is the user's own daemon.
class PushBridge(private val context: Context) {
  @JavascriptInterface
  fun getHandle(): String = PushRelay.handleJson(context)
}
