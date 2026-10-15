// Regenerates src/design/tokens.css from src/design/tokens.json (the welldun design system).
// Run after copying a new tokens.json: node scripts/tokens-to-css.mjs
import { readFileSync, writeFileSync } from "node:fs";

const t = JSON.parse(readFileSync("src/design/tokens.json", "utf8"));
const [first, ...rest] = t.color.themes.map((th) => th.id);
const pick = (v, th) => (typeof v === "string" ? v : v[th] ?? v[first]);
const ref = (v) => v.replace(/^\{(.+)\}$/, "var(--$1)");
const themed = (th) => [
  ...t.color.tokens.map((x) => `  --${x.name}: ${ref(pick(x.value, th))};`),
  ...(t.shadow?.tokens ?? []).map((x) => `  --${x.name}: ${pick(x.value, th)};`),
].join("\n");

const out = ["/* welldun — generated from tokens.json by scripts/tokens-to-css.mjs. Do not edit by hand. */"];
for (const f of t.type.fonts) {
  const file = f.file.replace(/^fonts\//, "");
  out.push(`@font-face { font-family: "${f.family}"; src: url("/fonts/${file}") format("woff2"); font-weight: ${f.weight}; font-style: normal; font-display: swap; }`);
}
// Bare :root is the first (light) theme. Saying color-scheme explicitly matters when the OS
// is dark but the visitor picked light: scrollbars and form controls then follow the page.
out.push(`:root {\n${themed(first)}\n  color-scheme: ${first};\n}`);
for (const th of rest) {
  out.push(`@media (prefers-color-scheme: ${th}) {\n  :root:not([data-theme="${first}"]) {\n${themed(th).replace(/^/gm, "  ")}\n    color-scheme: ${th};\n  }\n}`);
  out.push(`:root[data-theme="${th}"] {\n${themed(th)}\n  color-scheme: ${th};\n}`);
}
// Printing always uses the first (light) theme, whatever the screen shows.
// :not([data-print-never]) only raises specificity to match the dark-scheme rule above, so this later block wins.
out.push(`@media print {\n  :root:not([data-print-never]), :root[data-theme] {\n${themed(first).replace(/^/gm, "  ")}\n    color-scheme: ${first};\n  }\n}`);
const other = ["spacing", "radius", "size"].flatMap((k) => (t[k]?.tokens ?? []).map((x) => `  --${x.name}: ${x.value};`));
const fams = Object.entries(t.type.families).map(([k, v]) => `  --font-${k}: ${v};`);
out.push(`:root {\n${[...other, ...fams].join("\n")}\n}`);
for (const g of t.type.groups) {
  for (const s of g.styles) {
    const ls = s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : "";
    out.push(`.${s.name} { font-family: var(--font-${s.family ?? g.family}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${ls} }`);
  }
}
writeFileSync("src/design/tokens.css", out.join("\n") + "\n");
console.log("wrote src/design/tokens.css");
