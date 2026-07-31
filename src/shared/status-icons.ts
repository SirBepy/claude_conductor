/**
 * Ph icon name for each `<cc-status:..>` marker value (question/working/
 * waiting/done). Single source for the sidebar's statusIndicator and the
 * turn-footer status chip so an icon change lands in one place.
 */
export const STATUS_ICON: Record<"question" | "working" | "waiting" | "done", string> = {
  question: "ph-chat-circle-dots",
  working: "ph-spinner",
  waiting: "ph-hourglass-medium",
  done: "ph-check",
};
