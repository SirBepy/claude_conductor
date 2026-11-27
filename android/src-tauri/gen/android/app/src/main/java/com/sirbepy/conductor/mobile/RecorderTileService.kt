package com.sirbepy.conductor.mobile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

// The Quick Settings tile: one tap starts a voice note, the next stops it, with
// the app closed and the screen locked. Stopping is always allowed; starting
// needs the microphone permission, which only an activity can ask for, so a tile
// without it opens the app on the recorder.
class RecorderTileService : TileService() {
  // The tile redraws itself whenever the recorder changes while the shade is
  // open; it is only on screen while listening, so no listener lives past it.
  private val onChange: () -> Unit = { paint() }

  override fun onStartListening() {
    super.onStartListening()
    RecorderState.addListener(onChange)
    paint()
  }

  override fun onStopListening() {
    RecorderState.removeListener(onChange)
    super.onStopListening()
  }

  override fun onClick() {
    super.onClick()
    val micGranted = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED
    when (VoiceEntryPolicy.tileAction(Build.VERSION.SDK_INT, RecorderState.status, micGranted)) {
      VoiceEntryPolicy.TileAction.STOP -> RecorderService.stop(this)
      VoiceEntryPolicy.TileAction.START -> RecorderService.start(this)
      VoiceEntryPolicy.TileAction.ASK_IN_APP -> openApp()
      VoiceEntryPolicy.TileAction.UNSUPPORTED -> Unit
    }
    paint()
  }

  private fun openApp() {
    val intent = Intent(this, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      .putExtra(VoiceEntryPolicy.EXTRA_VOICE_OPEN, "record")
    if (Build.VERSION.SDK_INT >= 34) {
      startActivityAndCollapse(PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    } else {
      @Suppress("DEPRECATION")
      startActivityAndCollapse(intent)
    }
  }

  private fun paint() {
    val tile = qsTile ?: return
    val on = VoiceEntryPolicy.tileActive(RecorderState.status)
    tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
    tile.label = getString(R.string.voice_tile_label)
    if (Build.VERSION.SDK_INT >= 29) {
      tile.subtitle = getString(
        when (RecorderState.status) {
          RecorderState.Status.IDLE -> R.string.voice_tile_idle
          RecorderState.Status.RECORDING -> R.string.voice_tile_recording
          RecorderState.Status.PAUSED -> R.string.voice_tile_paused
        },
      )
    }
    tile.updateTile()
  }
}
