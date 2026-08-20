import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { registerOverlayBack } from "../../shared/back-button";
import { invoke } from "../../shared/ipc";
import type { NewsPost } from "../../types/ipc.generated";
import { state, setPaint } from "./news-state";
import { openDetail, renderDetail, renderDetailMenu } from "./news-detail";
import "./news.css";

interface SettingsLike { newsNotificationsEnabled?: boolean; [k: string]: unknown; }

async function loadNotifySetting(): Promise<void> {
  try {
    const s = await invoke<SettingsLike>("get_settings");
    state.notifyEnabled = !!s.newsNotificationsEnabled;
  } catch (err) {
    console.warn("[news] get_settings failed", err);
  }
}

async function setNotifyEnabled(v: boolean, root: HTMLElement): Promise<void> {
  state.notifyEnabled = v;
  paint(root);
  try {
    const s = await invoke<SettingsLike>("get_settings");
    s.newsNotificationsEnabled = v;
    await invoke("save_settings", { updated: s });
  } catch (err) {
    console.error("[news] save_settings failed", err);
  }
}

async function fetchPosts(): Promise<void> {
  try {
    state.posts = (await invoke<NewsPost[]>("list_news")) || [];
    state.error = null;
  } catch (err) {
    console.error("[news] list_news failed", err);
    state.error = String(err);
    state.posts = [];
  } finally {
    state.loading = false;
  }
}

async function refresh(root: HTMLElement): Promise<void> {
  state.refreshing = true;
  paint(root);
  try {
    state.posts = (await invoke<NewsPost[]>("refresh_news")) || [];
    state.error = null;
  } catch (err) {
    console.error("[news] refresh_news failed", err);
    state.error = String(err);
  } finally {
    state.refreshing = false;
    paint(root);
  }
}

async function markAllRead(root: HTMLElement): Promise<void> {
  for (const p of state.posts) p.unread = false;
  paint(root);
  try {
    await invoke("mark_all_news_read");
  } catch (err) {
    console.warn("[news] mark_all_news_read failed", err);
  }
}

function template(root: HTMLElement) {
  const unreadCount = state.posts.filter((p) => p.unread).length;
  const selected = state.selectedSlug
    ? state.posts.find((p) => p.slug === state.selectedSlug) ?? null
    : null;
  if (state.selectedSlug && !selected) state.selectedSlug = null;
  return html`
    <div class="view view-news">
      <div class="view-header">
        ${selected
          ? html`<button
              class="icon-btn"
              title="Back"
              @click=${() => { state.selectedSlug = null; state.menuOpen = false; paint(root); }}
            >
              <i class="ph ph-arrow-left"></i>
            </button>`
          : html`<button
              class="icon-btn burger"
              title="Menu"
              data-burger="true"
              @click=${openSidemenu}
            >
              <i class="ph ph-list"></i>
            </button>`}
        <h2>Anthropic news</h2>
        <div class="news-header-actions">
          <button
            class="icon-btn"
            title="More"
            aria-haspopup="true"
            aria-expanded=${state.menuOpen}
            @click=${(e: Event) => { e.stopPropagation(); state.menuOpen = !state.menuOpen; paint(root); }}
          >
            <i class="ph ph-dots-three-vertical"></i>
          </button>
          ${state.menuOpen
            ? (selected ? renderDetailMenu(selected, root) : renderMenu(root, unreadCount))
            : null}
        </div>
      </div>
      <div class="view-body news-body">
        ${selected ? renderDetail(selected, root) : renderBody(root)}
      </div>
    </div>
  `;
}

function renderMenu(root: HTMLElement, unreadCount: number) {
  const close = () => { state.menuOpen = false; paint(root); };
  return html`
    <div class="news-menu" @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="news-menu-item"
        ?disabled=${unreadCount === 0}
        @click=${() => { close(); void markAllRead(root); }}
      >
        <i class="ph ph-checks"></i> Mark all read
      </button>
      <button
        class="news-menu-item"
        ?disabled=${state.refreshing}
        @click=${() => { close(); void refresh(root); }}
      >
        <i class="ph ${state.refreshing ? "ph-spinner news-spin" : "ph-arrow-clockwise"}"></i>
        ${state.refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <label class="news-menu-item news-menu-toggle">
        <span><i class="ph ph-bell"></i> Notify me on new posts</span>
        <label class="switch">
          <input
            type="checkbox"
            .checked=${state.notifyEnabled}
            @change=${(e: Event) => setNotifyEnabled((e.target as HTMLInputElement).checked, root)}
          />
          <span class="slider"></span>
        </label>
      </label>
    </div>
  `;
}

