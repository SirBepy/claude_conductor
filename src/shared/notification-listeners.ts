import { showToast } from "../shared/toast";
import { getTransport } from "../shared/transport";
import { showView } from "../shared/navigation";
import { invoke } from "../shared/ipc";
import { updateMissedPanel } from "../missed-panel";
import type { NewsPost, ScheduledItem } from "../types/ipc.generated";

export function setupNewsBadgeAndNotifications(): void {
  const navItem = document.getElementById("sm-news");
  if (!navItem) return;

  const setBadge = (unread: number): void => {
    navItem.classList.toggle("has-unread", unread > 0);
  };

  // Initial unread snapshot. The 6h backend poll updates from there.
  void (async () => {
    try {
      const posts = await invoke<NewsPost[]>("list_news");
      setBadge((posts || []).filter((p) => p.unread).length);
    } catch (err) {
      console.warn("[news] initial list_news failed", err);
    }
  })();

  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  void ev.listen<{ unreadCount?: number }>("news-updated", (e) => {
    setBadge(e.payload?.unreadCount ?? 0);
  });

  void ev.listen<{ title?: string; body?: string }>("news-notification", async (e) => {
    const title = e.payload?.title || "Anthropic news";
    const body = e.payload?.body || "";
    try {
      if (typeof Notification !== "undefined") {
        if (Notification.permission === "default") {
          await Notification.requestPermission();
        }
        if (Notification.permission === "granted") {
          const n = new Notification(title, { body });
          n.onclick = () => { void showView("news"); window.focus(); };
          return;
        }
      }
    } catch (err) {
      console.warn("[news] OS notification failed", err);
    }
    // Fallback: lightweight in-app toast.
    showToast(`${title}: ${body}`.trim(), { onClick: () => { void showView("news"); } });
  });
}

// Scheduled items (messages / new chats) that missed their fire time (past the
// grace window - see `daemon::schedule::compute_missed`). Global, not gated on
// the schedule view being open. Surfaced as a non-blocking, dismissible panel
// (see missed-panel.ts) with PERMANENT per-item dismissal, plus a one-shot OS
// notification per newly-missed item when the window is hidden (reusing the raw
// `Notification` API from the news path - no new plugin). `notifiedMissedIds`
// is in-memory (don't re-notify the same miss twice this session); the panel's
// own dismissal set is the durable localStorage one.
const notifiedMissedIds = new Set<string>();

function missedEntryName(i: ScheduledItem): string {
  if (i.kind.type === "new_chat") {
    const base = i.kind.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || i.kind.cwd;
    return `New chat: ${base}`;
  }
  const p = (i.prompt || "").trim().replace(/\s+/g, " ");
  return p.length > 60 ? `${p.slice(0, 60)}…` : p || "Scheduled message";
}

function missedEntryTime(i: ScheduledItem): string {
  const d = new Date(i.last_fired_at || i.fire_at);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function setupScheduleMissedPopup(): void {
  void getTransport().listen("scheduled-items-changed", async () => {
    let items: ScheduledItem[];
    try {
      items = (await invoke<ScheduledItem[]>("schedule_list")) || [];
    } catch (err) {
      console.warn("[schedule] schedule_list failed", err);
      return;
    }
    const missed = items
      .filter((i) => i.status.type === "missed")
      .sort((a, b) => new Date(b.last_fired_at || b.fire_at).getTime() - new Date(a.last_fired_at || a.fire_at).getTime());
    updateMissedPanel(
      missed.map((i) => ({ id: i.id, name: missedEntryName(i), time: missedEntryTime(i), kind: i.kind.type })),
      () => showView("schedule"),
    );

    // One OS notification per newly-missed item, only while the window's hidden.
    const fresh = missed.filter((i) => !notifiedMissedIds.has(i.id));
    for (const m of fresh) notifiedMissedIds.add(m.id);
    if (fresh.length > 0 && document.hidden) {
      const text = `${fresh.length} scheduled item${fresh.length === 1 ? "" : "s"} missed their fire time.`;
      try {
        if (typeof Notification !== "undefined") {
          if (Notification.permission === "default") await Notification.requestPermission();
          if (Notification.permission === "granted") {
            const n = new Notification("Claude Conductor", { body: text });
            n.onclick = () => { window.focus(); void showView("schedule"); };
          }
        }
      } catch (err) {
        console.warn("[schedule] OS notification failed", err);
      }
    }
  });
}

// A scheduled item just fired (daemon -> `scheduled-item-fired`). Pop a
// clickable toast so a scheduled chat/message doesn't spring to life silently
// (Joe's report: a scheduled new-chat "suddenly appeared" mid-response with no
// heads-up). Registered globally in both the main and Chats windows; clicking
// opens the chat via `open_chats_for_session` (which builds/focuses the Chats
// window and resumes a closed session). One event per fire, so no de-dup set.
interface ScheduledFirePayload { id: string; kind: string; session_id: string; prompt: string }

export function setupScheduledFireToast(): void {
  void getTransport().listen<ScheduledFirePayload>("scheduled-item-fired", (p) => {
    if (!p?.session_id) return;
    const isNewChat = p.kind === "new_chat";
    const title = isNewChat ? "Scheduled chat started" : "Scheduled message sent";
    const detail = (p.prompt || "").trim().replace(/\s+/g, " ").slice(0, 60);

    showToast(detail ? `${title}: ${detail}` : title, {
      ttlMs: 6000,
      onClick: () => {
        void invoke("open_chats_for_session", { sessionId: p.session_id, mode: "live" })
          .catch((err) => console.error("[schedule] open_chats_for_session failed", err));
      },
    });
  });
}
