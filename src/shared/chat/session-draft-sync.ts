// Thin typed wrappers around the 9 cross-surface draft-sync daemon RPCs
// (daemon/methods/drafts.rs). Hand-declared response shapes: these are raw
// daemon JSON-RPC methods, not in ipc.generated.ts's ts-rs export.

// KNOWN GAP (desktop): no `#[tauri::command]` of these names exists in
// lib.rs's generate_handler! yet, so desktop's invoke() 404s here today.
// Every caller already degrades to localStorage-only on a rejected promise.

import { invoke } from "../ipc";
import type { ContentBlock } from "../../types/ipc.generated";

export interface ComposerDraftDto { text: string; updated_at: string }
export interface AuqDraftDto { prompt_id: string; payload: unknown; updated_at: string }
export interface HeldDraftItemDto { id: number; blocks: ContentBlock[]; updated_at: string }
export interface SessionDraftsDto {
  composer: ComposerDraftDto | null;
  auq: AuqDraftDto | null;
  held: HeldDraftItemDto[];
  held_updated_at: string | null;
}

export function getSessionDrafts(sessionId: string): Promise<SessionDraftsDto> {
  return invoke<SessionDraftsDto>("get_session_drafts", { sessionId });
}

export function setComposerDraft(sessionId: string, text: string): Promise<{ updated_at: string }> {
  return invoke("set_composer_draft", { sessionId, text });
}

export function clearComposerDraft(sessionId: string): Promise<{ updated_at: string }> {
  return invoke("clear_composer_draft", { sessionId });
}

export function setAuqDraft(sessionId: string, promptId: string, payload: unknown): Promise<{ updated_at: string }> {
  return invoke("set_auq_draft", { sessionId, promptId, payload });
}

export function clearAuqDraft(sessionId: string, promptId: string): Promise<{ cleared: boolean }> {
  return invoke("clear_auq_draft", { sessionId, promptId });
}

export function addHeldMessage(sessionId: string, blocks: ContentBlock[]): Promise<{ id: number; updated_at: string }> {
  return invoke("add_held_message", { sessionId, blocks });
}

export function updateHeldMessage(sessionId: string, id: number, blocks: ContentBlock[]): Promise<{ updated_at: string }> {
  return invoke("update_held_message", { sessionId, id, blocks });
}

export function removeHeldMessage(sessionId: string, id: number): Promise<{ updated_at: string }> {
  return invoke("remove_held_message", { sessionId, id });
}

export function clearHeldMessages(sessionId: string): Promise<{ updated_at: string }> {
  return invoke("clear_held_messages", { sessionId });
}
