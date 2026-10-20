import asyncio
import json
import sys, pathlib
import pytest
import websockets

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server


TOKEN = "dummy-test-token"


async def _expect_closed_without_service(connect_kwargs, first_frame):
    """The connection must end without ever yielding authed/ready, and a
    shutdown frame must not kill the test process (os._exit is patched out by
    the caller)."""
    asr_future = asyncio.get_running_loop().create_future()
    asr_future.set_result(None)
    async with websockets.serve(server.make_handler("/tmp", asr_future, TOKEN), "127.0.0.1", 0) as s:
        port = s.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}", **connect_kwargs) as ws:
            with pytest.raises(websockets.ConnectionClosed):
                # The server may close before this send lands (Origin check).
                if first_frame is not None:
                    await ws.send(first_frame)
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
                    assert msg["type"] not in ("authed", "ready")


@pytest.mark.asyncio
async def test_wrong_token_is_closed_without_service():
    await _expect_closed_without_service({}, json.dumps({"cmd": "auth", "token": "nope"}))


@pytest.mark.asyncio
async def test_unauthenticated_shutdown_does_not_exit(monkeypatch):
    exited = []
    monkeypatch.setattr(server.os, "_exit", lambda code: exited.append(code))
    await _expect_closed_without_service({}, json.dumps({"cmd": "shutdown"}))
    assert exited == []


@pytest.mark.asyncio
async def test_binary_first_frame_is_rejected():
    await _expect_closed_without_service({}, b"\x00\x00")


@pytest.mark.asyncio
async def test_browser_origin_is_rejected_even_with_the_right_token():
    await _expect_closed_without_service(
        {"origin": "https://evil.example"},
        json.dumps({"cmd": "auth", "token": TOKEN}),
    )


class FakeEngine:
    def __init__(self, *a, **k):
        self.reset_called = 0
        self.vocab_reloaded = 0

    def reset(self):
        self.reset_called += 1

    def reload_vocab(self):
        self.vocab_reloaded += 1

    def accept_pcm(self, pcm):
        return {"final": "hello ", "partial": "wor"}

    def finish(self):
        return "world"


@pytest.mark.asyncio
async def test_start_audio_stop_emits_ready_partial_final(monkeypatch):
    monkeypatch.setattr(server, "StreamingEngine", FakeEngine)
    # Resolved future standing in for the model load: FakeEngine ignores the asr,
    # and the real model is never loaded here.
    asr_future = asyncio.get_running_loop().create_future()
    asr_future.set_result(None)
    async with websockets.serve(server.make_handler("/tmp", asr_future, TOKEN), "127.0.0.1", 0) as s:
        port = s.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.send(json.dumps({"cmd": "auth", "token": TOKEN}))
            assert json.loads(await ws.recv())["type"] == "authed"
            assert json.loads(await ws.recv())["type"] == "ready"
            await ws.send(json.dumps({"cmd": "start"}))
            await ws.send(b"\x00\x00" * 4000)  # dummy PCM frame
            msgs = [json.loads(await ws.recv()) for _ in range(2)]
            kinds = {m["type"]: m.get("text") for m in msgs}
            assert kinds.get("final") == "hello "
            assert kinds.get("partial") == "wor"
            await ws.send(json.dumps({"cmd": "stop"}))
            assert json.loads(await ws.recv()) == {"type": "final", "text": "world"}


# todo 317 regression: shutdown/logoff/close must exit fast, not fall through
# to Windows' own ~5s per-console shutdown wait.
@pytest.mark.skipif(sys.platform != "win32", reason="console ctrl handler is Windows-only")
def test_console_event_shutdown_triggers_exit(monkeypatch):
    exited = []
    monkeypatch.setattr(server.os, "_exit", lambda code: exited.append(code))
    server._on_console_event(6)  # CTRL_SHUTDOWN_EVENT
    assert exited == [0]


@pytest.mark.skipif(sys.platform != "win32", reason="console ctrl handler is Windows-only")
def test_console_event_ignores_unrelated_events(monkeypatch):
    exited = []
    monkeypatch.setattr(server.os, "_exit", lambda code: exited.append(code))
    server._on_console_event(0)  # CTRL_C_EVENT: Python's own handler owns this
    assert exited == []
