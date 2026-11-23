// The toolbar icon for each state, drawn on a canvas: NeuCap's own icon (icons/neucap.svg), greyed
// where NeuCap does nothing on the tab, a badge in the state's colour with the state's Lucide icon,
// and while solving a ring around it filled as far as the attempts have gone.
import { BRAND, PATHS } from "./icons.js";

export const TINTS = { acc: "#1a9be6", ok: "#1fae6e", bad: "#e5484d", warn: "#d99211", off: "#8b929a" };

/** Whether the brand is greyed, the badge's colour and its icon, per state. */
const LOOK = {
  idle: [false, null, null],
  found: [false, "warn", "hand"],
  solving: [false, null, null],
  solved: [false, "ok", "check"],
  failed: [false, "bad", "x"],
  interrupted: [false, "bad", "circle-alert"],
  unsupported: [false, "warn", "circle-help"],
  stopped: [false, "off", "square"],
  off: [true, "off", "ban"],
  paused: [true, "off", "pause"],
  unknown: [true, "off", "circle-help"],
};
const GREY = { "#2A2F3C": "#5d636e", "#FFFFFF": "#c7cbd1", "#FFC53D": "#a3a8b0" };

function brand(ctx, x, y, size, grey) {
  const [vx, vy, vw] = BRAND.view;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / vw, size / vw);
  ctx.translate(-vx, -vy);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const part of BRAND.parts) {
    const path = new Path2D(part.d);
    const tint = c => (grey ? GREY[c.toUpperCase()] ?? c : c);
    if (part.fill) { ctx.fillStyle = tint(part.fill); ctx.fill(path); }
    if (part.stroke) { ctx.strokeStyle = tint(part.stroke); ctx.lineWidth = part.width; ctx.stroke(path); }
  }
  ctx.restore();
}

function stroke(ctx, name, x, y, size, color, width) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = width * 24 / size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const d of PATHS[name]) ctx.stroke(new Path2D(d));
  ctx.restore();
}

/** The icon of `state` at `size` pixels, `progress` (0 to 1) filling the solving ring. */
export function drawIcon(state, size, progress = 0) {
  const [grey, tint, badge] = LOOK[state] ?? LOOK.unknown;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (state === "solving") {
    // The icon shrinks into the ring.
    const inset = size * 0.2;
    brand(ctx, inset, inset, size - 2 * inset, false);
    const r = size / 2 - size * 0.06, w = Math.max(1.5, size * 0.09);
    ctx.lineWidth = w;
    ctx.strokeStyle = "#8b929a55";
    ctx.beginPath(); ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = TINTS.acc;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(size / 2, size / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.08, Math.min(1, progress))); ctx.stroke();
  } else brand(ctx, 0, 0, size, grey);
  if (tint) {
    const r = size * 0.27, cx = size - r, cy = size - r;
    // A ring of clear space keeps the badge apart from the icon under it.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath(); ctx.arc(cx, cy, r + Math.max(1, size / 24), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = TINTS[tint];
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    if (badge && size >= 32) stroke(ctx, badge, cx - r * 0.62, cy - r * 0.62, r * 1.24, "#ffffff", size / 16);
  }
  return ctx.getImageData(0, 0, size, size);
}

/** The three sizes Chrome asks for, as chrome.action.setIcon takes them. */
export const iconSet = (state, progress) => ({ 16: drawIcon(state, 16, progress), 32: drawIcon(state, 32, progress), 48: drawIcon(state, 48, progress) });
