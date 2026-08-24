// Splits the sidecar's optional trailing `SUGGESTED: <instruction>` line off an
// answer. Parsed here rather than daemon-side so the wire types stay two plain
// structs; see src-tauri/src/ask/sidecar.rs for the half that asks for it.

export interface SplitAnswer {
  body: string;
  suggestion: string | null;
}

const MARKER = "SUGGESTED:";

export function splitSuggestion(answer: string): SplitAnswer {
  const lines = answer.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] ?? "";
    if (!raw.trim()) continue;
    // Only the LAST non-blank line counts: the model was told to put it there,
    // and a mid-answer mention is prose about the word, not a real suggestion.
    const stripped = raw.replace(/^[>\-*\s]+/, "");
    if (!stripped.startsWith(MARKER)) break;
    const suggestion = stripped.slice(MARKER.length).trim();
    if (!suggestion) break;
    return { body: lines.slice(0, i).join("\n").trimEnd(), suggestion };
  }
  return { body: answer.trimEnd(), suggestion: null };
}
