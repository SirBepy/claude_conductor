// Scratch wrapper around the skill's bundle-board.mjs: same build, plus a vite plugin that stubs
// the shiki "full" bundle (about 9MB of grammars the dashboard never needs; the board draws no
// code highlighting). Without it the board is 13MB, far over the preview endpoint's 2MB cap.
// Usage: node mockup-phone-dashboard-bundle.mjs <src.html> <out.html>
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SKILL = "C:/Users/tecno/.claude/skills/mockup";
let code = fs.readFileSync(`${SKILL}/bundle-board.mjs`, "utf8");
code = code.replace('createRequire(import.meta.url)("./_board-lib.cjs")', `createRequire(import.meta.url)(${JSON.stringify(SKILL + "/_board-lib.cjs")})`);
const stub = `{ name: "stub-shiki", enforce: "pre", resolveId(id) { return id === "shiki/bundle/full" ? "\\0shiki-stub" : null; }, load(id) { return id === "\\0shiki-stub" ? "export const bundledLanguages = {}; export const bundledThemes = {}; export const createHighlighter = async () => { throw new Error('shiki stubbed in this board'); }; export const codeToHtml = async () => { throw new Error('shiki stubbed in this board'); };" : null; } }`;
// CodeMirror and its grammars (about 1.6MB) and the changelog screenshots (about 0.5MB) arrive only
// through the composer's import graph; the board never opens an editor or the what's-new dialog.
const PROXY = "const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() }); export default mk();";
const stubHeavy = `{ name: "stub-heavy", enforce: "pre", resolveId(id) { if (/^@(codemirror|lezer)\\//.test(id)) return "\\0cm-stub"; return null; }, load(id) { if (id === "\\0cm-stub") return { code: ${JSON.stringify(PROXY)}, syntheticNamedExports: true }; if (/src[\\\\/]changelog[\\\\/]img[\\\\/].*\\.png$/.test(id)) return "export default 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';"; return null; } }`;
const stats =`{ name: "pd-stats", generateBundle(_o, b) { if (!process.env.PD_STATS) return; const m = new Map(); for (const c of Object.values(b)) if (c.type === "chunk") for (const [id, mod] of Object.entries(c.modules)) { const k = id.replace(/.*node_modules[\\\\/]/, "nm:").split(/[\\\\/]/).slice(0, id.includes("node_modules") ? 2 : 99).join("/"); m.set(k, (m.get(k) || 0) + mod.renderedLength); } console.log([...m].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => (v / 1024 | 0) + "KB " + k).join("\\n")); } }`;
const trace = `{ name: "pd-trace", buildEnd() { const want = process.env.PD_TRACE; if (!want) return; for (const w of want.split(",")) { const start = [...this.getModuleIds()].find((id) => id.includes(w)); if (!start) { console.log("no module", w); continue; } const seen = new Set([start]); let cur = start; const chain = [cur]; while (true) { const imp = (this.getModuleInfo(cur)?.importers ?? []).find((i) => !seen.has(i)); if (!imp) break; seen.add(imp); chain.push(imp); cur = imp; } console.log(chain.map((c) => c.replace(/.*claude_usage_in_taskbar[\\\\/]/, "")).join("\\n <- ")); } } }`;
if (!code.includes("configFile: false,")) throw new Error("bundle-board.mjs changed shape");
code = code.replace("configFile: false,", `configFile: false,\n  plugins: [${stub}, ${stubHeavy}, ${stats}, ${trace}],`);
const tmp = "C:/tmp/mockup-phone-dashboard-bundle-run.mjs";
fs.writeFileSync(tmp, code);
try {
  await import(pathToFileURL(tmp).href);
} finally {
  // The run file is removed once the build has been imported (it finishes inside the import).
  fs.rmSync(tmp, { force: true });
}
