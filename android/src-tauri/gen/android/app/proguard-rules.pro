# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Rust calls MainActivity.getPluginManager() (inherited from generated TauriActivity)
# over JNI by exact name/signature. The generated proguard-wry.pro only keeps a fixed
# member list on WryActivity, not TauriActivity's getPluginManager(), so R8 renames it
# on a minified release build and JNI's reflective lookup fails with NoSuchMethodError.
# See .claude/todos/504-android-build-not-reproducible.md - same crash signature, different cause.
-keep class com.sirbepy.conductor.mobile.MainActivity { *; }
-keep class com.sirbepy.conductor.mobile.TauriActivity { *; }
-keep class app.tauri.** { *; }