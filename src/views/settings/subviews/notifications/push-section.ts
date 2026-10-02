import { isRemote } from "../../../../shared/transport";
import { pushSupported, pushEnabledLocally, enablePush, disablePush } from "../../../../shared/push";

// Phone-only Web Push enrolment (ai_todo 119). The desktop drives OS notifs via
// the notif cards; the phone instead subscribes to daemon-sent pushes for "Claude
// is blocked on you" while the PC is idle. Hidden entirely on desktop and on
// browsers without Push support.
export function wirePushSection(root: HTMLElement): void {
  const section = root.querySelector<HTMLElement>("#push-section");
  if (!section) return;
  if (!isRemote() || !pushSupported()) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  const toggle = root.querySelector<HTMLInputElement>("#push-enabled");
  const statusEl = root.querySelector<HTMLElement>("#push-status");
  if (!toggle) return;
  toggle.checked = pushEnabledLocally();

  const setStatus = (msg: string) => { if (statusEl) statusEl.textContent = msg; };

  toggle.onchange = () => {
    void (async () => {
      toggle.disabled = true;
      if (toggle.checked) {
        const res = await enablePush();
        if (res.ok) {
          setStatus("On - your phone will buzz when Claude needs you and the PC is idle.");
        } else {
          toggle.checked = false;
          setStatus(
            res.reason === "denied"
              ? "Notification permission was blocked. Allow it in your browser settings, then try again."
              : res.reason === "unsupported"
                ? "This browser can't do push notifications."
                : "Couldn't enable push. Check the connection and try again.",
          );
        }
      } else {
        await disablePush();
        setStatus("Off.");
      }
      toggle.disabled = false;
    })();
  };
}
