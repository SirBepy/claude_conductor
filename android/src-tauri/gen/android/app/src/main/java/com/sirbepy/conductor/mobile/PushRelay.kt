package com.sirbepy.conductor.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import java.net.HttpURLConnection
import java.net.URL

private const val RELAY_BASE = "https://europe-west1-claude-conductor-62582.cloudfunctions.net/relay"
private const val PREFS = "conductor_push"
private const val TAG = "PushRelay"
private const val DIRTY = "token_dirty"

// Keeps the FCM token registered with the relay and the relay's {handle, secret}
// in a private prefs file. All network work runs on a plain thread.
object PushRelay {
  // Set by MainActivity so a registration that lands after the page loaded can
  // tell the SPA to re-read the handle.
  @Volatile var onHandleReady: (() -> Unit)? = null

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())

  fun handleJson(context: Context): String {
    val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return PushPolicy.handleJson(p.getString("handle", null), p.getString("secret", null))
  }

  // App start: registers when nothing is stored yet, and re-syncs a token whose
  // last /update or /register failed; onNewToken covers rotation.
  fun ensureRegistered(context: Context) {
    val app = context.applicationContext
    val dirty = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(DIRTY, false)
    if (!PushPolicy.needsSyncAtStart(handleJson(app).isNotEmpty(), dirty)) return
    FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> sync(app, token) }
  }

  fun sync(context: Context, token: String) {
    val app = context.applicationContext
    Thread {
      // Serialised: a token rotation racing the app-start registration would
      // otherwise create two handles and keep only one.
      synchronized(lock) {
        try {
          val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          // Dirty until the relay confirms it holds this token; an exception
          // anywhere below leaves it set for the next app start.
          prefs.edit().putString("token", token).putBoolean(DIRTY, true).apply()
          val handle = prefs.getString("handle", null)
          val secret = prefs.getString("secret", null)
          if (handle != null && secret != null) {
            val outcome = PushPolicy.afterUpdate(post("/update", PushPolicy.updateBody(handle, secret, token)).first)
            if (PushPolicy.updateLeavesTokenClean(outcome)) prefs.edit().putBoolean(DIRTY, false).apply()
            if (outcome != PushPolicy.AfterUpdate.REGISTER_FRESH) return@synchronized
          }
          register(app, token)
        } catch (e: Exception) {
          Log.w(TAG, "relay sync failed", e)
        }
      }
    }.start()
  }

  private fun register(app: Context, token: String) {
    val (status, body) = post("/register", PushPolicy.registerBody(token))
    val handle = PushPolicy.parseField(body, "handle")
    val secret = PushPolicy.parseField(body, "secret")
    if (status != 200 || handle == null || secret == null) {
      Log.w(TAG, "register failed: $status")
      return
    }
    app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString("handle", handle).putString("secret", secret).putBoolean(DIRTY, false).apply()
    main.post { onHandleReady?.invoke() }
  }

  private fun post(path: String, json: String): Pair<Int, String> {
    val conn = URL(RELAY_BASE + path).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
      val status = conn.responseCode
      val stream = if (status in 200..299) conn.inputStream else conn.errorStream
      val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
      return status to body
    } finally {
      conn.disconnect()
    }
  }
}
