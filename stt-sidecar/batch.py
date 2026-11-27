# Batch transcription of one finished recording (a phone voice note), as a
# one-shot process: decode, split at silences with the Silero VAD, transcribe
# chunk by chunk with the same model, hotwords and corrections as dictation, and
# stitch the text. The daemon runs it one recording at a time.
#
# It is deliberately NOT a mode of server.py: the dictation sidecar must stay
# responsive, and a separate process gives the batch its own priority, hands the
# GPU memory back on exit, and cannot wedge a live dictation.
#
# Gentle on the machine (a long run happens while Joe works):
#   - below-normal OS priority for the whole process;
#   - audio is decoded to 16-bit PCM (about 115 MB an hour) and only one VAD block
#     and one chunk are ever float32 at a time;
#   - a pause after every chunk proportional to the time it took, so the GPU
#     idles for `pause_ratio` of each second it works (default: half the time);
#   - one chunk at a time, one worker, CPU threads capped.
#
# Usage: python batch.py --app-data D --audio F --out OUT.json [--terms-file T.json]
# stdout: one JSON line per step ({"progress": 0..1}); the result lands in OUT.json.
import argparse, json, os, pathlib, sys, time

SAMPLE_RATE = 16000
# Whisper's window is 30 s; staying under it keeps a chunk in one pass.
MAX_CHUNK_S = 28.0
# Speech segments closer than this belong in one chunk.
JOIN_GAP_S = 0.8
# A silence at least this long between two chunks starts a new paragraph.
PARAGRAPH_GAP_S = 2.0
# VAD runs on blocks this long so only a block of the recording is float32.
VAD_BLOCK_S = 600.0
# Audio kept either side of a speech segment so a word is not clipped.
PAD_S = 0.2


def lower_priority():
    """Below-normal on Windows, nice 10 elsewhere. Failure is not an error: a
    slower start is no reason to lose the transcript."""
    try:
        if sys.platform == "win32":
            import ctypes
            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            ctypes.windll.kernel32.SetPriorityClass(
                ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(10)
    except Exception:
        pass


def plan_chunks(speech, total_samples, max_chunk_s=MAX_CHUNK_S, join_gap_s=JOIN_GAP_S, pad_s=PAD_S):
    """Group VAD speech segments [(start, end) in samples] into chunks of at most
    `max_chunk_s`, cut only in silence. A single segment longer than the cap is
    split at the cap (a monologue with no pause that long has no better cut).
    Returns [(start, end)] in samples, ordered, never overlapping, inside the audio."""
    cap = int(max_chunk_s * SAMPLE_RATE)
    gap = int(join_gap_s * SAMPLE_RATE)
    pad = int(pad_s * SAMPLE_RATE)
    pieces = []
    for start, end in sorted(speech):
        if end <= start:
            continue
        while end - start > cap:
            pieces.append((start, start + cap))
            start += cap
        pieces.append((start, end))
    chunks = []
    for start, end in pieces:
        if chunks and start - chunks[-1][1] <= gap and end - chunks[-1][0] <= cap:
            chunks[-1] = (chunks[-1][0], end)
        else:
            chunks.append((start, end))
    padded = []
    for i, (start, end) in enumerate(chunks):
        lo = max(0, start - pad)
        hi = min(total_samples, end + pad)
        # Padding must not reach into the neighbour, or its audio is heard twice.
        if padded and lo < padded[-1][1]:
            lo = padded[-1][1]
        if i + 1 < len(chunks):
            hi = min(hi, chunks[i + 1][0])
        if hi > lo:
            padded.append((lo, hi))
    return padded


def stitch(parts):
    """parts: [(start, end, text)] in samples, ordered. Joins the texts with a
    space, or a blank line where the silence between two chunks is long. A chunk
    that repeats the previous one word for word is dropped: Whisper loops on
    noise, and a loop is never what was said twice in a row."""
    out = []
    previous_end = None
    previous_text = None
    for start, end, text in parts:
        text = " ".join((text or "").split())
        if not text or text == previous_text:
            # The dropped chunk still took its time: the next gap is measured from it.
            if text and previous_end is not None:
                previous_end = end
            continue
        if out:
            silence = (start - previous_end) / SAMPLE_RATE
            out.append("\n\n" if silence >= PARAGRAPH_GAP_S else " ")
        out.append(text)
        previous_end, previous_text = end, text
    return "".join(out)


def pause_after(work_seconds, pause_ratio):
    """How long to idle after a chunk that took `work_seconds`."""
    return max(0.0, work_seconds) * max(0.0, pause_ratio)


def decode_to_pcm16(path):
    """The whole recording as one int16 mono 16 kHz array, decoded in a stream so
    no float32 copy of an hour of audio exists. PyAV ships with faster-whisper."""
    import av
    import numpy as np
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    blocks = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("no audio stream in the file")
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                blocks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            blocks.append(out.to_ndarray().reshape(-1))
    if not blocks:
        return np.zeros(0, dtype=np.int16)
    return np.concatenate(blocks).astype(np.int16, copy=False)


def speech_segments(pcm16):
    """VAD over the recording in blocks; segments in samples of the whole file."""
    import numpy as np
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    options = VadOptions(min_silence_duration_ms=500, speech_pad_ms=100)
    block = int(VAD_BLOCK_S * SAMPLE_RATE)
    found = []
    for offset in range(0, len(pcm16), block):
        audio = pcm16[offset:offset + block].astype(np.float32) / 32768.0
        for seg in get_speech_timestamps(audio, options):
            found.append((offset + int(seg["start"]), offset + int(seg["end"])))
    return found


def load_model(device):
    """The dictation engine's model (engine.build_asr: large-v3-turbo, fp16 on
    CUDA) when the GPU works, else the same model on the CPU in int8 with two
    threads. Returns (WhisperModel, device_name)."""
    if device in ("auto", "cuda"):
        try:
            from engine import build_asr
            return build_asr().model, "cuda"
        except Exception as e:
            if device == "cuda":
                raise
            print(json.dumps({"note": f"GPU unavailable, using the CPU: {e}"}), flush=True)
    from faster_whisper import WhisperModel
    return WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=2, num_workers=1), "cpu"


