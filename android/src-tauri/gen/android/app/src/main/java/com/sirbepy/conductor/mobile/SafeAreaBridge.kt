package com.sirbepy.conductor.mobile

import android.webkit.JavascriptInterface
import java.math.BigDecimal
import java.math.RoundingMode

// The system bars' size as CSS variables, fed from Kotlin because the WebView's
// own env(safe-area-inset-*) can report 0 under edge-to-edge while the 3-button
// nav bar still covers the bottom of the page (Joe's Flip4, 2026-11-16). The
// pages combine them as max(var(--safe-*), env(safe-area-inset-*)), so a WebView
// that does report the insets keeps working: src/styles/base.css (the SPA) and
// android/src/style.css (the pairing shell).
object SafeAreaPolicy {
  fun cssPixels(devicePx: Int, density: Float): Float =
    if (density <= 0f) 0f else maxOf(devicePx, 0) / density

  // A display cutout (a notch in landscape) can be taller than the status bar.
  fun edge(bar: Int, cutout: Int): Int = maxOf(bar, cutout)

  private fun number(value: Float): String =
    BigDecimal(value.toDouble()).setScale(2, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

  // For an insets change on a page that is already loaded.
  fun applyJs(topCss: Float, bottomCss: Float): String =
    "(function(){var r=document.documentElement;if(!r)return;" +
      "r.style.setProperty('--safe-top','${number(topCss)}px');" +
      "r.style.setProperty('--safe-bottom','${number(bottomCss)}px')})()"

  // Runs before every page's own scripts, so the shell, the SPA after the handoff
  // and a reload all start with the right bars. The root element may not exist yet
  // at document start, so a miss retries once the DOM is parsed.
  const val DOCUMENT_START_JS =
    "(function(){function a(){var r=document.documentElement;if(!r||!window.ConductorInsets)return false;" +
      "r.style.setProperty('--safe-top',ConductorInsets.top()+'px');" +
      "r.style.setProperty('--safe-bottom',ConductorInsets.bottom()+'px');return true}" +
      "if(!a())document.addEventListener('DOMContentLoaded',a)})()"
}

// Exposed as window.ConductorInsets. Only two numbers, so any origin the WebView
// loads (the shell, the daemon's loopback tunnel) may read them.
class SafeAreaBridge {
  @Volatile private var topCss = 0f
  @Volatile private var bottomCss = 0f

  fun update(top: Float, bottom: Float) {
    topCss = top
    bottomCss = bottom
  }

  @JavascriptInterface
  fun top(): Float = topCss

  @JavascriptInterface
  fun bottom(): Float = bottomCss
}
