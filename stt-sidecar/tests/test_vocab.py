import json
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from vocab import load_vocab, load_corrections, apply_corrections


def test_load_vocab_joins_terms(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    (d / "voice-vocab.json").write_text(json.dumps({"terms": ["Tauri", "Riverpod"]}))
    assert load_vocab(tmp_path) == "Tauri Riverpod"


def test_load_vocab_puts_user_terms_before_seeded_and_dedupes(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    (d / "voice-vocab.json").write_text(
        json.dumps({"terms": ["zirtue"], "seeded": ["zng-app", "zirtue", "Conductor"]})
    )
    assert load_vocab(tmp_path) == "zirtue zng-app Conductor"


def test_load_vocab_stops_at_the_character_budget_keeping_user_terms(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    seeded = [f"project{i:03d}" for i in range(100)]
    (d / "voice-vocab.json").write_text(json.dumps({"terms": ["zirtue"], "seeded": seeded}))
    out = load_vocab(tmp_path)
    assert out.startswith("zirtue project000")
    assert len(out) <= 300
    assert "project099" not in out


def test_load_vocab_ignores_non_string_and_malformed_entries(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    (d / "voice-vocab.json").write_text(json.dumps({"terms": ["a1", 5, None], "seeded": "oops"}))
    # "seeded" is not a list: spreading a string would yield single characters.
    assert load_vocab(tmp_path) == "a1"


def test_load_vocab_missing_returns_empty(tmp_path):
    assert load_vocab(tmp_path) == ""


def test_load_corrections_missing_returns_empty(tmp_path):
    assert load_corrections(tmp_path) == []


def test_apply_corrections_word_boundary_case_insensitive():
    pairs = [("tori", "Tauri")]
    assert apply_corrections("i love tori and Tori", pairs) == "i love Tauri and Tauri"
    # substring inside another word is NOT replaced
    assert apply_corrections("category", pairs) == "category"


def test_apply_corrections_does_not_chain_pairs():
    # A->B then B->C must not turn "a" into "c".
    pairs = [("a", "b"), ("b", "c")]
    assert apply_corrections("a b", pairs) == "b c"


def test_apply_corrections_longest_heard_wins():
    pairs = [("new york", "NYC"), ("york", "Y")]
    assert apply_corrections("in new york and york", pairs) == "in NYC and Y"


def test_apply_corrections_backslash_in_replacement_is_literal():
    pairs = [("path", r"C:\new\1")]
    assert apply_corrections("the path here", pairs) == r"the C:\new\1 here"


def test_apply_corrections_term_with_non_word_edge():
    pairs = [(".net", "dotnet")]
    assert apply_corrections("we use .net daily", pairs) == "we use dotnet daily"
    assert apply_corrections("sunset", pairs) == "sunset"


def test_apply_corrections_empty_inputs():
    assert apply_corrections("", [("a", "b")]) == ""
    assert apply_corrections("hello", []) == "hello"
