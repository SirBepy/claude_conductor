// Specs drive sends and card answers straight into mocked backends, so the
// production grace window (send-grace.ts) is off unless a spec turns it on.
globalThis.__ccSendGraceMs = 0;
