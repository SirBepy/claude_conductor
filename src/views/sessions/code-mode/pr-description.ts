// The pinned Description tab Code mode opens for a PR card: the PR body the
// card pre-rendered into its `<template class="pr-modal-tpl">`, with local
// screenshots inlined and mermaid fences swapped for a placeholder.

import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";

const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
};

function imageMimeFromPath(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? (IMG_MIME[m[1]!] ?? null) : null;
}

function imgPlaceholder(): HTMLDivElement {
  const ph = document.createElement("div");
  ph.className = "pr-img-placeholder";
  ph.innerHTML = '<i class="ph ph-image"></i><span>Screenshot - drag into GitHub after creating the PR</span>';
  return ph;
}

/** A data: URL is the only way a local screenshot renders inside the webview
 *  (CSP, no file://), so local paths are read through the backend and
 *  inlined; there is no mermaid.js here, so diagrams get a placeholder. */
function applyContentEnhancements(content: HTMLElement): void {
  content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("https://") || src.startsWith("http://") || src.startsWith("data:")) {
      img.addEventListener("error", () => img.replaceWith(imgPlaceholder()));
      return;
    }
    const localPath = src.replace(/^file:\/\//, "");
    const mime = imageMimeFromPath(localPath);
    if (!mime) { img.replaceWith(imgPlaceholder()); return; }
    void invoke<string>("read_file_as_base64", { path: localPath })
      .then((b64) => { img.src = `data:${mime};base64,${b64}`; })
      .catch(() => img.replaceWith(imgPlaceholder()));
  });

  content.querySelectorAll<HTMLElement>("code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    if (!pre) return;
    const wrap = document.createElement("div");
    wrap.className = "pr-mermaid-placeholder";
    wrap.innerHTML = `<div class="pr-mermaid-header"><i class="ph ph-flow-arrow"></i><span>Diagram - renders on GitHub</span></div><pre class="pr-mermaid-source">${escapeHtml(code.textContent ?? "")}</pre>`;
    pre.replaceWith(wrap);
  });
}

export function renderPrDescription(host: HTMLElement, tpl: HTMLTemplateElement): void {
  host.innerHTML = "";
  host.appendChild(tpl.content.cloneNode(true));
  applyContentEnhancements(host);
}
