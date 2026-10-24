package com.sirbepy.conductor.mobile

// Pure decisions behind push, kept free of Android types so they unit-test on the JVM.
object PushPolicy {
  const val DEFAULT_BODY = "A chat is waiting on you"

  fun bodyFor(chatName: String?): String = if (chatName.isNullOrBlank()) DEFAULT_BODY else chatName

  // Same id and tag per chat, so a second alert for one chat replaces its banner.
  fun notificationId(chatId: String): Int = chatId.hashCode()

  enum class AfterUpdate { DONE, REGISTER_FRESH, RETRY_LATER }

  // 401/404 mean the relay forgot this handle or rejected its secret; only a new
  // registration can recover. Anything else is transient, so the handle is kept.
  fun afterUpdate(status: Int): AfterUpdate = when (status) {
    200, 204 -> AfterUpdate.DONE
    401, 404 -> AfterUpdate.REGISTER_FRESH
    else -> AfterUpdate.RETRY_LATER
  }

  // The SPA reads this string verbatim; "" means nothing registered yet.
  fun handleJson(handle: String?, secret: String?): String {
    if (handle.isNullOrEmpty() || secret.isNullOrEmpty()) return ""
    return "{\"handle\":\"${escape(handle)}\",\"secret\":\"${escape(secret)}\"}"
  }

  // org.json is a stub on the JVM unit-test classpath, so the flat string fields
  // of the relay reply are read by hand.
  fun parseField(json: String, key: String): String? {
    val m = Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(json) ?: return null
    return unescape(m.groupValues[1])
  }

  fun registerBody(token: String) = "{\"token\":\"${escape(token)}\"}"

  fun updateBody(handle: String, secret: String, token: String) =
    "{\"handle\":\"${escape(handle)}\",\"secret\":\"${escape(secret)}\",\"token\":\"${escape(token)}\"}"

  private fun escape(s: String): String {
    val sb = StringBuilder()
    for (c in s) when (c) {
      '"' -> sb.append("\\\"")
      '\\' -> sb.append("\\\\")
      '\n' -> sb.append("\\n")
      '\r' -> sb.append("\\r")
      '\t' -> sb.append("\\t")
      else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
    }
    return sb.toString()
  }

  private fun unescape(s: String): String {
    val sb = StringBuilder()
    var i = 0
    while (i < s.length) {
      val c = s[i]
      if (c != '\\' || i + 1 >= s.length) { sb.append(c); i++; continue }
      val n = s[i + 1]
      if (n == 'u' && i + 6 <= s.length) {
        sb.append(s.substring(i + 2, i + 6).toInt(16).toChar())
        i += 6
        continue
      }
      sb.append(when (n) { 'n' -> '\n'; 'r' -> '\r'; 't' -> '\t'; else -> n })
      i += 2
    }
    return sb.toString()
  }
}
