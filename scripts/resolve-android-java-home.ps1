# Shared JDK selection for Android builds. Dot-source this, then call
# Resolve-AndroidJavaHome. See .claude/todos/1079-android-build-script-picks-up-jdk-25-and-gradle-fails.md:
# this machine's JAVA_HOME is now JDK 25 machine-wide, and Gradle 8.14.3
# (android/src-tauri/gen/android's wrapper) cannot run on it - it dies with
# "Unsupported class file major version 69" (69 is JDK 25's class file version).
# Android Studio's jbr is the JDK the Android Gradle plugin ships with and is
# tested against, so prefer it unconditionally over whatever JAVA_HOME happens
# to be, then fall back to JAVA_HOME only if it resolves to a known-compatible
# major version.

# jbr itself ships JDK 21 (verified on this machine 2026-10-06), which AGP
# 8.11.0 / Gradle 8.14.3 are known to run on. Treat that as the compatibility
# ceiling: JDK 25 is confirmed broken (todo 1079), and anything newer than jbr's
# own version is unverified on this wrapper, so refuse rather than guess.
$script:MaxKnownGoodJdkMajor = 21

function Get-JavaMajorVersion {
    param([Parameter(Mandatory)][string]$JavaHome)
    $javaExe = Join-Path $JavaHome "bin\java.exe"
    if (-not (Test-Path $javaExe)) { return $null }
    $output = & $javaExe -version 2>&1 | Out-String
    # Old versioning (<=8): `java version "1.8.0_392"` - major is the second group.
    # Modern versioning (9+): `openjdk version "21.0.6"` - major is the first group.
    if ($output -match 'version "1\.(\d+)') {
        return [int]$Matches[1]
    }
    if ($output -match 'version "(\d+)') {
        return [int]$Matches[1]
    }
    return $null
}

function Resolve-AndroidJavaHome {
    # Returns a Gradle-compatible JAVA_HOME path, or $null if none could be found.
    # Writes a Warning when a candidate JAVA_HOME was rejected for being too new,
    # so the refusal is visible instead of looking like silent misdetection.
    $jbrPath = "C:\Program Files\Android\Android Studio\jbr"
    if (Test-Path $jbrPath) {
        return $jbrPath
    }

    if (-not $env:JAVA_HOME -or -not (Test-Path $env:JAVA_HOME)) {
        return $null
    }

    $major = Get-JavaMajorVersion -JavaHome $env:JAVA_HOME
    if ($null -ne $major -and $major -gt $script:MaxKnownGoodJdkMajor) {
        Write-Warning ("JAVA_HOME ($env:JAVA_HOME) is JDK $major; Gradle 8.14.3 cannot run on it " +
            "(JDK 25 confirmed broken, todo 1079). Install Android Studio for its bundled jbr, " +
            "or point JAVA_HOME at a JDK <= $($script:MaxKnownGoodJdkMajor).")
        return $null
    }

    return $env:JAVA_HOME
}
