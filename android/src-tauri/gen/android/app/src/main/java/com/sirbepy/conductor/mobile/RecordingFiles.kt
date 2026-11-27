package com.sirbepy.conductor.mobile

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Naming and the `.part` protocol. A recording is written as `<base>.opus.part`
// and renamed to `<base>.opus` only once it is complete, so anything that reads
// the folder (the uploader, a person over USB) never takes half a recording for
// a finished one. Ported from handy_scripts' android-recorder.
object RecordingFiles {
  const val FINAL_EXT = ".opus"
  const val PART_SUFFIX = ".part"

  // `2026-11-26_18-05-09`: sorts by time and has no characters Windows rejects.
  fun baseName(nowMs: Long, zone: TimeZone = TimeZone.getDefault()): String {
    val format = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT)
    format.timeZone = zone
    return format.format(Date(nowMs))
  }

  // `base`, or `base_2`, `base_3`... when either of its files already exists.
  fun uniqueBase(dir: File, base: String): String {
    var candidate = base
    var n = 2
    while (File(dir, candidate + FINAL_EXT).exists() ||
      File(dir, candidate + FINAL_EXT + PART_SUFFIX).exists()
    ) {
      candidate = "${base}_$n"
      n++
    }
    return candidate
  }

  fun newPartFile(dir: File, nowMs: Long, zone: TimeZone = TimeZone.getDefault()): File {
    val base = uniqueBase(dir, baseName(nowMs, zone))
    return File(dir, base + FINAL_EXT + PART_SUFFIX)
  }

  fun isPart(file: File): Boolean = file.name.endsWith(FINAL_EXT + PART_SUFFIX)

  // The name a part will have once finished, before any collision suffix.
  fun finalNameOf(partName: String): String = partName.removeSuffix(PART_SUFFIX)

  // Renames a finished `.part` to its final name. An empty or missing part (a
  // recording stopped before any audio) is removed and yields null.
  fun finalize(part: File): File? {
    if (!part.exists()) return null
    if (part.length() == 0L) {
      part.delete()
      return null
    }
    val dir = part.parentFile ?: return null
    val base = part.name.removeSuffix(FINAL_EXT + PART_SUFFIX)
    var target = File(dir, base + FINAL_EXT)
    var n = 2
    while (target.exists()) {
      target = File(dir, "${base}_$n$FINAL_EXT")
      n++
    }
    return if (part.renameTo(target)) target else null
  }

  // Finishes parts left by a crash or a killed process. `active` is the part a
  // live recording is still writing; it is left alone.
  fun recoverOrphans(dir: File, active: File?): List<File> {
    val parts = dir.listFiles { f -> f.isFile && isPart(f) } ?: return emptyList()
    return parts
      .filter { it.absolutePath != active?.absolutePath }
      .mapNotNull { finalize(it) }
  }

  // Finished recordings, newest first.
  fun finished(dir: File): List<File> =
    (dir.listFiles { f -> f.isFile && f.name.endsWith(FINAL_EXT) } ?: emptyArray())
      .sortedByDescending { it.name }
}
