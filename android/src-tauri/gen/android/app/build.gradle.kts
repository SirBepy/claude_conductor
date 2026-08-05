import java.util.Properties
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

// Fails at configuration time with the real fix, instead of letting Kotlin compilation
// surface a misleading "Unresolved reference: TauriActivity" - see .claude/todos/504.
val generatedTauriActivity = file("src/main/java/com/sirbepy/conductor/mobile/generated/TauriActivity.kt")
if (!generatedTauriActivity.exists()) {
    throw GradleException(
        "Missing generated/TauriActivity.kt (gitignored codegen output). Run `cargo tauri android " +
            "init` from android/ (or scripts/bootstrap-worktree.ps1) to regenerate it - do NOT add " +
            "an import or extend WryActivity instead, that crashes the app on launch."
    )
}

android {
    compileSdk = 36
    namespace = "com.sirbepy.conductor.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.sirbepy.conductor.mobile"
        minSdk = 28
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            // A missing keystore.properties must fail loud, not silently sign with a
            // different (debug/unsigned) identity - see .claude/todos/504.
            if (!keystorePropertiesFile.exists()) {
                throw GradleException(
                    "Release build requires gen/android/keystore.properties (gitignored, " +
                        "machine-specific) pointing at the shared release keystore. See " +
                        "C:\\Users\\tecno\\.android-keystores\\README.txt for the path + " +
                        "password. Refusing to build an unsigned/differently-signed release APK."
                )
            }
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")