package com.sirbepy.conductor.mobile

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

// WryActivity (generated/WryActivity.kt) is the real base class - same
// package, no import needed. TauriActivity never existed in this version.
class MainActivity : WryActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
