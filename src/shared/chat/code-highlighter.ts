// shiki/bundle/full is loaded lazily via shiki-loader (see its header comment)
// so the highlighting engine isn't in the main bundle at boot; grammars within
// it are themselves lazy dynamic imports, so unused languages cost nothing.
import { loadShiki } from "./shiki-loader";
import { escapeHtml } from "../escape-html";
import { perfPhase } from "../perf";

function extractFenceLang(className: string): string | null {
  const m = className.match(/language-(\S+)/);
  return m ? m[1]! : null;
}

/** Wrap inline `<code>` elements (not inside `<pre>`) in a hover-copyable span. */
export function highlightInlineCode(container: HTMLElement): void {
  const codes = Array.from(
    container.querySelectorAll<HTMLElement>(".msg.assistant code:not(pre > code):not([data-ic])"),
  );
  for (const code of codes) {
    code.dataset.ic = "1";
    const wrap = document.createElement("span");
    wrap.className = "inline-code-wrap";
    code.replaceWith(wrap);
    wrap.appendChild(code);
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = '<i class="ph ph-copy"></i>';
    wrap.appendChild(btn);
  }
}

export async function highlightCodeBlocks(container: HTMLElement): Promise<void> {
  // Two paths produce <pre><code>: (1) renderBlocks emits
  // <pre class="block code" data-lang="X"><code>...</code></pre>, and
  // (2) markdown-it's fence renderer emits <pre><code class="language-X">
  // ...</code></pre> with NO class on the <pre>. The selector must catch
  // both, hence we walk via <code> (which always exists) up to its <pre>.
  // The :not([data-highlighted]) guard means already-shiki'd blocks are
  // skipped on subsequent passes (incremental render preserves them).
  const codes = Array.from(
    container.querySelectorAll<HTMLElement>("pre > code:not([data-highlighted])"),
  );
  if (codes.length === 0) return;
  const donePhase = perfPhase("shiki-highlight", () => `(${codes.length} blocks)`);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code) continue;
    const pre = code.parentElement as HTMLElement | null;
    if (!pre || pre.tagName !== "PRE") continue;
    const lang = pre.dataset.lang || extractFenceLang(code.className) || "text";
    try {
      const { codeToHtml } = await loadShiki();
      const html = await codeToHtml(code.textContent ?? "", {
        lang,
        theme: "github-dark",
      });
      const safeLang = escapeHtml(lang);
      const wrapper = document.createElement("div");
      wrapper.className = "copyable-block";
      wrapper.innerHTML = `<div class="block code shiki-wrap" data-lang="${safeLang}" data-highlighted="true">${html}</div><button class="copy-btn" aria-label="Copy code"><i class="ph ph-copy"></i></button>`;
      pre.replaceWith(wrapper);
    } catch {
      code.dataset.highlighted = "true";
    }
    // Yield a macrotask between blocks so the browser can paint and stay
    // responsive when a transcript carries many or huge fenced blocks.
    // Each codeToHtml await is microtask-fast and won't yield on its own.
    if (i + 1 < codes.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  donePhase();
}
