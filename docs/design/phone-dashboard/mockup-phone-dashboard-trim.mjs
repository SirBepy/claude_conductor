// Scratch: builds a trimmed Phosphor css + woff2 pair (regular + bold) holding only the icons the
// app's chat sources and this board name. Reads the downloaded 2.1.1 package outside the repo.
import fs from "node:fs";
import path from "node:path";

const PKG = "C:/tmp/phosphor-dl/x/package/src";
const OUT = path.resolve(".for_bepy/mockups");
const roots = ["src/views/sessions", "src/shared", ".for_bepy/mockups/mockup-phone-dashboard.ts"];
const names = new Set();
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
  if (!/\.(ts|css|html)$/.test(p)) return;
  for (const m of fs.readFileSync(p, "utf8").matchAll(/\bph-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) names.add(m[1]);
};
for (const r of roots) walk(r);

function trim(weight, family, file) {
  const css = fs.readFileSync(`${PKG}/${weight}/style.css`, "utf8");
  const sel = weight === "bold" ? ".ph-bold" : ".ph";
  const head = css.split(`${sel}.ph-acorn:before`)[0].replace(/src:[\s\S]*?;\n/, `src: url("./${file}") format("woff2");\n`);
  const rules = [];
  for (const n of names) {
    const re = new RegExp(`\\${sel}\\.ph-${n.replace(/[-]/g, "\\-")}:before \\{\\n  content: "([^"]+)";\\n\\}`);
    const m = css.match(re);
    if (m) rules.push(m[0]);
  }
  return { text: head + rules.join("\n") + "\n", count: rules.length };
}
const reg = trim("regular", "Phosphor", "mockup-phone-dashboard-phosphor.woff2");
const bold = trim("bold", "Phosphor-Bold", "mockup-phone-dashboard-phosphor-bold.woff2");
fs.writeFileSync(`${OUT}/mockup-phone-dashboard-phosphor.css`, `/* Phosphor 2.1.1 (MIT), trimmed. */\n${reg.text}${bold.text}`.replace(/\.ph-bold \{\n[\s\S]*?\n\}/, (b) => b));
// Subset each font to the codepoints its rules use (the full fonts are about 150KB each).
import { execFileSync } from "node:child_process";
for (const [text, srcFont, out] of [[reg.text, `${PKG}/regular/Phosphor.woff2`, "mockup-phone-dashboard-phosphor.woff2"], [bold.text, `${PKG}/bold/Phosphor-Bold.woff2`, "mockup-phone-dashboard-phosphor-bold.woff2"]]) {
  const cps = [...text.matchAll(/content: "\\([0-9a-f]+)"/gi)].map((m) => "U+" + m[1]);
  execFileSync("python", ["-m", "fontTools.subset", srcFont, `--unicodes=${cps.join(",")}`, "--flavor=woff2", `--output-file=${OUT}/${out}`, "--layout-features=", "--no-hinting"], { stdio: "inherit" });
}
console.log("regular icons", reg.count, "bold icons", bold.count, "names scanned", names.size);
