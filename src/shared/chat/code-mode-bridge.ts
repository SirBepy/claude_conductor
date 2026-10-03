// The seam chat surfaces (commit shas, file chips, PR cards) open Code mode
// through, so shared chat code never imports the sessions view. Code mode's
// entry module registers the opener.

export type CodeModeScope = "chat" | "unpushed" | "uncommitted" | "all";

export interface PrCommit {
  sha: string;
  msg: string;
}

export type CodeModeTarget =
  | { kind: "default" }
  | { kind: "scope"; scope: CodeModeScope; commitsOpen?: boolean }
  | { kind: "file"; path: string }
  | { kind: "commit"; sha: string; title: string }
  | { kind: "pr"; title: string; commits: PrCommit[]; desc: HTMLTemplateElement | null };

let opener: ((target: CodeModeTarget) => void) | null = null;

export function setCodeModeOpener(fn: ((target: CodeModeTarget) => void) | null): void {
  opener = fn;
}

export function openInCodeMode(target: CodeModeTarget): void {
  opener?.(target);
}
