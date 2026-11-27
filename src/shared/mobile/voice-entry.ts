// The SPA's way into the Android app's offline voice recorder (docs/architecture/voice-notes.md).
// The recorder lives in the bundled shell page, not in this daemon-served SPA, so the mic head
// asks the native `ConductorVoice` bridge to load it. Only an APK that has `openRecorder`
// (bridge version 2) offers the head: an older build, a phone browser and the desktop see none.

interface VoiceBridge {
  openRecorder?: (view: string) => string;
  state?: () => string;
}

function bridge(): VoiceBridge | null {
  if (typeof window === "undefined") return null;
  return (window as { ConductorVoice?: VoiceBridge }).ConductorVoice ?? null;
}

export function voiceEntryAvailable(): boolean {
  return typeof bridge()?.openRecorder === "function";
}

/** True while a note is being taken (paused for a call counts): the head shows a live dot. */
export function voiceRecording(): boolean {
  const state = bridge()?.state;
  if (typeof state !== "function") return false;
  try {
    const status = (JSON.parse(state.call(bridge())) as { status?: string }).status;
    return status === "recording" || status === "paused";
  } catch {
    return false;
  }
}

/** Leaves the SPA for the bundled recorder. Returns false when the bridge refused (app lock up) or is absent. */
export function openVoiceRecorder(): boolean {
  const b = bridge();
  if (typeof b?.openRecorder !== "function") return false;
  try {
    return (JSON.parse(b.openRecorder("recorder")) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** The native side calls `window.__ccVoiceChanged()` on every recorder or index change; `onChange` runs then. */
export function watchVoiceChanges(onChange: () => void): void {
  (window as { __ccVoiceChanged?: () => void }).__ccVoiceChanged = onChange;
}
