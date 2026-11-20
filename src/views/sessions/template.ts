import { html } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { isRemote } from "../../shared/transport";

export function template() {
  return html`
    <div class="view view-sessions">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Chats</h2>
        <span class="when-done-hchip" id="when-done-chip-host" hidden></span>
        <span class="usage-dial-row" id="usage-dial-host" hidden></span>
        ${isRemote() ? html`<button
          class="icon-btn more-btn"
          id="viewMoreBtn"
          title="More options"
        >
          <i class="ph ph-dots-three-vertical"></i>
        </button>` : ""}
      </div>
      <!--
        Host for the controls that live inside the phone's "more options"
        overflow menu. They render here (hidden) so their existing handlers in
        sessions.ts still bind by id at mount; toggleViewMoreMenu() relocates
        the live nodes into the menu on open and moves them back on close,
        keeping the bound listeners intact. On the desktop the host stays
        hidden and the nodes are only bound by id.
      -->
      <div id="view-more-host" hidden>
        <button
          class="smore-item"
          id="newSessionBtn"
          title="Loading..."
          disabled
        >
          <i class="ph ph-plus"></i>New chat
        </button>
        <button
          class="smore-item"
          id="previewToggleBtn"
          title="Toggle the HTML preview window"
        >
          <i class="ph ph-monitor-play"></i>Preview
        </button>
      </div>
      <div id="rate-limit-banner-host" class="rate-limit-banner-host" hidden></div>
      <div class="view-body sessions-layout">
        <!--
          The chat heads (docs/chat-heads-design.md): floating over the pane's top-left
          corner, under the header. The list keeps its old id so every li[data-session-id]
          consumer still finds it.
        -->
        <nav class="chat-heads" id="chat-heads" aria-label="Chats">
          <ul id="sessions-list" class="chat-heads-list"></ul>
        </nav>
        <main class="session-pane" id="session-pane">
          <div class="session-empty session-empty--setup"><i class="ph ph-spinner"></i><span>Setting up...</span></div>
        </main>
      </div>
    </div>
  `;
}

/**
 * Detached-window pane shell. Renders ONLY the chat pane (no sidebar, no
 * header). Used when the URL hash starts with `#detached?session=...`.
 */
export function detachedTemplate(sessionId: string) {
  return html`
    <div class="view view-sessions detached">
      <div class="view-body sessions-layout detached-layout">
        <main class="session-pane" id="session-pane" data-session-id=${sessionId}>
          <div class="session-empty">Loading...</div>
        </main>
      </div>
    </div>
  `;
}
