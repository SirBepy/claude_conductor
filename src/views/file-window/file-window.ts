// The Files window (`session-file`): opens any path on disk for reading or
// editing. Tabs over one file surface, the same editor Code mode
// uses, with no chat, git scope or explorer. Tabs live only as long as the
// window: nothing about them earns surviving a restart.

import { escapeHtml } from "../../shared/escape-html";
import { basename } from "../../shared/path-utils";
import { listen } from "../../shared/events";
import { createFileSurface, type FileSurfaceHandle, type SurfaceFile } from "../../shared/chat/file-surface";
import { invoke } from "../../shared/ipc";
import type { TextFileData } from "../../types/ipc.generated";
import "../sessions/code-mode/code-mode-shell.css";
import "../sessions/code-mode/code-mode-tabs.css";
import "./file-window.css";

interface Tab {
  /** Absolute, forward slashes: the tab's identity. */
  path: string;
  surface: SurfaceFile;
}

const norm = (p: string) => p.replace(/\\/g, "/");

function surfaceFor(path: string): SurfaceFile {
  return {
    path,
    absPath: path,
    fileAtRev: () => invoke<TextFileData>("read_text_file", { path }),
    onDisk: true,
  };
}

export function mountFileWindow(app: HTMLElement, first: { path: string; line: number | null }): void {
  app.innerHTML = `<section class="code-mode file-window" aria-label="Files">`
    + `<div class="cm-tabs"><div class="cm-tabrow" role="tablist"></div><div class="cm-tools"></div></div>`
    + `<div class="fw-surface"></div>`
    + `<div class="cm-empty"><i class="ph ph-file-text"></i><p>No file open.</p></div>`
    + `</section>`;
  const tabrow = app.querySelector<HTMLElement>(".cm-tabrow")!;
  const tools = app.querySelector<HTMLElement>(".cm-tools")!;
  const surfaceHost = app.querySelector<HTMLElement>(".fw-surface")!;
  const empty = app.querySelector<HTMLElement>(".cm-empty")!;
  // Built on the first tab and dropped with the last one: a mounted editor
  // keeps its 1.5 s disk poll running even while its host is hidden.
  let surface: FileSurfaceHandle | null = null;
  const tabs: Tab[] = [];
  let active: string | null = null;

  function render(line: number | null = null): void {
    tabrow.innerHTML = tabs.map((t) => {
      const on = t.path === active;
      const name = escapeHtml(basename(t.path));
      return `<button class="cm-tab${on ? " on" : ""}" role="tab" aria-selected="${on}" data-tab="${escapeHtml(t.path)}" title="${escapeHtml(t.path)}">`
        + `<i class="ph ph-file"></i><span class="cm-tab-name">${name}</span>`
        + `<span class="cm-x" role="button" aria-label="Close ${name}" data-close="${escapeHtml(t.path)}"><i class="ph ph-x"></i></span></button>`;
    }).join("");
    tabrow.querySelector(".cm-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const tab = tabs.find((t) => t.path === active) ?? null;
    surfaceHost.hidden = !tab;
    tools.hidden = !tab;
    empty.hidden = !!tab;
    document.title = tab ? `${basename(tab.path)} - Files` : "Files";
    if (tab) {
      surface ??= createFileSurface(surfaceHost, {
        defaultView: "file",
        toolsHost: tools,
        canEdit: () => true,
        openPath: (p) => open(p, null),
      });
      surface.show(tab.surface, "file", line ?? undefined);
    } else if (surface) {
      surface.destroy();
      surface = null;
    }
  }

  function open(rawPath: string, line: number | null): void {
    const path = norm(rawPath);
    if (!tabs.some((t) => t.path === path)) tabs.push({ path, surface: surfaceFor(path) });
    active = path;
    render(line);
  }

  function close(path: string): void {
    const i = tabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (active === path) active = (tabs[i] ?? tabs[i - 1])?.path ?? null;
    render();
  }

  tabrow.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const x = el.closest<HTMLElement>("[data-close]");
    if (x?.dataset.close) { e.stopPropagation(); close(x.dataset.close); return; }
    const tab = el.closest<HTMLElement>("[data-tab]");
    if (tab?.dataset.tab && tab.dataset.tab !== active) { active = tab.dataset.tab; render(); }
  });
  tabrow.addEventListener("auxclick", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (e.button === 1 && tab?.dataset.tab) { e.preventDefault(); close(tab.dataset.tab); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && active) {
      e.preventDefault();
      close(active);
      return;
    }
    surface?.handleKey(e);
  }, true);

  // The host queues any open that arrives before this listener exists and only
  // flushes it once told the listener is up, so signal after `listen` resolves.
  void listen<{ path: string; line: number | null }>("file-window-open", ({ path, line }) => open(path, line))
    .then(() => invoke("file_window_ready"))
    .catch(() => {});
  open(first.path, first.line);
}
