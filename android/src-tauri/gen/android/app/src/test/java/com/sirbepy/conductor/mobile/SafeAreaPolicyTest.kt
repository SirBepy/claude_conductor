package com.sirbepy.conductor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SafeAreaPolicyTest {
  @Test
  fun deviceInsetsBecomeCssPixels() {
    // The Flip4's 3-button bar: 144 device px at density 3.0 is 48 CSS px.
    assertEquals(48.0, SafeAreaPolicy.cssPixels(144, 3.0f).toDouble(), 0.001)
  }

  @Test
  fun anInsetNeverGoesNegativeAndABadDensityIsZero() {
    assertEquals(0.0, SafeAreaPolicy.cssPixels(-10, 3.0f).toDouble(), 0.001)
    assertEquals(0.0, SafeAreaPolicy.cssPixels(100, 0f).toDouble(), 0.001)
  }

  @Test
  fun theBiggerOfBarAndCutoutWins() {
    assertEquals(90, SafeAreaPolicy.edge(bar = 90, cutout = 40))
    assertEquals(130, SafeAreaPolicy.edge(bar = 90, cutout = 130))
  }

  @Test
  fun theApplyScriptWritesBothVariablesWithPlainDecimalPoints() {
    val js = SafeAreaPolicy.applyJs(24.5f, 48f)
    assertTrue(js, js.contains("setProperty('--safe-top','24.5px')"))
    assertTrue(js, js.contains("setProperty('--safe-bottom','48px')"))
  }

  @Test
  fun theDocumentStartScriptReadsTheBridgeAndWaitsForTheRootElement() {
    val js = SafeAreaPolicy.DOCUMENT_START_JS
    assertTrue(js, js.contains("ConductorInsets.top()"))
    assertTrue(js, js.contains("ConductorInsets.bottom()"))
    assertTrue(js, js.contains("DOMContentLoaded"))
  }
}
