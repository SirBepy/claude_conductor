import json
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import batch
from batch import SAMPLE_RATE as SR, plan_chunks, stitch, pause_after
from vocab import load_vocab


def s(x):
    return int(x * SR)


def test_chunks_cut_only_in_silence_and_stay_under_the_cap():
    # Three 10 s utterances 1.5 s apart: two fit in 28 s, the third starts a chunk.
    speech = [(s(0), s(10)), (s(11.5), s(21.5)), (s(23), s(33))]
    chunks = plan_chunks(speech, s(40), join_gap_s=2.0, pad_s=0)
    assert chunks == [(s(0), s(21.5)), (s(23), s(33))]
    assert all(e - b <= s(batch.MAX_CHUNK_S) for b, e in chunks)


def test_a_segment_longer_than_the_cap_is_split_at_the_cap():
    chunks = plan_chunks([(s(0), s(70))], s(70), pad_s=0)
    assert [e - b for b, e in chunks] == [s(28), s(28), s(14)]
    assert chunks[0][1] == chunks[1][0]


def test_padding_never_overlaps_a_neighbour_or_leaves_the_audio():
    chunks = plan_chunks([(s(0.1), s(5)), (s(5.3), s(60))], s(60.05), join_gap_s=0.1, pad_s=0.5)
    for (a, b), (c, d) in zip(chunks, chunks[1:]):
        assert b <= c
    assert chunks[0][0] == 0 and chunks[-1][1] == s(60.05)


def test_no_speech_means_no_chunks():
    assert plan_chunks([], s(60)) == []
    assert plan_chunks([(100, 100)], s(60)) == []


def test_stitch_joins_with_spaces_and_a_paragraph_after_a_long_silence():
    parts = [(0, s(10), "first part"), (s(10.5), s(20), " second   part "), (s(25), s(30), "third part")]
    assert stitch(parts) == "first part second part\n\nthird part"


def test_stitch_drops_empty_and_repeated_chunks():
    parts = [(0, s(5), "hello"), (s(5), s(10), ""), (s(10), s(15), "hello"), (s(15), s(20), "again")]
    assert stitch(parts) == "hello again"


def test_pause_is_proportional_to_the_work_and_never_negative():
    assert pause_after(2.0, 1.0) == 2.0
    assert pause_after(2.0, 0.5) == 1.0
    assert pause_after(-1.0, 1.0) == 0.0
    assert pause_after(2.0, 0.0) == 0.0


def test_transcribe_pauses_after_every_chunk_and_applies_corrections(monkeypatch):
    import numpy as np
    monkeypatch.setattr(batch, "speech_segments", lambda pcm: [(s(0), s(5)), (s(20), s(25))])

    class Seg:
        def __init__(self, text):
            self.text = text

    class Model:
        def __init__(self):
            self.calls = []

        def transcribe(self, audio, **kw):
            self.calls.append((len(audio), kw))
            return [Seg(f" tori rocks {len(self.calls)} ")], None

    slept, progress = [], []
    model = Model()
    pcm = np.zeros(s(30), dtype=np.int16)
    text, n = batch.transcribe(
        pcm, model, "Tauri", "en", 1.0, [("tori", "Tauri")],
        report=progress.append, sleep=slept.append,
    )
    assert n == 2 and len(slept) == 2 and all(x >= 0 for x in slept)
    assert text == "Tauri rocks 1\n\nTauri rocks 2"
    assert progress == [0.5, 1.0]
    # Hotwords reach the model, and a chunk never conditions on the previous one.
    assert model.calls[0][1]["hotwords"] == "Tauri"
    assert model.calls[0][1]["condition_on_previous_text"] is False
    assert model.calls[0][1]["vad_filter"] is False


def test_a_missing_python_dependency_exits_with_its_own_code(monkeypatch):
    def boom(argv=None):
        raise ImportError("No module named 'av'")

    monkeypatch.setattr(batch, "main", boom)
    # Not 3 (the Windows C runtime's abort code), 2 (argparse) or 1 (an exception).
    assert batch.run([]) == batch.EXIT_MISSING_DEPENDENCY == 87


def test_with_no_language_given_each_chunks_detected_language_is_reported(monkeypatch):
    import numpy as np
    monkeypatch.setattr(batch, "speech_segments", lambda pcm: [(s(0), s(5)), (s(20), s(25))])

    class Seg:
        text = "x"

    class Info:
        language = "hr"

    class Model:
        def transcribe(self, audio, **kw):
            assert kw["language"] is None
            return [Seg()], Info()

    detected = []
    batch.transcribe(np.zeros(s(30), dtype=np.int16), Model(), "", None, 0.0, [],
                     sleep=lambda _: None, detected=detected)
    assert detected == ["hr", "hr"]


def test_glossary_terms_sit_between_the_users_terms_and_the_seeded_ones(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    (d / "voice-vocab.json").write_text(json.dumps({"terms": ["zirtue"], "seeded": ["zng-app"]}))
    assert load_vocab(tmp_path, extra_terms=["Goobers", "zirtue"]) == "zirtue Goobers zng-app"


def test_glossary_terms_work_without_a_vocab_file(tmp_path):
    assert load_vocab(tmp_path, extra_terms=["Goobers"]) == "Goobers"
    assert load_vocab(tmp_path) == ""


def test_glossary_terms_cannot_displace_the_users_terms_at_the_budget(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    (d / "voice-vocab.json").write_text(json.dumps({"terms": ["mine"]}))
    out = load_vocab(tmp_path, extra_terms=[f"glossary{i:03d}" for i in range(100)])
    assert out.startswith("mine glossary000") and len(out) <= 300


def test_main_writes_an_empty_result_for_a_clip_with_no_audio(tmp_path, monkeypatch):
    import numpy as np
    monkeypatch.setattr(batch, "lower_priority", lambda: None)
    monkeypatch.setattr(batch, "decode_to_pcm16", lambda p: np.zeros(10, dtype=np.int16))
    out = tmp_path / "out.json"
    assert batch.main(["--app-data", str(tmp_path), "--audio", "x.opus", "--out", str(out)]) == 0
    assert json.loads(out.read_text())["text"] == ""
