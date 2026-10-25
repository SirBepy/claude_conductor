// Absolute file paths in assistant messages become quiet chips: click opens the
// file in the editor, right-click offers Open / Copy path / Reveal. The phone
// has no access to the desktop's disk, so there a chip only copies the path.

import { invoke } from "../ipc";
import { isRemote } from "../transport";
import { createMoreMenu } from "../../views/sessions/more-menu-base";

// Windows drive path or a Unix absolute path with at least 3 segments. The
// lookbehinds keep a URL (`https://a/b/c`, `://` and `m/a/b/c`) and a path glued
// to a word from matching; `:` is excluded from the body so the optional
// `:line[:col]` suffix is explicit and a trailing sentence colon is not eaten.
const WIN = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?:` + "`" + String.raw`()\[\]{},;]+`;
const UNIX = String.raw`(?<![\w./:~@-])\/(?:[\w.@+~-]+\/){2,}[\w.@+~-]+`;
const SUFFIX = String.raw`(?::\d+(?::\d+)?)?`;
const PATH_RE = new RegExp(`(?:${WIN}|${UNIX})${SUFFIX}`, "g");

export interface FileRef {
  path: string;
  line: number | null;
  /** Source text as written, including any `:line:col`. */
  text: string;
  index: number;
}

/** Finds paths in plain text; trailing sentence punctuation is not part of one. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    const raw = m[0].replace(/[.\-+~@]+$/, "");
    const suffix = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(raw)!;
    const path = suffix[1]!;
    // A Windows path needs a name after the drive and slash, not just `C:\`.
    if (/^[A-Za-z]:[\\/]*$/.test(path)) continue;
    out.push({ path, line: suffix[2] ? Number(suffix[2]) : null, text: raw, index: m.index });
  }
  return out;
}

function chipFor(ref: FileRef): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "file-ref";
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.dataset.path = ref.path;
  if (ref.line !== null) chip.dataset.line = String(ref.line);
  chip.title = ref.text;
  const icon = document.createElement("i");
  icon.className = "ph ph-file";
  const name = document.createElement("span");
  name.className = "file-ref-name";
  const base = ref.path.split(/[\\/]/).pop() ?? ref.path;
  name.textContent = base + ref.text.slice(ref.path.length);
  chip.append(icon, name);
  return chip;
}

/** Wraps paths in an assistant message's text nodes in chips. Skips fenced
 *  blocks and existing links; inline code spans are linked on purpose, since
 *  that is where Claude usually writes a path. */
export function linkifyFilePaths(root: HTMLElement): void {
  const scope = root.matches(".msg.assistant") ? [root] : Array.from(root.querySelectorAll<HTMLElement>(".msg.assistant"));
  for (const msg of scope) {
    // The owner window's NodeFilter, not the global: jsdom test setups expose
    // document and HTMLElement globally but not NodeFilter.
    const NF = (msg.ownerDocument.defaultView ?? window).NodeFilter;
    const walker = msg.ownerDocument.createTreeWalker(msg, NF.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest("pre, a, button, .file-ref") ? NF.FILTER_REJECT : NF.FILTER_ACCEPT,
    });
    const hits: Array<{ node: Text; refs: FileRef[] }> = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const refs = findFileRefs(n.nodeValue ?? "");
      if (refs.length) hits.push({ node: n as Text, refs });
    }
    for (const { node, refs } of hits) {
      const text = node.nodeValue ?? "";
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const r of refs) {
        frag.append(text.slice(last, r.index), chipFor(r));
        last = r.index + r.text.length;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
}

// ── actions ───────────────────────────────────────────────────────────

// Same normalisation code-mode/context-menu.ts applies before handing a path to the OS.
const winPath = (p: string) => (/^[a-z]:\//i.test(p) ? p.replace(/\//g, "\\") : p);

// open_in_editor takes only a path, so a `:line` suffix is not forwarded.
export function openFileRef(path: string): void {
  void invoke<void>("open_in_editor", { path: winPath(path) }).catch((err) => console.error("[file-ref] open failed", err));
}

function copyPath(path: string): void {
  void navigator.clipboard?.writeText(winPath(path)).catch(() => {});
}

function revealFileRef(path: string): void {
  void invoke<void>("reveal_file_in_explorer", { path: winPath(path) }).catch((err) =>
    console.error("[file-ref] reveal failed", err),
  );
}

const menu = createMoreMenu<[string]>({
  build(m, close, path) {
    const add = (icon: string, label: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "smore-item";
      b.innerHTML = `<i class="ph ${icon}"></i>`;
      b.append(label);
      b.addEventListener("click", () => {
        close();
        run();
      });
      m.appendChild(b);
    };
    if (!isRemote()) add("ph-arrow-square-out", "Open", () => openFileRef(path));
    add("ph-copy", "Copy path", () => copyPath(path));
    if (!isRemote()) add("ph-folder-open", "Reveal in file manager", () => revealFileRef(path));
  },
});

const chipOf = (e: Event) => (e.target as Element | null)?.closest<HTMLElement>(".file-ref") ?? null;

export function handleFileRefClick(e: MouseEvent): void {
  const chip = chipOf(e);
  if (!chip?.dataset.path) return;
  e.preventDefault();
  if (isRemote()) copyPath(chip.dataset.path);
  else openFileRef(chip.dataset.path);
}

export function handleFileRefContextMenu(e: MouseEvent): void {
  const chip = chipOf(e);
  if (!chip?.dataset.path) return;
  e.preventDefault();
  menu.open(chip, chip.dataset.path);
}

export function handleFileRefKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  const chip = chipOf(e);
  if (!chip?.dataset.path) return;
  e.preventDefault();
  if (isRemote()) copyPath(chip.dataset.path);
  else openFileRef(chip.dataset.path);
}
