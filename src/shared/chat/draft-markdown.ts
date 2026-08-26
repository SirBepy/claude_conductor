// Serializes the draft editor's contenteditable DOM back to markdown (todo 666).
// The store keeps markdown so a later diff against Claude's version is exact.
// Narrow by design: only the marks the toolbar can produce; anything else
// degrades to its text content rather than leaking raw HTML.

const BLOCK_TAGS = new Set(["P", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3"]);

/** Backslash-escapes only the characters that would otherwise become markup. */
function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1");
}

/** Trailing spaces around a mark push the delimiter outside it, since `** x**`
 *  is not emphasis in any renderer. */
function wrapMark(inner: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m || !m[2]) return inner;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

function inlineOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const kids = () => Array.from(el.childNodes).map(inlineOf).join("");
  switch (el.tagName) {
    case "BR": return "\n";
    case "STRONG": case "B": return wrapMark(kids(), "**");
    case "EM": case "I": return wrapMark(kids(), "_");
    case "S": case "STRIKE": case "DEL": return wrapMark(kids(), "~~");
    // Inside code the escapes are wrong, so read the raw text instead.
    case "CODE": return el.textContent ? `\`${el.textContent}\`` : "";
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const text = kids();
      return href ? `[${text}](${href})` : text;
    }
    default: return kids();
  }
}

function blocksOf(node: Node, out: string[], listPrefix: string | null): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = escapeText(node.textContent ?? "");
    if (text.trim()) out.push(text);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;

  if (el.tagName === "PRE") {
    const code = el.textContent ?? "";
    out.push(`\`\`\`\n${code.replace(/\n+$/, "")}\n\`\`\``);
    return;
  }
  if (el.tagName === "UL" || el.tagName === "OL") {
    const ordered = el.tagName === "OL";
    let n = 1;
    for (const li of Array.from(el.children)) {
      if (li.tagName !== "LI") continue;
      blocksOf(li, out, ordered ? `${n++}. ` : "- ");
    }
    return;
  }
  if (el.tagName === "LI") {
    // A nested list inside the item becomes its own indented block, so pull it
    // out before the item's own inline content is read.
    const nested = Array.from(el.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
    const own = Array.from(el.childNodes)
      .filter((c) => !nested.includes(c as Element))
      .map(inlineOf)
      .join("")
      .trim();
    if (own) out.push(`${listPrefix ?? "- "}${own}`);
    for (const list of nested) {
      const inner: string[] = [];
      blocksOf(list, inner, null);
      for (const line of inner) out.push(`  ${line}`);
    }
    return;
  }
  if (el.tagName === "BLOCKQUOTE") {
    const inner: string[] = [];
    for (const child of Array.from(el.childNodes)) blocksOf(child, inner, null);
    for (const line of inner) out.push(`> ${line}`);
    return;
  }
  if (/^H[1-3]$/.test(el.tagName)) {
    out.push(`${"#".repeat(Number(el.tagName[1]))} ${inlineOf(el).trim()}`);
    return;
  }

  const hasBlockChild = Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName));
  if (hasBlockChild) {
    for (const child of Array.from(el.childNodes)) blocksOf(child, out, listPrefix);
    return;
  }
  const text = inlineOf(el).trim();
  if (text) out.push(text);
}

/** The editor DOM as markdown. Blank between blocks, single newline inside a
 *  list so consecutive items stay one list. */
export function htmlToMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  for (const child of Array.from(root.childNodes)) blocksOf(child, blocks, null);
  let out = "";
  blocks.forEach((block, i) => {
    if (i === 0) {
      out = block;
      return;
    }
    const prev = blocks[i - 1]!;
    const bothList = isListLine(prev) && isListLine(block);
    out += bothList ? `\n${block}` : `\n\n${block}`;
  });
  return out.trim();
}

function isListLine(line: string): boolean {
  return /^\s*(-\s|\d+\.\s|>\s*(-\s|\d+\.\s))/.test(line);
}
