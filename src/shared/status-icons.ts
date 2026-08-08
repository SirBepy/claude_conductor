/**
 * Ph icon name for each `<cc-status:..>` marker value (question/working/
 * waiting/done). Used by the turn-footer status chip.
 */
export const STATUS_ICON: Record<"question" | "working" | "waiting" | "done", string> = {
  question: "ph-chat-circle-dots",
  working: "ph-spinner",
  waiting: "ph-hourglass-medium",
  done: "ph-check",
};

// close_failed (todo 461) isn't a turn-end `<cc-status:..>` marker - the daemon
// sets it on `awaiting` when a `/close` turn ends without the close_session
// tool confirming. Not added to STATUS_ICON (that table is turn-footer-chip
// only); markerToStatusClass is the one place both vocabularies share.
type StatusMarker = "question" | "working" | "waiting" | "done" | "close_failed";

/**
 * `st-*` sidebar-dot class for a marker value. "done" maps to the calm
 * st-your-turn check, never an "unread" accent - callers that distinguish
 * read/unread (statusDotClass) layer that on top themselves.
 */
export function markerToStatusClass(marker: StatusMarker): string;
export function markerToStatusClass(marker: string): string | null;
export function markerToStatusClass(marker: string): string | null {
  switch (marker) {
    case "question": return "st-question";
    case "working": return "st-working";
    case "waiting": return "st-waiting";
    case "done": return "st-your-turn";
    case "close_failed": return "st-close-failed";
    default: return null;
  }
}
