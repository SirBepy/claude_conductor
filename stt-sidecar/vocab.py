# Vocab + corrections loading for the STT sidecar. Pure, no heavy deps.
import json, pathlib, re


def _voice_dir(app_data: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(app_data) / "voice"


# faster-whisper truncates the hotword prompt at max_length // 2 - 1 tokens and a
# long prompt raises echo and hallucination risk. Rare words cost 3-6 tokens
# each, so the list is capped by characters (about 100 tokens) instead of terms.
HOTWORD_CHAR_BUDGET = 300


def load_vocab(app_data: pathlib.Path, extra_terms=()) -> str:
    """Return a single space-joined hotword string from <app_data>/voice/voice-vocab.json.

    `terms` (the user's own) come first and are never displaced by `seeded`
    (project names the daemon writes); the list stops at HOTWORD_CHAR_BUDGET.
    `extra_terms` (the vault Glossary, for a batch transcription) sit between the
    two: the glossary is the user's own vocabulary too, but never displaces a term
    typed into the dictionary. Empty string when there is nothing at all."""
    f = _voice_dir(app_data) / "voice-vocab.json"
    candidates = []
    try:
        if f.exists():
            doc = json.loads(f.read_text(encoding="utf-8"))
            for key in ("terms", "extra", "seeded"):
                if key == "extra":
                    candidates.extend(extra_terms)
                    continue
                value = doc.get(key, [])
                if isinstance(value, list):
                    candidates.extend(value)
        else:
            candidates.extend(extra_terms)
    except (json.JSONDecodeError, OSError, AttributeError, TypeError):
        return ""
    out, used = [], 0
    for t in candidates:
        if not isinstance(t, str):
            continue
        t = t.strip()
        # Case-insensitive: a hand-typed "goobers" is not doubled by the glossary's "Goobers".
        if not t or any(t.lower() == o.lower() for o in out):
            continue
        cost = len(t) + (1 if out else 0)
        if used + cost > HOTWORD_CHAR_BUDGET:
            break
        out.append(t)
        used += cost
    return " ".join(out)


def load_corrections(app_data: pathlib.Path):
    """Return [(heard, corrected)] from voice-corrections.json (written by Plan 3).
    Empty list when the file is absent or malformed."""
    f = _voice_dir(app_data) / "voice-corrections.json"
    if not f.exists():
        return []
    try:
        pairs = json.loads(f.read_text(encoding="utf-8")).get("pairs", [])
    except (json.JSONDecodeError, OSError):
        return []
    return [
        (p["heard"], p["corrected"])
        for p in pairs
        if isinstance(p, dict) and p.get("heard") and p.get("corrected")
    ]


def apply_corrections(text: str, pairs) -> str:
    """Case-insensitive, whole-word replacement of each `heard` with `corrected`.

    One alternation pass, longest `heard` first: sequential passes would chain
    (A->B then B->C), and a `corrected` string is passed through a callable so a
    backslash in it is literal, never a re.sub template escape. Lookarounds
    instead of \\b so a term starting or ending in a non-word char (".net") still
    matches on its own edges."""
    table = {}
    for heard, corrected in pairs:
        table.setdefault(heard.lower(), corrected)
    if not table or not text:
        return text
    heards = sorted(table, key=len, reverse=True)
    pattern = re.compile(
        r"(?<!\w)(?:" + "|".join(re.escape(h) for h in heards) + r")(?!\w)",
        re.IGNORECASE,
    )
    # .get: IGNORECASE also matches characters whose lower() is not the table key.
    return pattern.sub(lambda m: table.get(m.group(0).lower(), m.group(0)), text)
