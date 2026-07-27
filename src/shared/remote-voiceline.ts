// Mirrors character voicelines onto the remote (phone/browser) client. The
// desktop app plays these natively via rodio; a remote browser tab has no
// such pipe, so it fetches a resolved data URL from the daemon
// (`resolve_voiceline`, gated by the same mute/whitelist rules as the
// desktop's `notifications::fire`) and plays it itself the moment the
// matching `turn_sound` event lands on the global stream. Every fire mirrors
// - no separate "replay" affordance.

import { invoke } from "./ipc";
import { getTransport, isRemote } from "./transport";

interface TurnSoundPayload {
  session_id?: string | null;
  cwd?: string | null;
  awaiting?: string | null;
}

async function playVoiceline(p: TurnSoundPayload): Promise<void> {
  if (p.awaiting !== "done" && p.awaiting !== "question") return;
  let url: string | null = null;
  try {
    url = await invoke<string | null>("resolve_voiceline", {
      sessionId: p.session_id ?? null,
      cwd: p.cwd ?? null,
      awaiting: p.awaiting,
    });
  } catch (err) {
    console.warn("[remote-voiceline] resolve_voiceline failed", err);
    return;
  }
  if (!url) return;
  try {
    await new Audio(url).play();
  } catch (err) {
    console.warn("[remote-voiceline] playback failed", err);
  }
}

/** Wires the `turn_sound` -> `resolve_voiceline` -> play pipeline. No-op on
 *  desktop (the native rodio path already covers it there). */
export function setupRemoteVoicelines(): void {
  if (!isRemote()) return;
  void getTransport().listen<TurnSoundPayload>("turn-sound", (p) => {
    void playVoiceline(p);
  });
}