def transcribe(pcm16, model, hotwords, language, pause_ratio, corrections, report=None, sleep=time.sleep, detected=None):
    """Transcribes `pcm16`; returns (text, chunk_count). `model` needs
    .transcribe(float32_audio, **kwargs) -> (segments, info) as WhisperModel has.
    With language None Whisper picks per chunk, and each pick is appended to the
    `detected` list when one is given."""
    import numpy as np
    from vocab import apply_corrections
    speech = speech_segments(pcm16)
    chunks = plan_chunks(speech, len(pcm16))
    parts = []
    for i, (start, end) in enumerate(chunks):
        began = time.monotonic()
        audio = pcm16[start:end].astype(np.float32) / 32768.0
        kwargs = dict(
            language=language, beam_size=3, word_timestamps=False,
            # Each chunk stands alone: carrying text forward lets one hallucination
            # poison everything after it.
            condition_on_previous_text=False, vad_filter=False,
        )
        if hotwords:
            kwargs["hotwords"] = hotwords
        segments, info = model.transcribe(audio, **kwargs)
        text = " ".join(s.text.strip() for s in segments)
        if detected is not None and text.strip() and getattr(info, "language", None):
            detected.append(info.language)
        parts.append((start, end, text))
        if report:
            report((i + 1) / len(chunks))
        sleep(pause_after(time.monotonic() - began, pause_ratio))
    return apply_corrections(stitch(parts), corrections), len(chunks)


def read_terms(path):
    if not path:
        return []
    try:
        doc = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        return [t for t in doc if isinstance(t, str)] if isinstance(doc, list) else []
    except (OSError, ValueError):
        return []


def write_atomic(path, text):
    path = pathlib.Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-data", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--terms-file", default="")
    # Auto by default: the speaker may switch language between notes, and forcing
    # one would make Whisper translate the other into it.
    ap.add_argument("--language", default="auto")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--pause-ratio", type=float, default=1.0)
    a = ap.parse_args(argv)

    lower_priority()
    started = time.monotonic()
    pcm16 = decode_to_pcm16(a.audio)
    if len(pcm16) < SAMPLE_RATE // 2:
        write_atomic(a.out, json.dumps({"text": "", "chunks": 0, "duration_s": len(pcm16) / SAMPLE_RATE, "device": "none"}))
        return 0
    from vocab import load_vocab, load_corrections
    hotwords = load_vocab(pathlib.Path(a.app_data), extra_terms=read_terms(a.terms_file))
    model, device = load_model(a.device)
    language = None if a.language == "auto" else a.language
    detected = []
    text, chunks = transcribe(
        pcm16, model, hotwords, language, a.pause_ratio,
        load_corrections(pathlib.Path(a.app_data)),
        report=lambda p: print(json.dumps({"progress": round(p, 3)}), flush=True),
        detected=detected,
    )
    if language is None and detected:
        language = max(set(detected), key=detected.count)
    write_atomic(a.out, json.dumps({
        "text": text, "chunks": chunks, "duration_s": len(pcm16) / SAMPLE_RATE,
        "device": device, "language": language, "took_s": round(time.monotonic() - started, 1),
    }))
    return 0


# The daemon treats this exit code as "not installed" rather than a failure of the
# recording (see BATCH_MISSING_DEPENDENCY in daemon/voice_transcribe/sidecar.rs).
EXIT_MISSING_DEPENDENCY = 87


def run(argv=None):
    try:
        return main(argv)
    except ImportError as e:
        print(f"missing Python dependency: {e}", file=sys.stderr)
        return EXIT_MISSING_DEPENDENCY


if __name__ == "__main__":
    sys.exit(run())
