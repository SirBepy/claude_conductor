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
  /** `line` opens the File view scrolled to that 1-based line. */
  | { kind: "file"; path: string; line?: number }
  | { kind: "commit"; sha: string; title: string }
  | { kind: "pr"; title: string; commits: PrCommit[]; desc: HTMLTemplateElement | null };

let opener: ((target: CodeModeTarget) => void) | null = null;
let fileCheck: ((path: string) => boolean) | null = null;

export function setCodeModeOpener(fn: ((target: CodeModeTarget) => void) | null, canOpenFile: ((path: string) => boolean) | null = null): void {
  opener = fn;
  fileCheck = canOpenFile;
}

/** Whether Code mode can show `path` for the chat on screen: it reads only
 *  inside that chat's repo, so a path anywhere else has no view there. */
export function codeModeCanOpenFile(path: string): boolean {
  return !!opener && !!fileCheck?.(path);
}

export function openInCodeMode(target: CodeModeTarget): void {
  opener?.(target);
}
