# STT sidecar: localhost-only WebSocket server on 127.0.0.1:27184.
# Binary frames = raw 16 kHz mono Int16LE PCM. Text frames = JSON control
# {"cmd": "start"|"stop"|"reload_vocab"|"shutdown"}. Emits JSON results.
import argparse, asyncio, concurrent.futures, json, os, pathlib, sys
import websockets
from engine import StreamingEngine, build_asr

# todo 317: CTRL_CLOSE/LOGOFF/SHUTDOWN have no Python signal mapping (only
# CTRL_C/BREAK do), so unhandled, Windows waits out its ~5s per-console
# shutdown timeout on this process before force-killing it (winsrvext id 100).
if sys.platform == "win32":
    import ctypes

    _CTRL_SHUTDOWN_EVENTS = {2, 5, 6}  # CTRL_CLOSE, CTRL_LOGOFF, CTRL_SHUTDOWN

    def _on_console_event(event):
        if event in _CTRL_SHUTDOWN_EVENTS:
            os._exit(0)
        return False

    _console_handler_ref = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)(_on_console_event)
    ctypes.windll.kernel32.SetConsoleCtrlHandler(_console_handler_ref, True)


def make_handler(app_data, asr_future):
    async def handle(ws):
        # Wait on the process-wide model load (kicked off in _main). Awaiting the
        # shared future here - rather than loading per connection - means the
        # model is loaded exactly once and every later connect resolves instantly.
        # Gating "ready" on it also lets the port bind immediately while a slow
        # first-ever download is absorbed by the browser's ready-wait.
        asr = await asr_future
        eng = StreamingEngine(app_data=pathlib.Path(app_data), asr=asr)
        # Single-worker executor: Whisper inference is blocking; running it in a
        # thread keeps the asyncio loop free to receive new audio frames instead
        # of letting them pile up in the OS buffer (the root cause of 10-15 s lag).
        # max_workers=1 serialises calls so eng.online is never touched concurrently.
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        loop = asyncio.get_running_loop()
        await ws.send(json.dumps({"type": "ready"}))
        async for msg in ws:
            try:
                if isinstance(msg, (bytes, bytearray)):
                    out = await loop.run_in_executor(executor, eng.accept_pcm, bytes(msg))
                    if out["final"]:
                        await ws.send(json.dumps({"type": "final", "text": out["final"]}))
                    if out["partial"]:
                        await ws.send(json.dumps({"type": "partial", "text": out["partial"]}))
                    continue
                cmd = json.loads(msg).get("cmd")
                if cmd == "start":
                    eng.reset()
                elif cmd == "stop":
                    tail = await loop.run_in_executor(executor, eng.finish)
                    await ws.send(json.dumps({"type": "final", "text": tail}))
                elif cmd == "reload_vocab":
                    eng.reload_vocab()
                elif cmd == "shutdown":
                    # Terminate the whole process, not just this connection -
                    # the daemon's kill() for an ADOPTED sidecar has no PID to
                    # signal, only this control channel.
                    await ws.close()
                    os._exit(0)
            except Exception as e:  # never let one bad frame kill the loop
                await ws.send(json.dumps({"type": "error", "message": str(e)}))
        executor.shutdown(wait=False)
    return handle


async def _main(app_data, port):
    # Kick off the model load in the background so the port binds immediately
    # (the daemon relay only retries its connect for ~10 s). The first connect -
    # normally the chat-open warm-up - awaits this and pays the load; every later
    # connect reuses the resolved asr and gets "ready" almost instantly.
    asr_future = asyncio.ensure_future(
        asyncio.get_running_loop().run_in_executor(None, build_asr)
    )
    # max_size=None: binary audio frames must not hit the default 1 MiB cap.
    async with websockets.serve(make_handler(app_data, asr_future), "127.0.0.1", port, max_size=None):
        print(f"stt-sidecar listening on 127.0.0.1:{port}", flush=True)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-data", required=True)
    ap.add_argument("--port", type=int, default=27184)
    a = ap.parse_args()
    try:
        asyncio.run(_main(a.app_data, a.port))
    except KeyboardInterrupt:
        sys.exit(0)
