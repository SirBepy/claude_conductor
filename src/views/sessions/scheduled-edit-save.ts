// Send in the composer's scheduled-message edit mode: re-saves the pending
// item's prompt, or throws so the composer keeps the draft and the edit bar.

import { invoke } from "../../shared/ipc";
import { blocksToText } from "../../shared/chat/content-blocks";
import { formatFireAt } from "../../shared/chat/schedule-picker";
import { showToast } from "../../shared/toast";
import type { ContentBlock, ScheduledItem } from "../../types/ipc.generated";

export async function saveScheduledEdit(item: ScheduledItem, blocks: ContentBlock[]): Promise<void> {
  const prompt = blocksToText(blocks);
  // A schedule stores a flat prompt string, so an attachment-only draft would
  // write "" onto a still-pending item and it would later fire an empty message.
  if (!prompt.trim()) {
    showToast("A scheduled message needs text. Attachments are not kept on a schedule.");
    throw new Error("scheduled edit has no text");
  }
  // Re-read the item: it may have fired or been deleted since the edit began,
  // and an update would resurrect it.
  const all = await invoke<ScheduledItem[]>("schedule_list");
  const current = all.find((i) => i.id === item.id);
  if (!current || current.status.type !== "pending") {
    showToast("That message was already sent or removed. Your text is still here.");
    throw new Error("scheduled item no longer pending");
  }
  try {
    await invoke<void>("schedule_update", { item: { ...current, prompt } });
  } catch (err) {
    console.error("[sessions] schedule_update failed", err);
    showToast(`Failed to save: ${err}`);
    throw err;
  }
  showToast(`Still scheduled for ${formatFireAt(current.fire_at)}`);
}