function renderBody(root: HTMLElement) {
  if (state.loading) {
    return html`<div class="news-empty">Loading…</div>`;
  }
  if (state.error && state.posts.length === 0) {
    return html`<div class="news-empty">
      <p>Could not load news.</p>
      <p class="news-error-msg">${state.error}</p>
      <button class="btn-secondary" @click=${() => refresh(root)}>Retry</button>
    </div>`;
  }
  if (state.posts.length === 0) {
    return html`<div class="news-empty">
      <p>No news yet.</p>
      <p>Click refresh to fetch from anthropic.com/news.</p>
      <button class="btn-secondary" @click=${() => refresh(root)}>Refresh</button>
    </div>`;
  }
  return html`<ul class="news-list">
    ${state.posts.map((p) => renderItem(p, root))}
  </ul>`;
}

function renderItem(post: NewsPost, root: HTMLElement) {
  const tldr = post.summary || post.excerpt || null;
  return html`
    <li
      class="news-item ${post.unread ? "news-item-unread" : ""}"
      @click=${() => openDetail(post, root)}
      title=${post.url}
    >
      <div class="news-text">
        <div class="news-meta">
          ${post.unread ? html`<span class="news-unread-dot" aria-label="unread"></span>` : null}
          ${post.category ? html`<span class="news-cat">${post.category}</span>` : null}
          <time class="news-date">${post.dateLabel}</time>
        </div>
        <div class="news-title">${post.title}</div>
        ${tldr ? html`<div class="news-excerpt">${tldr}</div>` : null}
      </div>
      <i class="ph ph-caret-right news-open-icon"></i>
    </li>
  `;
}

function paint(root: HTMLElement): void {
  render(template(root), root);
}

export async function renderNewsView(root: HTMLElement): Promise<() => void> {
  setPaint(paint);
  state.loading = true;
  state.error = null;
  state.menuOpen = false;
  state.selectedSlug = null;
  state.generatingSlugs.clear();
  state.errorBySlug.clear();
  state.streamBySlug.clear();
  state.phaseBySlug.clear();
  paint(root);

  // Registered before the fetch and latching: the harness injects as soon as
  // the view mounts, and a `list_news` resolving after used to clobber it.
  let injectedPosts: NewsPost[] | null = null;
  const onInject = (e: Event) => {
    injectedPosts = ((e as CustomEvent).detail as NewsPost[]) || [];
    state.posts = injectedPosts;
    state.loading = false;
    paint(root);
  };
  if (import.meta.env.DEV) window.addEventListener("e2e-inject-news", onInject);

  // Also before the fetch: the header paints above, so the kebab is clickable
  // while `list_news` is in flight. Registered after the await, the menu could
  // not be dismissed by an outside click for the whole of a slow fetch.
  const onDocClick = () => {
    if (state.menuOpen) { state.menuOpen = false; paint(root); }
  };
  document.addEventListener("click", onDocClick);

  await Promise.all([fetchPosts(), loadNotifySetting()]);
  // fetchPosts assigns state.posts unconditionally, so re-apply the injection.
  if (injectedPosts) state.posts = injectedPosts;
  paint(root);

  // Phone back button: when an article is open, close it back to the list
  // (mirrors the in-header Back button) instead of leaving the news view.
  const disposeBack = registerOverlayBack(() => {
    if (state.selectedSlug) {
      state.selectedSlug = null;
      state.menuOpen = false;
      paint(root);
      return true;
    }
    return false;
  });

  type Unlisten = () => void;
  const unlisteners: Unlisten[] = [];
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    const listenFn = ev.listen.bind(ev);
    const subscribe = <T,>(name: string, handler: (p: T) => void) => {
      const p = listenFn<T>(name, (e) => handler(e.payload));
      unlisteners.push(() => { void p.then((u) => u()); });
    };
    subscribe<{ posts: NewsPost[] }>("news-updated", (payload) => {
      state.posts = payload?.posts || [];
      paint(root);
    });
    subscribe<{ slug: string; phase: string }>("news-summary-phase", (payload) => {
      if (!payload?.slug) return;
      state.phaseBySlug.set(payload.slug, payload.phase);
      paint(root);
    });
    subscribe<{ slug: string; chunk: string }>("news-summary-delta", (payload) => {
      if (!payload?.slug) return;
      const prev = state.streamBySlug.get(payload.slug) ?? "";
      state.streamBySlug.set(payload.slug, prev + (payload.chunk || ""));
      paint(root);
    });
  }

  return () => {
    document.removeEventListener("click", onDocClick);
    disposeBack();
    if (import.meta.env.DEV) window.removeEventListener("e2e-inject-news", onInject);
    for (const u of unlisteners) { try { u(); } catch { /* ignore */ } }
  };
}
