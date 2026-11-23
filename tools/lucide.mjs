// Writes ui/icons.js: the Lucide icons the extension draws (ISC licence, lucide.dev), as SVG markup for
// the popup and options page and as path data for the toolbar icon the worker draws on a canvas,
// and NeuCap's own icon (icons/neucap.svg) as the toolbar icon's base.
//
//   node tools/lucide.mjs <lucide-static's icons folder>
import fs from "node:fs";
import path from "node:path";

const NAMES = ["shield-check", "shield-off", "shield", "shield-question-mark", "history", "settings", "globe", "zap", "hand", "ban",
  "scan-search", "bug", "mouse-pointer-click", "eye", "check", "x", "rotate-ccw", "timer", "loader-circle", "play", "square",
  "scroll-text", "pause", "circle-help", "circle-check", "circle-x", "circle-alert", "cpu", "calendar", "arrow-left",
  "external-link", "search", "sliders-horizontal", "puzzle", "keyboard", "power", "bell", "plus", "trash-2", "download",
  "triangle-alert", "circle-off", "circle-dashed", "circle-stop", "info", "list-x", "memory-stick", "circle-arrow-up", "hard-drive",
  "cloud-upload", "cloud-check", "cloud-off", "clock-arrow-up"];
const dir = process.argv[2];
const svg = {}, paths = {};
const num = (a, k) => Number(a.match(new RegExp(`\\b${k}="([^"]+)"`))?.[1] ?? 0);
for (const name of NAMES) {
  const text = fs.readFileSync(path.join(dir, `${name}.svg`), "utf8");
  const body = text.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/\s+/g, " ").trim();
  svg[name] = body;
  paths[name] = [...body.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)\/?>/g)].map(([, tag, a]) => {
    if (tag === "path") return a.match(/\bd="([^"]+)"/)[1];
    if (tag === "circle" || tag === "ellipse") {
      const cx = num(a, "cx"), cy = num(a, "cy"), rx = num(a, "r") || num(a, "rx"), ry = num(a, "r") || num(a, "ry");
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
    }
    if (tag === "line") return `M${num(a, "x1")} ${num(a, "y1")}L${num(a, "x2")} ${num(a, "y2")}`;
    if (tag === "rect") {
      const x = num(a, "x"), y = num(a, "y"), w = num(a, "width"), h = num(a, "height"), r = Math.min(num(a, "rx"), w / 2, h / 2);
      return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
    }
    const pts = a.match(/\bpoints="([^"]+)"/)[1].trim().split(/[\s,]+/).map(Number);
    let d = `M${pts[0]} ${pts[1]}`;
    for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
    return tag === "polygon" ? d + "z" : d;
  });
}
// NeuCap's own icon (icons/neucap.svg), as drawing steps for the toolbar icon the worker draws.
const brandSvg = fs.readFileSync(path.join(import.meta.dirname, "../icons/neucap.svg"), "utf8");
const view = brandSvg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const brand = { view, parts: [...brandSvg.matchAll(/<(rect|path)\b([^>]*)\/?>/g)].map(([, tag, a]) => {
  const attr = k => a.match(new RegExp(`\\b${k}="([^"]+)"`))?.[1];
  const d = tag === "path" ? attr("d") : (() => {
    const x = num(a, "x"), y = num(a, "y"), w = num(a, "width"), h = num(a, "height"), r = num(a, "rx");
    return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
  })();
  return { d, fill: attr("fill") === "none" ? null : attr("fill") ?? null, stroke: attr("stroke") ?? null, width: Number(attr("stroke-width") ?? 0) };
}) };
const out = `// Lucide icons (https://lucide.dev, ISC licence) and NeuCap's own icon, written by tools/lucide.mjs.
export const SVG = ${JSON.stringify(svg, null, 0)};
export const PATHS = ${JSON.stringify(paths, null, 0)};
export const BRAND = ${JSON.stringify(brand, null, 0)};
`;
fs.writeFileSync(path.join(import.meta.dirname, "../ui/icons.js"), out);
console.log(`${NAMES.length} icons`);
