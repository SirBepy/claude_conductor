// A card whose look is its own HTML (display kind "html"), written by a chat
// through the dashboard_card tool. HTML in the dashboard's own DOM would run
// with every Tauri command in reach, so it renders in an iframe with
// `sandbox="allow-scripts"` and no `allow-same-origin`: an opaque origin that
// cannot touch the app. A srcdoc frame also inherits the app's CSP, and the
// meta below can only narrow it, so the card has no network at all; its data
// arrives inline as window.CARD_DATA. Not blocked: the frame navigating
// itself, which the app's frame-src limits to loopback. Accepted, since the
// chat writing a template is already trusted to run commands on this PC and
// every card write asks for permission.
import { html, type TemplateResult } from "lit-html";

const CARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const HEIGHT_MSG = "pd-html-card-height";
const MIN_H = 24;
const MAX_H = 900;
// Built from code points: the raw characters are invisible line breaks in source.
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), "g");
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), "g");

const isToken = (name: string): boolean => name.startsWith("--color-") || name.startsWith("--font-");

/** The app's colour and font tokens, so a card matches whichever theme is on.
 *  Names come from the stylesheets as well as the computed style: Chromium
 *  lists custom properties when a computed style is iterated, WebKit (the Mac
 *  build) does not. */
function themeVars(): string {
  const names = new Set<string>();
  const cs = getComputedStyle(document.documentElement);
  for (let i = 0; i < cs.length; i++) if (isToken(cs[i]!)) names.add(cs[i]!);
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        for (let i = 0; i < rule.style.length; i++) if (isToken(rule.style[i]!)) names.add(rule.style[i]!);
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { walk(sheet.cssRules); } catch { /* a cross-origin sheet (fonts) cannot be read */ }
  }
  const out: string[] = [];
  for (const name of names) {
    const value = cs.getPropertyValue(name).trim();
    if (value) out.push(`${name}:${value}`);
  }
  return out.join(";");
}

// JSON inside a <script> ends at the first "</script", and U+2028/9 end a
// line in older JS parsers; escaping "<" and both separators covers each.
function inlineJson(data: unknown): string {
  return JSON.stringify(data ?? null)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}

export function buildCardDoc(template: string, data: unknown, theme: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">`
    + `<style>:root{${theme}}html,body{margin:0;background:transparent;color:var(--color-text);`
    + `font:13px/1.45 'DM Sans',system-ui,sans-serif;overflow:hidden}</style>`
    + `<script>window.CARD_DATA=${inlineJson(data)};</script></head><body>${template}`
    + `<script>(function(){var last=-1;function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);`
    + `if(h!==last){last=h;parent.postMessage({type:"${HEIGHT_MSG}",h:h},"*");}}`
    + `new ResizeObserver(send).observe(document.documentElement);send();})();</script></body></html>`;
}

let listening = false;

// One listener for every card: a frame's message is matched to its iframe by
// `event.source`, never by anything the (untrusted) card puts in the payload.
function listenForHeights(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { type?: unknown; h?: unknown } | null;
    if (!msg || msg.type !== HEIGHT_MSG || typeof msg.h !== "number") return;
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.pd-html-frame")) {
      if (frame.contentWindow === e.source) {
        frame.style.height = `${Math.max(MIN_H, Math.min(MAX_H, Math.ceil(msg.h)))}px`;
        return;
      }
    }
  });
}

export function htmlCardFrame(title: string, template: string, data: unknown): TemplateResult {
  listenForHeights();
  return html`<iframe class="pd-html-frame" sandbox="allow-scripts" title=${title}
    .srcdoc=${buildCardDoc(template, data, themeVars())}></iframe>`;
}
