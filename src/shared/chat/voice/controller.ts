// VoiceController: captures the mic, downsamples to 16 kHz mono Int16 PCM in an
// AudioWorklet, streams it to the daemon's /ws/transcribe, and surfaces the
// partial/final transcript via callbacks. No auto-stop: recording runs until
// the caller calls stop().
import { invoke } from "../../ipc";
import { isRemote } from "../../transport";
import { remoteToken } from "../../http-transport";
import { getSelectedMic, listMics } from "./voice-devices";

/** Runs the daemon's dictation-cleanup pass (a cheap haiku `claude -p` call
 *  that strips stutters/repeated words without rephrasing) on one finalized
 *  transcript. Throws on failure - callers keep the raw transcript rather
 *  than silently losing it. */
export async function cleanDictatedText(raw: string): Promise<string> {
  return invoke<string>("voice_clean_transcript", { text: raw });
}

export type VoiceState = "idle" | "connecting" | "recording" | "error";

export interface VoiceCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onStateChange: (state: VoiceState) => void;
}

// AudioWorklet processor source. Runs in AudioWorkletGlobalScope (no imports;
// `sampleRate` is a global there). Crude decimation to 16 kHz is fine for
// speech/Whisper; flushes ~250 ms binary frames of Int16 PCM to the main thread.
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = []; this._ratio = sampleRate / 16000; this._acc = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._acc += 1;
      if (this._acc >= this._ratio) { this._acc -= this._ratio; this._buf.push(ch[i]); }
    }
    if (this._buf.length >= 4000) {
      const out = new Int16Array(this._buf.length);
      for (let i = 0; i < this._buf.length; i++) {
        let s = Math.max(-1, Math.min(1, this._buf[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
      this._buf = [];
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

let _workletUrl: string | null = null;
function workletBlobUrl(): string {
  if (!_workletUrl) {
    _workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
  }
  return _workletUrl;
}

/** Resolve the daemon WS base + token. Phone reuses the served origin + paired
 *  token; desktop hits the daemon's localhost remote server with the
 *  remote-access token (read via IPC). */
async function voiceWsTarget(): Promise<{ base: string; token: string }> {
  if (isRemote()) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return { base: `${proto}://${location.host}`, token: remoteToken() };
  }
  let token = "";
  try {
    token = await invoke<string>("get_remote_access_token");
  } catch (e) {
    console.warn("[voice] get_remote_access_token failed", e);
  }
  return { base: "ws://127.0.0.1:27183", token };
}

/** Pre-spawn the daemon's STT sidecar and load the Whisper model *before* the
 *  user hits the mic, so the first real click flips straight to "recording"
 *  instead of sitting in "connecting" through a multi-second cold start. Opens a
 *  throwaway transcribe WS (no mic capture), waits for the sidecar's "ready"
 *  frame - which arrives once the model is resident - then closes. The daemon
 *  keeps the sidecar (and its loaded model) alive for its idle window, so the
 *  subsequent real connect reuses the warm model. Fire-and-forget; every failure
 *  is non-fatal (the click path still works cold). */
export async function warmVoiceEngine(): Promise<void> {
  try {
    const { base, token } = await voiceWsTarget();
    const url = `${base}/ws/transcribe?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closing */ }
        resolve();
      };
      // Cap the wait so a wedged sidecar never leaves the warm socket dangling.
      const timer = setTimeout(done, 30000);
      ws.onmessage = (e: MessageEvent) => {
        try {
          if ((JSON.parse(e.data as string) as { type: string }).type === "ready") done();
        } catch { /* ignore non-JSON frames */ }
      };
      ws.onerror = done;
      ws.onclose = () => { clearTimeout(timer); resolve(); };
    });
  } catch (e) {
    console.debug("[voice] warm failed (non-fatal)", e);
  }
}

export class VoiceController {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private recording = false;
  private lastLevelLog = 0;

  constructor(private cb: VoiceCallbacks) {}

  get isRecording(): boolean {
    return this.recording;
  }

  async start(): Promise<void> {
    if (this.recording) return;
    this.cb.onStateChange("connecting");
    try {
      const { base, token } = await voiceWsTarget();
      const url = `${base}/ws/transcribe?token=${encodeURIComponent(token)}`;
      // Capture the user's chosen mic (with 2+ mics the default is often the
      // wrong/idle one - that reads as silence). Fall back to the default if the
      // chosen device is gone.
      const micId = getSelectedMic();
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (micId) audioConstraints.deviceId = { exact: micId };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } catch (e) {
        if (micId) {
          console.warn("[voice] chosen mic unavailable, falling back to default", e);
          delete audioConstraints.deviceId;
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        } else {
          throw e;
        }
      }
      const track = this.stream.getAudioTracks()[0];
      console.debug(`[voice] capturing mic: ${track?.label || "(default device)"}`);
      void listMics().then((mics) =>
        console.debug("[voice] available mics:", mics.map((m) => m.label)),
      );
      this.ctx = new AudioContext();
      // Autoplay policy can start the context suspended, which feeds the worklet
      // zero-filled buffers (silence) instead of the mic - Whisper then
      // hallucinates caption boilerplate. Resume so real audio flows.
      if (this.ctx.state === "suspended") await this.ctx.resume();
      await this.ctx.audioWorklet.addModule(workletBlobUrl());
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "capture-processor");

      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        this.ws!.onopen = () => resolve();
        this.ws!.onerror = () => reject(new Error("voice connection failed"));
      });

      // The sidecar emits {type:"ready"} once the model is loaded (cold start can
      // take a few seconds). Gate "recording" on it so the mic shows "connecting"
      // until then, and don't send audio before the engine can consume it.
      let resolveReady: () => void = () => {};
      const readyPromise = new Promise<void>((r) => { resolveReady = r; });
      this.ws.onmessage = (e: MessageEvent) => {
        try {
          const m = JSON.parse(e.data as string) as { type: string; text?: string; message?: string };
          if (m.type === "ready") resolveReady();
          else if (m.type === "partial") this.cb.onPartial(m.text ?? "");
          else if (m.type === "final") this.cb.onFinal(m.text ?? "");
          else if (m.type === "error") this.cb.onError(m.message ?? "voice error");
        } catch {
          /* ignore non-JSON frames */
        }
      };
      this.ws.onclose = () => {
        if (this.recording) void this.stop();
      };

      // Only forward audio once recording is live (post-ready); pre-ready frames
      // are dropped rather than queued against an unloaded engine.
      this.node.port.onmessage = (e: MessageEvent) => {
        if (this.recording && this.ws && this.ws.readyState === WebSocket.OPEN) {
          const buf = e.data as ArrayBuffer;
          this.logLevel(buf);
          this.ws.send(buf);
        }
      };
      src.connect(this.node);
      // Keep the graph pulling without audible playback: route through a muted gain.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.node.connect(sink).connect(this.ctx.destination);

      // Wait for the engine (cap the wait so a wedged sidecar surfaces an error).
      await Promise.race([
        readyPromise,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error("voice engine timed out starting")), 30000)),
      ]);
      this.ws.send(JSON.stringify({ cmd: "start" }));
      this.recording = true;
      this.cb.onStateChange("recording");
    } catch (e) {
      this.cb.onError((e as Error).message || "voice failed to start");
      this.cb.onStateChange("error");
      await this.cleanup();
    }
  }

  async stop(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    try {
      this.ws?.send(JSON.stringify({ cmd: "stop" }));
    } catch {
      /* socket already gone */
    }
    // Give the sidecar a beat to emit the final flush before tearing down.
    await new Promise((r) => setTimeout(r, 300));
    await this.cleanup();
    this.cb.onStateChange("idle");
  }

  async destroy(): Promise<void> {
    this.recording = false;
    await this.cleanup();
  }

  // Diagnostic: ~once/sec, log the RMS level of the outgoing PCM. RMS near 0
  // means the mic is feeding silence (Whisper then hallucinates); a healthy
  // speaking level is roughly 0.02-0.2.
  private logLevel(buf: ArrayBuffer): void {
    const now = Date.now();
    if (now - this.lastLevelLog < 1000) return;
    this.lastLevelLog = now;
    const pcm = new Int16Array(buf);
    if (pcm.length === 0) return;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / pcm.length) / 32768;
    console.debug(`[voice] mic RMS=${rms.toFixed(4)} samples=${pcm.length}`);
  }

  private async cleanup(): Promise<void> {
    try { this.node?.disconnect(); } catch { /* */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { await this.ctx?.close(); } catch { /* */ }
    try { this.ws?.close(); } catch { /* */ }
    this.node = null;
    this.stream = null;
    this.ctx = null;
    this.ws = null;
  }
}
