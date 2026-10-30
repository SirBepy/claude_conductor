// Jarvis entry points (the sidemenu item, the Chats rail icon) share this. The
// open-jarvis import stays dynamic so neither caller pulls the sessions view in
// statically. A failed open is logged, never thrown: the click handlers have
// nowhere to surface it (open-jarvis itself toasts the phone's failure).

export function openJarvisSafely(): Promise<void> {
  return import("../views/sessions/open-jarvis")
    .then((m) => m.openJarvis())
    .catch((err) => console.error("[jarvis] open failed", err));
}
