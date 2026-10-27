package com.sirbepy.conductor.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalLinkPolicyTest {
  @Test
  fun webAndMailLinksAreAllowed() {
    assertTrue(ExternalLinkPolicy.isAllowed("https://example.com/x?y=1"))
    assertTrue(ExternalLinkPolicy.isAllowed("http://example.com"))
    assertTrue(ExternalLinkPolicy.isAllowed("mailto:joe@example.com"))
  }

  @Test
  fun theSchemeMatchIsCaseInsensitiveAndIgnoresSurroundingSpace() {
    assertTrue(ExternalLinkPolicy.isAllowed("HTTPS://example.com"))
    assertTrue(ExternalLinkPolicy.isAllowed("  Mailto:joe@example.com "))
  }

  @Test
  fun localAndCodeSchemesAreRefused() {
    assertFalse(ExternalLinkPolicy.isAllowed("file:///sdcard/secret.txt"))
    assertFalse(ExternalLinkPolicy.isAllowed("javascript:alert(1)"))
    assertFalse(ExternalLinkPolicy.isAllowed("intent://scan/#Intent;scheme=zxing;end"))
    assertFalse(ExternalLinkPolicy.isAllowed("content://com.android.contacts/contacts"))
    assertFalse(ExternalLinkPolicy.isAllowed("tel:+385123456"))
  }

  @Test
  fun aSchemeThatMerelyStartsWithAnAllowedOneIsRefused() {
    assertFalse(ExternalLinkPolicy.isAllowed("httpx://example.com"))
    assertFalse(ExternalLinkPolicy.isAllowed("https-evil://example.com"))
  }

  @Test
  fun schemelessOrEmptyInputIsRefused() {
    assertFalse(ExternalLinkPolicy.isAllowed(""))
    assertFalse(ExternalLinkPolicy.isAllowed("example.com/path"))
    assertFalse(ExternalLinkPolicy.isAllowed(":https://example.com"))
  }
}
