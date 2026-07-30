// Which sidebar row layout to render. Deliberately its own module rather than
// another flag in sessions-helpers: the classic branch is scheduled for removal
// once Joe has lived on Portrait for a month (see the 2026-08-30 todo), and
// keeping the flag, the type and the default in one file makes that deletion a
// single grep instead of an archaeology exercise.

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
