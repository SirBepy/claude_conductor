package com.sirbepy.conductor.mobile

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface

// Which URLs the SPA may hand to the phone's other apps. Anything else (javascript:,
// intent:, file:, content:, custom app schemes) could launch an arbitrary component
// or read local files, so it is refused rather than passed to ACTION_VIEW.
object ExternalLinkPolicy {
  private val allowedSchemes = setOf("http", "https", "mailto")

  fun isAllowed(url: String): Boolean {
    val trimmed = url.trim()
    val colon = trimmed.indexOf(':')
    if (colon <= 0) return false
    return trimmed.substring(0, colon).lowercase() in allowedSchemes
  }
}

// Exposed to the daemon-served SPA as window.ConductorLinks. A window.open from the
// WebView would load the page inside the app (no multi-window support), replacing
// the SPA, so external links leave through an intent instead.
class ExternalLinkBridge(private val context: Context) {
  @JavascriptInterface
  fun openExternal(url: String) {
    if (!ExternalLinkPolicy.isAllowed(url)) {
      Log.w(TAG, "refused external link with a disallowed scheme")
      return
    }
    // NEW_TASK because the bridge thread's context may not be an activity context.
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url.trim())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      Log.w(TAG, "no app can open the external link")
    }
  }

  private companion object {
    const val TAG = "ExternalLinkBridge"
  }
}
