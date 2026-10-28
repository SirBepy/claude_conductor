// The statusbar's todos chip (phone only) asks the sessions view to open the
// Backlog panel. Announced on `window` like the draft and ask events, because
// the statusbar must not import the view that owns the panel host.

export const BACKLOG_OPEN_EVENT = "cc-backlog-open";
