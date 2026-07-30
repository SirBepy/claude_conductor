// Own module, not another flag in sessions-helpers: the classic branch is
// slated for deletion once Portrait has stuck (see the 2026-08-30 todo).

export const LS_ROW_STYLE = "cc_chat_row_style";

/** `classic` = title-led row as shipped before 2026-07-30. `portrait` = square
 *  character portrait, project name, battery + scheduled marker, no title. */
export type ChatRowStyle = "classic" | "portrait";

export function loadRowStyle(): ChatRowStyle {
  try {
    if (localStorage.getItem(LS_ROW_STYLE) === "classic") return "classic";
  } catch { /* ignore */ }
  return "portrait";
}
