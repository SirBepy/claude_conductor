// The one way the app opens a file for reading or editing, in place of VS
// Code: Code mode when the file sits in the open chat's repo, otherwise the
// Files window (`session-file`, any path on disk). VS Code stays reachable
// from the right-click menus that offer it.

import { invoke } from "./ipc";
import { codeModeCanOpenFile, openInCodeMode } from "./chat/code-mode-bridge";

// Same normalisation file-refs.ts applies before handing a path to the OS.
const winPath = (p: string) => (/^[a-z]:\//i.test(p) ? p.replace(/\//g, "\\") : p);

export function openFileInApp(path: string, line?: number): void {
  if (codeModeCanOpenFile(path)) {
    openInCodeMode({ kind: "file", path, line });
    return;
  }
  openFileWindow(path, line);
}

/** Straight to the Files window, skipping Code mode: for callers with no chat
 *  of their own, where the chat on screen is beside the point. */
export function openFileWindow(path: string, line?: number): void {
  void invoke<void>("open_file_window", { path: winPath(path), line: line ?? null }).catch((err) =>
    console.error("[open-file] open_file_window failed", err),
  );
}
