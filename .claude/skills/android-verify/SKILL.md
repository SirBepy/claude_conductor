---
name: android-verify
description: Use to build, install, launch, screenshot and logcat-check the Android app (android/) on a real connected device. Triggers on "verify android", "test the android build", "run it on the phone", /android-verify.
---

# android-verify

One command for the build -> install -> launch -> screenshot -> logcat loop for `android/`, with
every trap from repeated manual runs (2026-08-05, 2026-08-09) baked in rather than documented.

## Invoke

```powershell
powershell -File .claude/skills/android-verify/verify.ps1 [-NoBuild] [-Logs]
```

- `-NoBuild` - skip the Gradle build, install + launch the newest existing APK under
  `android/src-tauri/gen/android/app/build/outputs/apk/`.
- `-Logs` - dump filtered logcat after launch (`chromium|Console|conductor|tauri|WebView|AndroidRuntime|RustStdoutStderr|FATAL`).

Screenshot lands at `.for_bepy/screenshots/<pid>-<ticks>/android-verify.png` (session subfolder per
project convention).

## What it does, and why each step is shaped this way

1. **Device check first.** Refuses to run if `adb devices -l` shows nothing, rather than failing
   confusingly several steps later. Prefers a real device over an emulator when both are attached -
   **the emulator gives both false positives and false negatives for this app; a real device is the
   only trustworthy verify target.**
2. **Build** (unless `-NoBuild`): `cargo tauri android build --target aarch64 --apk` from `android/`,
   with `ANDROID_HOME` / `NDK_HOME` / `JAVA_HOME` set inline in the same command string - PowerShell
   env vars set in an earlier tool call do not persist here.
3. **Signing check BEFORE install.** Verifies the built APK's cert SHA-256 against
   `C:\Users\tecno\.android-keystores\README.txt`'s recorded value using `apksigner verify --print-certs`.
   A mismatch fails loud, before touching the device - installing a differently-signed APK over the
   existing one throws `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and the only way through that error is
   `adb uninstall`, which wipes the device's stored server URL and pairing state.
4. **Install:** `adb install -r`.
5. **Launch:** `am force-stop` (clear any stuck instance), `input keyevent KEYCODE_WAKEUP` (an
   asleep/locked screen hangs `am start -W` indefinitely - discovered 2026-08-09), then
   `am start -n com.sirbepy.conductor.mobile/.MainActivity -W`.
6. **Screenshot:** `adb shell screencap -p /sdcard/x.png` + `adb pull` (with `MSYS_NO_PATHCONV=1`) +
   `adb shell rm`. Never `adb exec-out screencap -p > file.png` - PowerShell corrupts the PNG with a
   BOM.
7. **Logs** (if `-Logs`): `adb logcat -c` runs before launch every time (unfiltered logcat on this
   device is overwhelmingly `InputDispatcher` noise), then a filtered dump after launch.
8. **Cleanup:** kills only Gradle daemon processes, matched by command line containing
   `org.gradle.launcher.daemon.bootstrap.GradleDaemon`. Never a blanket `java.exe` kill - Android
   Studio shares the same JRE.

## Never

- Never uninstall the app to work around a signing mismatch without saying so first - that wipes
  device-local pairing state. Report the mismatch and stop.
- Never kill a `java.exe` that isn't a matched Gradle daemon.
