package com.sirbepy.conductor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushPolicyTest {
  @Test
  fun bodyUsesChatNameWhenPresent() {
    assertEquals("Fix login bug", PushPolicy.bodyFor("Fix login bug"))
  }

  @Test
  fun bodyFallsBackWhenNameMissingOrBlank() {
    assertEquals("A chat is waiting on you", PushPolicy.bodyFor(null))
    assertEquals("A chat is waiting on you", PushPolicy.bodyFor("  "))
  }

  @Test
  fun notificationIdIsStablePerChat() {
    assertEquals(PushPolicy.notificationId("chat-a"), PushPolicy.notificationId("chat-a"))
    assertNotEquals(PushPolicy.notificationId("chat-a"), PushPolicy.notificationId("chat-b"))
  }

  @Test
  fun updateOutcomesMapToNextStep() {
    assertEquals(PushPolicy.AfterUpdate.DONE, PushPolicy.afterUpdate(204))
    assertEquals(PushPolicy.AfterUpdate.REGISTER_FRESH, PushPolicy.afterUpdate(401))
    assertEquals(PushPolicy.AfterUpdate.REGISTER_FRESH, PushPolicy.afterUpdate(404))
    assertEquals(PushPolicy.AfterUpdate.RETRY_LATER, PushPolicy.afterUpdate(500))
  }

  @Test
  fun handleJsonIsEmptyUntilRegistered() {
    assertEquals("", PushPolicy.handleJson(null, null))
    assertEquals("", PushPolicy.handleJson("h", ""))
  }

  @Test
  fun handleJsonEncodesAndEscapes() {
    assertEquals("{\"handle\":\"h1\",\"secret\":\"s\\\"q\"}", PushPolicy.handleJson("h1", "s\"q"))
  }

  @Test
  fun relayReplyFieldsAreParsed() {
    val reply = "{\"handle\": \"abc\", \"secret\":\"x\\\\y\"}"
    assertEquals("abc", PushPolicy.parseField(reply, "handle"))
    assertEquals("x\\y", PushPolicy.parseField(reply, "secret"))
    assertNull(PushPolicy.parseField(reply, "token"))
  }

  @Test
  fun requestBodiesCarryTheFields() {
    assertEquals("{\"token\":\"t\"}", PushPolicy.registerBody("t"))
    assertEquals("{\"handle\":\"h\",\"secret\":\"s\",\"token\":\"t\"}", PushPolicy.updateBody("h", "s", "t"))
  }
}
