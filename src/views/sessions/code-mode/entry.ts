// Every way into Code mode goes through here: the header `</>` button,
// Ctrl+Shift+E, the git chip, a commit sha, a file chip, a PR card. It picks
// in-place vs its own window by the last choice made (desktop only).

import { isRemote } from "../../../shared/transport";
import { invoke } from "../../../shared/ipc";
import { updateSettings } from "../../../shared/settings-update";
import {
  closeCodeMode,
  currentCodeModeKey,
  isCodeModeOpen,
  openCodeMode,
  snapshotView,
  type CodeModeChat,
  type CodeModeTarget,
} from "./code-mode";
import { forwardToCodeWindow, isPoppedOut, markPoppedOut, isCodeWindow, dockFromCodeWindow } from "./popout";
import type { SettingsShape } from "../../../shared/state";
import { setCodeModeOpener } from "../../../shared/chat/code-mode-bridge";
import * as shortcuts from "../../../shared/shortcuts";
import { openQuickOpen } from "./quick-open";

let provider: (() => CodeModeChat | null) | null = null;

/** Registered by whichever view currently shows a chat: the sessions view's
 *  active chat, the history view's open transcript. */
export function setCodeModeChatProvider(fn: (() => CodeModeChat | null) | null): void {
  provider = fn;
}

export function currentCodeModeChat(): CodeModeChat | null {
  return provider?.() ?? null;
}

const PREF_KEY = "codeModePoppedOut";
let preferPopOut: boolean | null = null;

async function prefersPopOut(): Promise<boolean> {
  if (preferPopOut === null) {
    const s = await invoke<SettingsShape & Record<string, unknown>>("get_settings").catch(() => null);
    preferPopOut = s?.[PREF_KEY] === true;
  }
  return preferPopOut;
}

/** Joe's default: Code mode opens wherever it was last (in the chat window,
 *  or popped out), across restarts. */
export function rememberPopOut(popped: boolean): void {
  if (preferPopOut === popped) return;
  preferPopOut = popped;
  void updateSettings((s) => { (s as Record<string, unknown>)[PREF_KEY] = popped; }).catch((err) =>
    console.error("[code-mode] saving the pop-out choice failed", err),
  );
}

function canPopOut(chat: CodeModeChat): boolean {
  return !isRemote() && !isCodeWindow() && !!chat.sessionId;
}

export function popOut(chat: CodeModeChat, target: CodeModeTarget = { kind: "default" }): void {
  const snap = snapshotView(chat.key);
  if (isCodeModeOpen()) closeCodeMode();
  markPoppedOut(chat, snap, target);
  rememberPopOut(true);
}

function hooksFor(chat: CodeModeChat) {
  return canPopOut(chat) ? { popOut: () => popOut(chat) } : {};
}

export async function enterCodeMode(target: CodeModeTarget = { kind: "default" }): Promise<void> {
  const chat = provider?.();
  if (!chat) return;
  if (canPopOut(chat)) {
    if (isPoppedOut(chat.sessionId!)) { forwardToCodeWindow(chat, target); return; }
    if (!isCodeModeOpen() && (await prefersPopOut())) { popOut(chat, target); return; }
  }
  openCodeMode(chat, target, hooksFor(chat));
}

/** Ctrl+Shift+E: enter, or leave if already in it for this chat. */
export function toggleCodeMode(): void {
  const chat = provider?.();
  if (isCodeModeOpen() && (!chat || currentCodeModeKey() === chat.key) && !isCodeWindow()) {
    closeCodeMode();
    return;
  }
  void enterCodeMode();
}

/** Ctrl+Shift+O: pop Code mode out of the chat window, or dock it back. */
export function togglePopOut(): void {
  if (isCodeWindow()) { dockFromCodeWindow(); return; }
  const chat = provider?.();
  if (chat && isCodeModeOpen() && canPopOut(chat)) popOut(chat);
}

/** Ctrl+P: pick a file from the open chat's project, then show it in Code
 *  mode, entering Code mode first if it isn't open. */
export function quickOpenFile(): void {
  const chat = provider?.();
  if (!chat?.cwd) return;
  openQuickOpen(chat.cwd, (path) => void enterCodeMode({ kind: "file", path }));
}

setCodeModeOpener((target) => void enterCodeMode(target));
shortcuts.register("code-mode", toggleCodeMode);
shortcuts.register("code-mode-popout", togglePopOut);
shortcuts.register("quick-open", quickOpenFile);
